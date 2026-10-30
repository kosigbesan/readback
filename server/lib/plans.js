/* The plan catalogue. One source of truth for what a plan costs and what it
   allows. The client shows these; the server enforces them, and the server is
   the only one that counts. */

export const PLANS = {
  free: {
    id: "free",
    name: "Free",
    priceLabel: "$0",
    mode: "free",
    docs: 1,
    listenMinutesPerDay: 10,
    voiceCharsPerMonth: 0,        // device voices only
    premiumVoice: false
  },
  sprint: {
    id: "sprint",
    name: "Interview Sprint",
    priceLabel: "$19 once",
    mode: "payment",              // one off, does not renew
    durationDays: 30,
    docs: Infinity,
    listenMinutesPerDay: null,    // null means unlimited
    voiceCharsPerMonth: 60000,
    premiumVoice: true
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceLabel: "$7.99 per month",
    mode: "subscription",
    docs: Infinity,
    listenMinutesPerDay: null,
    voiceCharsPerMonth: 150000,
    premiumVoice: true
  },
  proyearly: {
    id: "proyearly",
    name: "Pro, annual",
    priceLabel: "$49 per year",
    mode: "subscription",
    docs: Infinity,
    listenMinutesPerDay: null,
    voiceCharsPerMonth: 150000,
    premiumVoice: true
  }
};

/* Which environment variable holds the Stripe price for each paid plan. */
export const PRICE_ENV = {
  sprint: "STRIPE_PRICE_SPRINT",
  pro: "STRIPE_PRICE_PRO_MONTHLY",
  proyearly: "STRIPE_PRICE_PRO_YEARLY"
};

export const FREE = PLANS.free;

export function planFor(licence, now = Date.now()) {
  if (!licence || !licence.plan) return PLANS.free;
  const p = PLANS[licence.plan];
  if (!p) return PLANS.free;
  // a sprint pass expires on its own; nobody has to cancel it
  if (p.mode === "payment" && licence.expiresAt && now >= licence.expiresAt) return PLANS.free;
  return p;
}

export function isPaid(licence, now = Date.now()) {
  return planFor(licence, now).id !== "free";
}

/* A licence is what the server stores about one device or account. */
export function newLicence(id) {
  return {
    id,
    plan: "free",
    email: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: null,
    cancelAtPeriodEnd: false,
    stripeCustomerId: null,
    stripeSubscriptionId: null
  };
}

export function publicLicence(licence, usage, now = Date.now()) {
  const plan = planFor(licence, now);
  const used = usage ? usage.chars : 0;
  return {
    plan: plan.id,
    planName: plan.name,
    premiumVoice: plan.premiumVoice,
    docs: plan.docs === Infinity ? null : plan.docs,
    listenMinutesPerDay: plan.listenMinutesPerDay,
    voiceCharsPerMonth: plan.voiceCharsPerMonth,
    voiceCharsUsed: used,
    voiceCharsLeft: Math.max(0, plan.voiceCharsPerMonth - used),
    expiresAt: licence && licence.expiresAt ? licence.expiresAt : null,
    cancelAtPeriodEnd: !!(licence && licence.cancelAtPeriodEnd)
  };
}
