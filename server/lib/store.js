/* Storage, behind one small interface so it can be swapped.

   The default is a JSON file, which is enough for the first several hundred
   customers and runs anywhere with no database to provision. When it stops
   being enough, implement the same five methods over Postgres or Supabase and
   change one line. Nothing above this file knows which one is in use. */

import fs from "node:fs";
import path from "node:path";

const EMPTY = { licences: {}, usage: {}, events: {} };

export function jsonFileStore(file) {
  const abs = path.resolve(file);
  let db = load();
  let writing = Promise.resolve();

  function load() {
    try {
      const raw = fs.readFileSync(abs, "utf8");
      const parsed = JSON.parse(raw);
      return {
        licences: parsed.licences || {},
        usage: parsed.usage || {},
        events: parsed.events || {}
      };
    } catch (e) {
      return JSON.parse(JSON.stringify(EMPTY));
    }
  }

  // serialise writes so two requests cannot interleave and clobber each other
  function persist() {
    writing = writing.then(() => new Promise((resolve) => {
      const tmp = abs + ".tmp";
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFile(tmp, JSON.stringify(db, null, 2), (err) => {
        if (err) { resolve(); return; }
        fs.rename(tmp, abs, () => resolve());
      });
    }));
    return writing;
  }

  return {
    kind: "json-file",
    async getLicence(id) { return db.licences[id] || null; },
    async putLicence(l) {
      l.updatedAt = Date.now();
      db.licences[l.id] = l;
      await persist();
      return l;
    },
    async getUsage(id, period) {
      const u = db.usage[id];
      return (u && u[period]) || { chars: 0, requests: 0 };
    },
    async addUsage(id, period, chars) {
      db.usage[id] = db.usage[id] || {};
      const u = db.usage[id][period] || { chars: 0, requests: 0 };
      u.chars += chars;
      u.requests += 1;
      db.usage[id][period] = u;
      await persist();
      return u;
    },
    /* Stripe retries webhooks. Remembering event ids makes each one count once. */
    async seenEvent(id) { return !!db.events[id]; },
    async markEvent(id, info) {
      db.events[id] = info || { at: Date.now() };
      await persist();
    },
    async licencesWithPlan(planId) {
      return Object.values(db.licences).filter((l) => l.plan === planId);
    },
    /* for tests and the admin view */
    _raw() { return db; }
  };
}

export function memoryStore() {
  const db = JSON.parse(JSON.stringify(EMPTY));
  return {
    kind: "memory",
    async getLicence(id) { return db.licences[id] || null; },
    async putLicence(l) { l.updatedAt = Date.now(); db.licences[l.id] = l; return l; },
    async getUsage(id, period) {
      const u = db.usage[id];
      return (u && u[period]) || { chars: 0, requests: 0 };
    },
    async addUsage(id, period, chars) {
      db.usage[id] = db.usage[id] || {};
      const u = db.usage[id][period] || { chars: 0, requests: 0 };
      u.chars += chars; u.requests += 1; db.usage[id][period] = u;
      return u;
    },
    async seenEvent(id) { return !!db.events[id]; },
    async markEvent(id, info) { db.events[id] = info || { at: Date.now() }; },
    async licencesWithPlan(planId) { return Object.values(db.licences).filter((l) => l.plan === planId); },
    _raw() { return db; }
  };
}
