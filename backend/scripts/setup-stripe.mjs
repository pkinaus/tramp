#!/usr/bin/env node
// Creates/updates the Stripe products, prices and customer portal for the flower subscriptions.
// Safe to run again: products have fixed ids, prices are found by lookup_key, the portal
// configuration and webhook endpoint are found by metadata/url and updated in place.
//
//   STRIPE_SECRET_KEY=sk_test_... npm run setup
//   STRIPE_SECRET_KEY=sk_test_... npm run setup -- --site-url https://pkinaus.github.io/tramp --webhook-url https://tff-subscriptions.<you>.workers.dev/api/webhook
//   add --live to run against a live key.
import { stripeFromEnv, arg } from './lib.mjs';
import { plans, allPlans, productId } from '../src/plans.js';

const PORTAL_TAG = 'tff_portal_v1';
const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

const stripe = stripeFromEnv({ allowLive: Boolean(arg('live')) });
const siteUrl = typeof arg('site-url') === 'string' ? arg('site-url').replace(/\/+$/, '') : undefined;
const webhookUrl = typeof arg('webhook-url') === 'string' ? arg('webhook-url') : undefined;

async function ensureProduct(size) {
  const id = productId(size.id);
  const wanted = {
    name: `${size.name} (flower subscription)`,
    description: `Seasonal ${size.name.toLowerCase()} from Trampoline Flower Farm. Farm-gate pickup in Thirroul.`,
    metadata: { tff: plans.metadataTag, size: size.id },
  };
  try {
    await stripe.products.retrieve(id);
    const product = await stripe.products.update(id, { ...wanted, active: true });
    console.log(`product  ${id}  updated`);
    return product;
  } catch (err) {
    if (err.code !== 'resource_missing') throw err;
    const product = await stripe.products.create({ id, ...wanted }, { idempotencyKey: `tff-product-${id}` });
    console.log(`product  ${id}  created`);
    return product;
  }
}

async function ensurePrice(plan) {
  const found = await stripe.prices.list({ lookup_keys: [plan.lookupKey], limit: 1 });
  const current = found.data[0];
  const matches =
    current &&
    current.active &&
    current.unit_amount === plan.amount &&
    current.currency === plan.currency &&
    current.recurring?.interval === plan.interval &&
    (current.recurring?.interval_count ?? 1) === 1 &&
    (typeof current.product === 'string' ? current.product : current.product?.id) === plan.productId;
  if (matches) {
    console.log(`price    ${plan.lookupKey}  ${current.id}  unchanged ($${plan.amount / 100}/${plan.interval})`);
    return current;
  }
  const price = await stripe.prices.create(
    {
      product: plan.productId,
      currency: plan.currency,
      unit_amount: plan.amount,
      recurring: { interval: plan.interval, interval_count: 1 },
      lookup_key: plan.lookupKey,
      transfer_lookup_key: true, // moves the key off an older price if the amount changed
      nickname: `${plan.size.name}, ${plan.frequency.label.toLowerCase()}`,
      metadata: { tff: plans.metadataTag, size: plan.size.id, frequency: plan.frequency.id },
    },
    { idempotencyKey: `tff-price-${plan.lookupKey}-${plan.currency}-${plan.amount}-${plan.interval}` },
  );
  if (current && current.id !== price.id && current.active) {
    await stripe.prices.update(current.id, { active: false });
    console.log(`price    ${plan.lookupKey}  archived old ${current.id} (existing subscribers stay on it until moved)`);
  }
  console.log(`price    ${plan.lookupKey}  ${price.id}  created ($${plan.amount / 100}/${plan.interval})`);
  return price;
}

async function ensurePortal(pricesByProduct) {
  const params = {
    business_profile: { headline: 'Trampoline Flower Farm: manage your flower subscription' },
    default_return_url: siteUrl ? `${siteUrl}/` : undefined,
    features: {
      customer_update: { enabled: true, allowed_updates: ['name', 'email', 'phone'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        cancellation_reason: { enabled: true, options: ['too_expensive', 'unused', 'other'] },
      },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price'],
        proration_behavior: 'none',
        products: Object.entries(pricesByProduct).map(([product, prices]) => ({ product, prices })),
      },
    },
    login_page: { enabled: true },
    metadata: { tff: PORTAL_TAG },
  };
  for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];

  const list = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  const existing = list.data.find((c) => c.metadata?.tff === PORTAL_TAG);
  const config = existing
    ? await stripe.billingPortal.configurations.update(existing.id, params)
    : await stripe.billingPortal.configurations.create(params, { idempotencyKey: `tff-portal-${Date.now()}` });
  console.log(`portal   ${config.id}  ${existing ? 'updated' : 'created'}`);
  return config;
}

async function ensureWebhook() {
  if (!webhookUrl) return null;
  const list = await stripe.webhookEndpoints.list({ limit: 100 });
  const existing = list.data.find((w) => w.url === webhookUrl);
  if (existing) {
    await stripe.webhookEndpoints.update(existing.id, { enabled_events: WEBHOOK_EVENTS, disabled: false });
    console.log(`webhook  ${existing.id}  updated (signing secret is in the dashboard: Developers > Webhooks)`);
    return { endpoint: existing, secret: null };
  }
  const endpoint = await stripe.webhookEndpoints.create({
    url: webhookUrl,
    enabled_events: WEBHOOK_EVENTS,
    description: 'Trampoline Flower Farm subscriptions',
  });
  console.log(`webhook  ${endpoint.id}  created`);
  return { endpoint, secret: endpoint.secret };
}

const pricesByProduct = {};
for (const size of plans.sizes) await ensureProduct(size);
for (const plan of allPlans()) {
  const price = await ensurePrice(plan);
  (pricesByProduct[plan.productId] ||= []).push(price.id);
}
const portal = await ensurePortal(pricesByProduct);
const webhook = await ensureWebhook();

console.log('\nDone. Put these in the backend settings (wrangler secret put / wrangler.toml [vars]):');
console.log(`  PORTAL_CONFIGURATION_ID = ${portal.id}`);
if (webhook?.secret) console.log(`  STRIPE_WEBHOOK_SECRET   = ${webhook.secret}   (shown once; store it now)`);
console.log('\nAnd in site-config.js on the website:');
console.log(`  portalLoginUrl: '${portal.login_page?.url ?? '(enable the login page in Settings > Billing > Customer portal)'}'`);
