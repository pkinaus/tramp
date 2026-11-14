// Plan helpers. Prices, cap and pickup days live in ../../plans.json (one place).
import plans from '../../plans.json' with { type: 'json' };

export { plans };

export const PRODUCT_ID_PREFIX = 'tff_bunch_';

export function lookupKey(sizeId, frequencyId) {
  return `tff_${sizeId}_${frequencyId}`;
}

export function productId(sizeId) {
  return `${PRODUCT_ID_PREFIX}${sizeId}`;
}

export function findSize(id) {
  return plans.sizes.find((s) => s.id === id) || null;
}

export function findFrequency(id) {
  return plans.frequencies.find((f) => f.id === id) || null;
}

export function findPickupDay(id) {
  return plans.pickupDays.find((d) => d.id === id) || null;
}

/** Every plan combination: 2 sizes x 2 frequencies = 4 prices. */
export function allPlans() {
  const out = [];
  for (const size of plans.sizes) {
    for (const freq of plans.frequencies) {
      out.push({
        size,
        frequency: freq,
        lookupKey: lookupKey(size.id, freq.id),
        productId: productId(size.id),
        amount: size.amount,
        currency: plans.currency,
        interval: freq.interval,
      });
    }
  }
  return out;
}

export function maxSubscribers(env = {}) {
  const fromEnv = Number.parseInt(env.MAX_SUBSCRIBERS ?? '', 10);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : plans.maxSubscribers;
}
