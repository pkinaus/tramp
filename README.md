# Trampoline Flower Farm

Static landing page for [Trampoline Flower Farm](https://www.instagram.com/trampoline.flower.farm/) (Thirroul, NSW).

## Preview locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765

## Notes

- Photo-forward layout matched to the Instagram aesthetic.
- Images under `photos/web/` are mockup captures from public Instagram / Illawarra Flame coverage. Replace with rights-cleared originals before a public launch.

## Flower subscriptions

Subscribers choose a bunch (small $30 or large $50, AUD), a weekly plan (charged and
picked up every week) and a pickup afternoon
(Friday or Saturday) at the farm gate in Thirroul. Payment happens on Stripe's own hosted
checkout page, so no card details ever touch this site. Subscriptions are capped (10 by default).

### How it fits together

| Piece | Where | What it does |
| --- | --- | --- |
| `plans.json` | website | **The one place for prices, the subscriber cap and pickup days.** Amounts are in cents. |
| `site-config.js` | website | Backend URL, portal login link, waitlist email. |
| `index.html` + `subscribe.js` | website | Subscription form, "spots left", waitlist note when full. |
| `success.html`, `cancel.html` | website | Where Stripe sends people after checkout. |
| `backend/` | Cloudflare Worker | Small API: spots left, start checkout, open customer portal, Stripe webhook. |
| `backend/scripts/setup-stripe.mjs` | your computer | Creates the products, 4 prices, customer portal (and optionally the webhook) in Stripe. Safe to re-run. |
| `backend/scripts/pause-season.mjs` | your computer | Pause or resume billing for every flower subscription at once. |

Why Cloudflare Workers: the free plan (100,000 requests a day) is far more than this needs,
there are no cold starts, Stripe's Node library runs on it natively (fetch + Web Crypto for
webhook signatures), secrets are stored encrypted, and the website itself can stay on free
GitHub Pages.

API endpoints (all under the Worker URL):

- `GET /api/status`: `{cap, taken, held, remaining, full}`. "taken" counts subscriptions tagged
  `metadata.tff = flower_subscription` that are active, trialing, past due or paused (a
  subscription with paused billing is still "active" in Stripe and keeps its spot). "held" counts
  open checkout pages (they expire after 30 minutes), so two people can't grab the last spot.
- `POST /api/checkout`: `{size, frequency, pickupDay, attemptId}` → Stripe Checkout URL. Re-checks
  the cap on the server, collects name, email and phone, stores the plan and pickup day as metadata
  on the subscription, and uses an idempotency key so a retried request can't create two sessions.
- `POST /api/portal`: `{sessionId}` (from the success page) → Stripe customer portal URL. There is
  deliberately no "look up by email" (anyone could open someone else's billing). Returning
  subscribers use the portal **login link**, which emails them a one-time code.
- `POST /api/webhook`: verifies the Stripe signature, then handles `checkout.session.completed`
  (sets the customer's name, logs the new subscriber, warns if over the cap),
  `customer.subscription.updated` and `customer.subscription.deleted` (logged). Logs show in
  Cloudflare: Workers & Pages → tff-subscriptions → Logs.

### Going live: checklist for Paul and Angie

Do it all once with a **test** key first (keys start `sk_test_` or `rk_test_`), buy a
subscription with the test card `4242 4242 4242 4242`, then repeat steps 2–6 with the live key.

1. **Get a Stripe key.** In Angie's Stripe dashboard: Developers → API keys. For the Worker, a
   restricted key (`rk_`) is best, with write access to Checkout Sessions, Customers, Customer
   portal and read access to Subscriptions and Prices. The setup script (step 2) needs a key that
   can also write Products, Prices, Customer portal and Webhook endpoints (the standard secret key
   is fine for that one-off run on your own computer). Never put a key in this repo.
2. **Create the plans in Stripe.**
   ```bash
   cd backend && npm install
   STRIPE_SECRET_KEY=sk_test_... npm run setup -- --site-url https://pkinaus.github.io/tramp
   ```
   It prints a `PORTAL_CONFIGURATION_ID` and the portal login link. Add `--live` when using a live key.
3. **Deploy the backend.**
   ```bash
   npx wrangler login                       # free Cloudflare account
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler deploy                      # prints https://tff-subscriptions.<name>.workers.dev
   ```
   In `backend/wrangler.toml` check `SITE_URL` and `ALLOWED_ORIGINS`, and set
   `PORTAL_CONFIGURATION_ID`, then deploy again.
4. **Connect the webhook.** Re-run setup with the Worker URL:
   `STRIPE_SECRET_KEY=... npm run setup -- --site-url https://pkinaus.github.io/tramp --webhook-url https://tff-subscriptions.<name>.workers.dev/api/webhook`.
   It prints a `whsec_...` signing secret once; save it with `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.
   (Or add the endpoint in Stripe: Developers → Webhooks, with the five events listed in the script.)
5. **Point the website at the backend.** In `site-config.js` set `apiBase` to the Worker URL,
   `portalLoginUrl` to the link from step 2, and `waitlistEmail` to Angie's address (if left
   empty, the "full" message points people to Instagram).
6. **Turn on GitHub Pages.** GitHub repo → Settings → Pages → Deploy from a branch → `main`, folder
   `/ (root)`. The site appears at https://pkinaus.github.io/tramp/ (a custom domain can be added there later;
   if so, update `SITE_URL`, `ALLOWED_ORIGINS` and re-run setup with the new `--site-url`).
7. **In Stripe settings:** turn on customer emails for successful payments and failed payments
   (Settings → Customer emails), and check the business name and logo used on the checkout page
   (Settings → Branding).

### Changing prices or the cap

Edit `plans.json` (e.g. `"amount": 5000` for $50) and run `npm run setup` again. It creates the
new prices and moves the plan names over; **existing subscribers stay on their old price** until
moved (Stripe dashboard → the subscription → Update subscription). The cap is `maxSubscribers`
in `plans.json` (or set `MAX_SUBSCRIBERS` on the Worker to change it without touching the site).

### Off-season pause (Angie)

Pausing stops charges but keeps everyone's spot. Nobody is charged while paused.

- **In the Stripe dashboard (one subscriber):** Billing → Subscriptions → open the subscription →
  Actions → **Pause payment collection** → choose "Void invoices" (so nothing is owed for the
  paused weeks) and, if known, a date to resume automatically. To restart: same menu → **Resume
  payment collection**.
- **Everyone at once:** from `backend/`
  ```bash
  STRIPE_SECRET_KEY=... npm run season -- list
  STRIPE_SECRET_KEY=... npm run season -- pause --resume-on 2027-09-01 --yes
  STRIPE_SECRET_KEY=... npm run season -- resume --yes
  ```
  Without `--yes` it only shows what it would do. Add `--live` for the live account.

Consider emailing subscribers when the season pauses and restarts.

### Local testing

```bash
cd backend && npm install && npm test          # unit tests with a fake Stripe
# Against stripe-mock (https://github.com/stripe/stripe-mock), running on :12111:
cp .dev.vars.example .dev.vars                 # set STRIPE_API_HOST=http://localhost:12111, STRIPE_SECRET_KEY=sk_test_123
npm run dev                                    # Worker on http://localhost:8787
cd .. && python3 -m http.server 8765           # site; open http://localhost:8765/?api=http://localhost:8787
```
With a real test key, forward webhooks using the Stripe CLI:
`stripe listen --forward-to localhost:8787/api/webhook`.
