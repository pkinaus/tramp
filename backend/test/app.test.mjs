// Unit tests with an in-memory fake Stripe. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { handleRequest } from '../src/app.js';
import { allPlans, plans } from '../src/plans.js';

const real = new Stripe('sk_test_fake');
const WHSEC = 'whsec_test_secret';
const env = {
  SITE_URL: 'https://example.test/tramp',
  ALLOWED_ORIGINS: 'https://example.test',
  STRIPE_WEBHOOK_SECRET: WHSEC,
};
const tag = { tff: plans.metadataTag };

function fakeStripe({ subs = [], sessions = [] } = {}) {
  const calls = { create: [], customersUpdate: [], portal: [] };
  const page = (data) => Promise.resolve({ data, has_more: false });
  return {
    calls,
    subscriptions: { list: ({ status }) => page(subs.filter((s) => s.status === status)) },
    checkout: {
      sessions: {
        list: ({ status }) => page(sessions.filter((s) => s.status === status)),
        create: async (params, opts) => {
          calls.create.push({ params, opts });
          return { id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new' };
        },
        retrieve: async (id) => sessions.find((s) => s.id === id) || Promise.reject(new Error('No such session')),
      },
    },
    prices: {
      list: async ({ lookup_keys }) => ({ data: [{ id: `price_${lookup_keys[0]}` }], has_more: false }),
    },
    customers: { update: async (id, p) => calls.customersUpdate.push({ id, p }) },
    billingPortal: {
      sessions: {
        create: async (p) => {
          calls.portal.push(p);
          return { url: 'https://billing.stripe.com/p/session/test_123' };
        },
      },
    },
    webhooks: real.webhooks,
  };
}

const activeSubs = (n, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({ id: `sub_${i}`, status: 'active', metadata: tag, ...extra }));
const req = (method, path, body, headers = {}) =>
  new Request(`https://api.example.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: 'https://example.test', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
const quiet = () => {};

test('plans: small $30, large $50, four lookup keys, cap 10', () => {
  assert.deepEqual(plans.sizes.map((s) => s.amount), [3000, 5000]);
  assert.deepEqual(allPlans().map((p) => `${p.lookupKey}:${p.amount}/${p.interval}`), [
    'tff_small_weekly:3000/week',
    'tff_small_monthly:3000/month',
    'tff_large_weekly:5000/week',
    'tff_large_monthly:5000/month',
  ]);
  assert.equal(plans.maxSubscribers, 10);
});

test('status counts tagged active/trialing/past_due/paused subs plus open checkouts', async () => {
  const stripe = fakeStripe({
    subs: [
      ...activeSubs(3),
      { id: 'sub_p', status: 'active', metadata: tag, pause_collection: { behavior: 'void' } },
      { id: 'sub_t', status: 'trialing', metadata: tag },
      { id: 'sub_x', status: 'canceled', metadata: tag },
      { id: 'sub_other', status: 'active', metadata: {} },
    ],
    sessions: [
      { id: 'cs_1', status: 'open', metadata: tag },
      { id: 'cs_2', status: 'open', metadata: {} },
    ],
  });
  const res = await handleRequest(req('GET', '/api/status'), { stripe, env, log: quiet });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { cap: 10, taken: 5, held: 1, remaining: 4, full: false });
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://example.test');
});

test('MAX_SUBSCRIBERS env overrides the cap', async () => {
  const res = await handleRequest(req('GET', '/api/status'), {
    stripe: fakeStripe({ subs: activeSubs(2) }),
    env: { ...env, MAX_SUBSCRIBERS: '2' },
    log: quiet,
  });
  assert.equal((await res.json()).full, true);
});

test('checkout creates a subscription session with metadata, phone, name, idempotency key', async () => {
  const stripe = fakeStripe({ subs: activeSubs(9) });
  const res = await handleRequest(
    req('POST', '/api/checkout', { size: 'large', frequency: 'monthly', pickupDay: 'saturday', attemptId: 'abc12345-xyz' }),
    { stripe, env, log: quiet, now: () => 1_800_000_000_000 },
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, 'https://checkout.stripe.com/c/pay/cs_test_new');
  const { params, opts } = stripe.calls.create[0];
  assert.equal(params.mode, 'subscription');
  assert.deepEqual(params.line_items, [{ price: 'price_tff_large_monthly', quantity: 1 }]);
  assert.equal(params.payment_method_types, undefined);
  assert.deepEqual(params.phone_number_collection, { enabled: true });
  assert.equal(params.custom_fields[0].key, 'full_name');
  assert.deepEqual(params.metadata, { tff: 'flower_subscription', size: 'large', frequency: 'monthly', pickup_day: 'saturday' });
  assert.deepEqual(params.subscription_data.metadata, params.metadata);
  assert.equal(params.success_url, 'https://example.test/tramp/success.html?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(params.cancel_url, 'https://example.test/tramp/cancel.html');
  assert.equal(params.expires_at, 1_800_000_000 + 1800);
  assert.equal(opts.idempotencyKey, 'tff-checkout-abc12345-xyz');
});

test('checkout is refused server-side when the cap is reached (open checkouts count)', async () => {
  const stripe = fakeStripe({ subs: activeSubs(9), sessions: [{ id: 'cs_a', status: 'open', metadata: tag }] });
  const res = await handleRequest(
    req('POST', '/api/checkout', { size: 'small', frequency: 'weekly', pickupDay: 'friday', attemptId: 'abc12345' }),
    { stripe, env, log: quiet },
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).full, true);
  assert.equal(stripe.calls.create.length, 0);
});

test('checkout rejects unknown plans or pickup days', async () => {
  for (const body of [
    { size: 'huge', frequency: 'weekly', pickupDay: 'friday', attemptId: 'abc12345' },
    { size: 'small', frequency: 'daily', pickupDay: 'friday', attemptId: 'abc12345' },
    { size: 'small', frequency: 'weekly', pickupDay: 'sunday', attemptId: 'abc12345' },
    { size: 'small', frequency: 'weekly', pickupDay: 'friday' },
  ]) {
    const res = await handleRequest(req('POST', '/api/checkout', body), { stripe: fakeStripe(), env, log: quiet });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('portal needs a checkout session id, never just an email', async () => {
  const stripe = fakeStripe({ sessions: [{ id: 'cs_test_abc', status: 'complete', metadata: tag, customer: 'cus_1' }] });
  let res = await handleRequest(req('POST', '/api/portal', { email: 'someone@example.com' }), { stripe, env, log: quiet });
  assert.equal(res.status, 400);
  res = await handleRequest(req('POST', '/api/portal', { sessionId: 'cs_test_abc' }), { stripe, env: { ...env, PORTAL_CONFIGURATION_ID: 'bpc_1' }, log: quiet });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, 'https://billing.stripe.com/p/session/test_123');
  assert.deepEqual(stripe.calls.portal[0], { customer: 'cus_1', return_url: 'https://example.test/tramp/', configuration: 'bpc_1' });
});

function signed(event) {
  const payload = JSON.stringify(event);
  const header = real.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
  return req('POST', '/api/webhook', payload, { 'stripe-signature': header });
}

test('webhook rejects a bad signature', async () => {
  const res = await handleRequest(
    req('POST', '/api/webhook', '{"id":"evt_1"}', { 'stripe-signature': 't=1,v1=deadbeef' }),
    { stripe: fakeStripe(), env, log: quiet, cryptoProvider: Stripe.createSubtleCryptoProvider() },
  );
  assert.equal(res.status, 400);
});

test('webhook handles checkout.session.completed: names the customer, logs, flags over-cap', async () => {
  const stripe = fakeStripe({ subs: activeSubs(11) });
  const logs = [];
  const event = {
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        customer: 'cus_9',
        subscription: 'sub_9',
        payment_status: 'paid',
        customer_details: { email: 'a@example.com' },
        custom_fields: [{ key: 'full_name', text: { value: 'Jo Bloggs' } }],
        metadata: { ...tag, size: 'small', frequency: 'weekly', pickup_day: 'friday' },
      },
    },
  };
  const res = await handleRequest(signed(event), {
    stripe,
    env,
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
    log: (level, message, data) => logs.push({ level, message, data }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(stripe.calls.customersUpdate[0], {
    id: 'cus_9',
    p: { name: 'Jo Bloggs', metadata: { tff: 'flower_subscription', pickup_day: 'friday' } },
  });
  assert.ok(logs.some((l) => l.message === 'new flower subscription' && l.data.pickup_day === 'friday'));
  assert.ok(logs.some((l) => l.level === 'warn' && l.message.startsWith('OVER CAP')));
});

test('webhook logs subscription updates (pause) and deletions', async () => {
  const logs = [];
  const deps = { stripe: fakeStripe(), env, cryptoProvider: Stripe.createSubtleCryptoProvider(), log: (l, m, d) => logs.push({ m, d }) };
  await handleRequest(
    signed({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', metadata: tag, pause_collection: { behavior: 'void', resumes_at: null } }, previous_attributes: { pause_collection: null } } }),
    deps,
  );
  await handleRequest(signed({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', metadata: tag, customer: 'cus_1' } } }), deps);
  assert.equal(logs[0].d.paused, true);
  assert.match(logs[1].m, /spot has opened/);
});

test('no Stripe key configured -> 503, health still OK', async () => {
  assert.equal((await handleRequest(req('GET', '/api/status'), { stripe: null, env, log: quiet })).status, 503);
  assert.equal((await handleRequest(req('GET', '/api/health'), { stripe: null, env, log: quiet })).status, 200);
});
