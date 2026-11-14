import Stripe from 'stripe';

export function stripeFromEnv({ allowLive = false } = {}) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('Set STRIPE_SECRET_KEY first (a test key sk_test_/rk_test_ while trying things out).');
    process.exit(1);
  }
  if (/_live_/.test(key) && !allowLive) {
    console.error('This is a LIVE key. Re-run with --live if you really mean to change the live account.');
    process.exit(1);
  }
  const opts = { maxNetworkRetries: 2 };
  if (process.env.STRIPE_API_HOST) {
    const u = new URL(process.env.STRIPE_API_HOST);
    Object.assign(opts, { host: u.hostname, port: u.port, protocol: u.protocol.replace(':', '') });
  }
  return new Stripe(key, opts);
}

export function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
