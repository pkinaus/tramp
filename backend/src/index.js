// Cloudflare Worker entry point.
import Stripe from 'stripe';
import { handleRequest } from './app.js';

const cryptoProvider = Stripe.createSubtleCryptoProvider();

export function makeStripe(env) {
  if (!env.STRIPE_SECRET_KEY) return null;
  const opts = { httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2 };
  if (env.STRIPE_API_HOST) {
    // Local testing against stripe-mock, e.g. STRIPE_API_HOST=http://localhost:12111
    const u = new URL(env.STRIPE_API_HOST);
    Object.assign(opts, { host: u.hostname, port: u.port, protocol: u.protocol.replace(':', '') });
  }
  return new Stripe(env.STRIPE_SECRET_KEY, opts);
}

export default {
  async fetch(request, env) {
    return handleRequest(request, { stripe: makeStripe(env), env, cryptoProvider });
  },
};
