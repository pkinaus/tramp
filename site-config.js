// Website settings for flower subscriptions. Prices, cap and pickup days live in plans.json.
window.TFF_CONFIG = {
  // URL of the deployed backend (Cloudflare Worker), no trailing slash,
  // e.g. 'https://tff-subscriptions.<your-subdomain>.workers.dev'. Empty = subscriptions show as "opening soon".
  apiBase: '',
  // Stripe customer portal login link (printed by `npm run setup`, or Stripe dashboard >
  // Settings > Billing > Customer portal). Subscribers sign in with an emailed code.
  portalLoginUrl: '',
  // Where waitlist requests go when all spots are taken. Empty = point people to Instagram.
  waitlistEmail: 'ang.thompson62@gmail.com',
  instagramUrl: 'https://www.instagram.com/trampoline.flower.farm/',
};
