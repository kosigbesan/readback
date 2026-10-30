/* Entry point: wires the real dependencies and listens.
   Everything interesting lives in createApp(), which the tests use directly. */

import { createApp } from "./index.js";
import { jsonFileStore } from "./lib/store.js";
import Stripe from "stripe";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8787);

const stripeKey = process.env.STRIPE_SECRET_KEY || null;
const stripe = stripeKey ? new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" }) : null;

const store = jsonFileStore(process.env.READBACK_DB || path.join(here, "data", "db.json"));

const app = createApp({
  store,
  stripe,
  cfg: {
    publicBase: process.env.PUBLIC_BASE || "https://kosigbesan.github.io/readback",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
    elevenKey: process.env.ELEVENLABS_API_KEY || null,
    elevenBase: process.env.ELEVENLABS_BASE || "https://api.elevenlabs.io",
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean),
    adminToken: process.env.ADMIN_TOKEN || null,
    prices: {
      sprint: process.env.STRIPE_PRICE_SPRINT || null,
      pro: process.env.STRIPE_PRICE_PRO_MONTHLY || null,
      proyearly: process.env.STRIPE_PRICE_PRO_YEARLY || null
    }
  }
});

app.listen(port, () => {
  const on = (v) => (v ? "on" : "off");
  console.log("ReadBack API listening on :" + port);
  console.log("  store      " + store.kind);
  console.log("  stripe     " + on(!!stripe) + (stripe ? " (key present)" : ""));
  console.log("  webhooks   " + on(!!process.env.STRIPE_WEBHOOK_SECRET));
  console.log("  voice      " + on(!!process.env.ELEVENLABS_API_KEY));
  console.log("  admin      " + on(!!process.env.ADMIN_TOKEN));
  if (!stripe) console.log("\n  Set STRIPE_SECRET_KEY to start taking money. See .env.example.");
});
