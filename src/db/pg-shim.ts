// This runs when any server code imports from @/db
// Patches .get()/.all()/.run() on PG Drizzle query builders
const g = globalThis as any;
if (!g.__pgShimApplied) {
  g.__pgShimApplied = true;
  try {
    // Use require to avoid tree-shaking: a static ESM import of pg-core's
    // internal query-builder classes can be elided by the bundler since we only
    // patch prototypes for side effects. require() forces the module to load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require("drizzle-orm/pg-core");
    for (const name of ["PgSelectBase", "PgInsertBase", "PgUpdateBase", "PgDeleteBase"]) {
      const C = m[name];
      if (!C?.prototype) continue;
      const p = C.prototype;
      if (!p.get) p.get = async function() { const r = await this; return Array.isArray(r) ? r[0] : r; };
      if (!p.all) p.all = async function() { return await this; };
      if (!p.run) p.run = async function() { return await this; };
    }
    console.log("[pg-shim] Patched PG query builders");
  } catch {}
}
