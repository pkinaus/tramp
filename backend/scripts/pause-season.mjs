#!/usr/bin/env node
// Off-season pause for ALL flower subscriptions (or resume them). Dry run unless --yes.
//
//   npm run season -- list
//   npm run season -- pause --resume-on 2027-09-01 --yes   # stop charging until that date
//   npm run season -- pause --yes                          # stop charging until resumed by hand
//   npm run season -- resume --yes
//
// Uses pause_collection with behavior "void": no invoices are charged while paused and the
// subscriber keeps their spot. Subscriptions remain "active" in Stripe.
import { stripeFromEnv, arg } from './lib.mjs';
import { plans } from '../src/plans.js';

const action = process.argv[2];
if (!['list', 'pause', 'resume'].includes(action)) {
  console.error('Usage: pause-season.mjs list | pause [--resume-on YYYY-MM-DD] [--yes] | resume [--yes]');
  process.exit(1);
}
const stripe = stripeFromEnv({ allowLive: Boolean(arg('live')) });
const apply = Boolean(arg('yes'));

const subs = [];
for (const status of ['active', 'trialing', 'past_due']) {
  for await (const s of stripe.subscriptions.list({ status, limit: 100, expand: ['data.customer'] })) {
    if (s.metadata?.tff === plans.metadataTag) subs.push(s);
  }
}

let resumesAt;
const resumeOn = arg('resume-on');
if (action === 'pause' && typeof resumeOn === 'string') {
  const d = new Date(`${resumeOn}T06:00:00+10:00`); // morning in Sydney
  if (Number.isNaN(d.getTime()) || d <= new Date()) {
    console.error('--resume-on must be a future date like 2027-09-01');
    process.exit(1);
  }
  resumesAt = Math.floor(d.getTime() / 1000);
}

for (const s of subs) {
  const who = s.customer?.name || s.customer?.email || s.customer?.id || s.customer;
  const paused = s.pause_collection ? `paused${s.pause_collection.resumes_at ? ` until ${new Date(s.pause_collection.resumes_at * 1000).toISOString().slice(0, 10)}` : ''}` : 'billing';
  console.log(`${s.id}  ${who}  ${s.metadata.size}/${s.metadata.frequency}  ${s.metadata.pickup_day}  ${s.status}  ${paused}`);
  if (action === 'list' || !apply) continue;
  if (action === 'pause') {
    await stripe.subscriptions.update(s.id, {
      pause_collection: { behavior: 'void', ...(resumesAt ? { resumes_at: resumesAt } : {}) },
    });
    console.log('   -> paused');
  } else if (s.pause_collection) {
    await stripe.subscriptions.update(s.id, { pause_collection: '' });
    console.log('   -> resumed');
  }
}
console.log(`${subs.length} flower subscription(s).${action !== 'list' && !apply ? ' Dry run: add --yes to apply.' : ''}`);
