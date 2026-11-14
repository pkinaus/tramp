// Trampoline Flower Farm subscription API (runtime-agnostic: Request -> Response).
// Used by the Cloudflare Worker (src/index.js), the local Node dev server and the tests.
import { plans, lookupKey, findSize, findFrequency, findPickupDay, maxSubscribers } from './plans.js';

// Subscription statuses that hold one of the capped spots.
// A subscription paused with pause_collection stays "active", so it keeps its spot.
export const SPOT_HOLDING_STATUSES = ['active', 'trialing', 'past_due', 'paused'];
const CHECKOUT_HOLD_SECONDS = 30 * 60; // Stripe's minimum Checkout expiry; an open session reserves a spot.

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (origin && (allowed.includes('*') || allowed.includes(origin))) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      vary: 'origin',
    };
  }
  return {};
}

/** Manual pagination so it works with the real SDK, stripe-mock and test fakes alike. */
async function listAll(listFn, params) {
  const out = [];
  let startingAfter;
  for (let page = 0; page < 50; page++) {
    const res = await listFn({ ...params, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    out.push(...res.data);
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return out;
}

const isOurs = (obj) => obj?.metadata?.tff === plans.metadataTag;

export async function countSpots(stripe, env) {
  const cap = maxSubscribers(env);
  const subsByStatus = await Promise.all(
    SPOT_HOLDING_STATUSES.map((status) => listAll((p) => stripe.subscriptions.list(p), { status })),
  );
  const seen = new Set();
  for (const sub of subsByStatus.flat()) if (isOurs(sub)) seen.add(sub.id);
  const taken = seen.size;
  const openSessions = await listAll((p) => stripe.checkout.sessions.list(p), { status: 'open' });
  const held = openSessions.filter(isOurs).length;
  const remaining = Math.max(0, cap - taken - held);
  return { cap, taken, held, remaining, full: remaining === 0 };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function siteUrl(env) {
  return String(env.SITE_URL || '').replace(/\/+$/, '');
}

async function handleStatus({ stripe, env }) {
  const spots = await countSpots(stripe, env);
  return json(spots);
}

async function handleCheckout(request, { stripe, env, now }) {
  const body = await readJson(request);
  if (!body) return json({ error: 'Invalid request.' }, 400);
  const size = findSize(body.size);
  const frequency = findFrequency(body.frequency);
  const pickupDay = findPickupDay(body.pickupDay);
  if (!size || !frequency || !pickupDay) {
    return json({ error: 'Please choose a bunch size, how often, and a pickup day.' }, 400);
  }
  const attemptId = String(body.attemptId || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(attemptId)) return json({ error: 'Invalid request.' }, 400);

  // Server-side cap check (the page check is only a courtesy).
  const spots = await countSpots(stripe, env);
  if (spots.full) {
    return json({ error: 'All subscription spots are taken right now.', full: true, ...spots }, 409);
  }

  const key = lookupKey(size.id, frequency.id);
  const prices = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  const price = prices.data[0];
  if (!price) return json({ error: 'This plan is not set up yet. Please try again later.' }, 503);

  const metadata = {
    tff: plans.metadataTag,
    size: size.id,
    frequency: frequency.id,
    pickup_day: pickupDay.id,
  };
  const base = siteUrl(env);
  const params = {
    mode: 'subscription',
    line_items: [{ price: price.id, quantity: 1 }],
    phone_number_collection: { enabled: true },
    custom_fields: [
      {
        key: 'full_name',
        label: { type: 'custom', custom: 'Name for your bunch' },
        type: 'text',
        text: { minimum_length: 2, maximum_length: 80 },
      },
    ],
    metadata,
    subscription_data: {
      metadata,
      description: `${size.name}, ${frequency.label.toLowerCase()}, pickup ${pickupDay.label} at the farm gate`,
    },
    custom_text: {
      submit: { message: `Pickup only: ${pickupDay.label}, ${plans.pickup}.` },
    },
    success_url: `${base}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/cancel.html`,
    expires_at: Math.floor(now() / 1000) + CHECKOUT_HOLD_SECONDS,
  };
  if (env.INTEGRATION_IDENTIFIER) params.integration_identifier = env.INTEGRATION_IDENTIFIER;

  const session = await stripe.checkout.sessions.create(params, {
    idempotencyKey: `tff-checkout-${attemptId}`,
  });
  return json({ url: session.url });
}

async function handlePortal(request, { stripe, env }) {
  // Portal access is tied to a Checkout Session id (only the buyer has it), never to a bare
  // email address, so nobody can open someone else's billing page by typing their email.
  // Returning subscribers use the Stripe-hosted portal login link (email one-time code).
  const body = await readJson(request);
  const sessionId = String(body?.sessionId || '');
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) return json({ error: 'Invalid request.' }, 400);
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (!isOurs(session) || !session.customer) return json({ error: 'Subscription not found.' }, 404);
  const customer = typeof session.customer === 'string' ? session.customer : session.customer.id;
  const portal = await stripe.billingPortal.sessions.create({
    customer,
    return_url: `${siteUrl(env)}/`,
    ...(env.PORTAL_CONFIGURATION_ID ? { configuration: env.PORTAL_CONFIGURATION_ID } : {}),
  });
  return json({ url: portal.url });
}

async function handleWebhook(request, { stripe, env, cryptoProvider, log }) {
  const signature = request.headers.get('stripe-signature');
  if (!signature || !env.STRIPE_WEBHOOK_SECRET) return json({ error: 'Missing signature.' }, 400);
  const payload = await request.text(); // raw body is required for signature verification
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      payload,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      cryptoProvider,
    );
  } catch (err) {
    log('warn', 'webhook signature verification failed', { message: err.message });
    return json({ error: 'Invalid signature.' }, 400);
  }

  // Every handler below is safe to run twice: Stripe may deliver the same event more than once.
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (!isOurs(obj)) break;
      const name = obj.custom_fields?.find((f) => f.key === 'full_name')?.text?.value;
      const customer = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      if (customer) {
        await stripe.customers.update(customer, {
          ...(name ? { name } : {}),
          metadata: { tff: plans.metadataTag, pickup_day: obj.metadata.pickup_day },
        });
      }
      const spots = await countSpots(stripe, env);
      log('info', 'new flower subscription', {
        event: event.id,
        session: obj.id,
        subscription: obj.subscription,
        customer,
        name,
        email: obj.customer_details?.email,
        plan: `${obj.metadata.size}/${obj.metadata.frequency}`,
        pickup_day: obj.metadata.pickup_day,
        payment_status: obj.payment_status,
        spots,
      });
      if (spots.taken > spots.cap) {
        log('warn', 'OVER CAP: more active subscriptions than the cap allows; review in the Stripe dashboard', spots);
      }
      break;
    }
    case 'checkout.session.async_payment_failed':
      if (isOurs(obj)) log('warn', 'checkout payment failed', { session: obj.id, customer: obj.customer });
      break;
    case 'customer.subscription.updated':
      if (isOurs(obj)) {
        log('info', 'subscription updated', {
          subscription: obj.id,
          status: obj.status,
          paused: Boolean(obj.pause_collection),
          resumes_at: obj.pause_collection?.resumes_at ?? null,
          cancel_at_period_end: obj.cancel_at_period_end,
          previous: event.data.previous_attributes ? Object.keys(event.data.previous_attributes) : [],
        });
      }
      break;
    case 'customer.subscription.deleted':
      if (isOurs(obj)) log('info', 'subscription ended; a spot has opened', { subscription: obj.id, customer: obj.customer });
      break;
    default:
      break;
  }
  return json({ received: true });
}

const defaultLog = (level, message, data) => console[level === 'warn' ? 'warn' : 'log'](JSON.stringify({ level, message, ...data }));

/**
 * @param {Request} request
 * @param {{stripe: any, env: Record<string,string>, cryptoProvider?: any, log?: Function, now?: () => number}} deps
 */
export async function handleRequest(request, deps) {
  const ctx = { log: defaultLog, now: () => Date.now(), ...deps };
  const { env } = ctx;
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);
  const withCors = (res) => {
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  };

  if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));

  const route = `${request.method} ${url.pathname.replace(/\/+$/, '')}`;
  if (route === 'GET /api/health') return withCors(json({ ok: true }));
  if (!ctx.stripe) return withCors(json({ error: 'Payments are not configured yet.' }, 503));

  try {
    switch (route) {
      case 'GET /api/status':
        return withCors(await handleStatus(ctx));
      case 'POST /api/checkout':
        return withCors(await handleCheckout(request, ctx));
      case 'POST /api/portal':
        return withCors(await handlePortal(request, ctx));
      case 'POST /api/webhook':
        return await handleWebhook(request, ctx);
      default:
        return withCors(json({ error: 'Not found.' }, 404));
    }
  } catch (err) {
    ctx.log('error', 'request failed', { route, type: err.type, message: err.message });
    return withCors(json({ error: 'Something went wrong. Please try again.' }, 500));
  }
}
