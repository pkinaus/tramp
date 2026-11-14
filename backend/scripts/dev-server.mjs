#!/usr/bin/env node
// Runs the same handler as the Worker on plain Node, for local testing.
//   stripe-mock:  STRIPE_SECRET_KEY=sk_test_123 STRIPE_API_HOST=http://localhost:12111 npm run dev:node
//   real test key: STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... npm run dev:node
import http from 'node:http';
import Stripe from 'stripe';
import { handleRequest } from '../src/app.js';
import { makeStripe } from '../src/index.js';

const env = {
  SITE_URL: 'http://localhost:8765',
  ALLOWED_ORIGINS: 'http://localhost:8765,http://127.0.0.1:8765',
  ...process.env,
};
const stripe = makeStripe(env);
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const port = Number(process.env.PORT || 8787);

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const response = await handleRequest(request, { stripe, env, cryptoProvider });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  })
  .listen(port, () => console.log(`flower subscription API on http://localhost:${port}`));
