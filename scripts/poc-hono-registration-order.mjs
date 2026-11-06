#!/usr/bin/env node
/**
 * PoC (local, deterministic, offline) — Hono middleware registration-order semantics.
 *
 * Finding (see issue2.md): in gen.pollinations.ai the router that owns the edge
 * rate limiter (proxyRoutes, gen.pollinations.ai/src/routes/proxy.ts:433) is
 * mounted LAST on the parent app:
 *
 *     gen.pollinations.ai/src/index.ts:307-315
 *         .route("/", jobRoutes)
 *         .route("/", modelStatusRoutes)     // GET /models/status
 *         .route("/", modelStatsRoutes)      // GET /models/stats
 *         .route("/", createMessagesRoutes(...))
 *         .route("/", proxyRoutes)           // <- owns .use("*", edgeRateLimit)
 *
 * Hono composes the handlers that match a request path in REGISTRATION ORDER.
 * A route handler that returns a Response without calling next() ends the
 * chain, so middleware registered LATER never executes for that path.
 *
 * This script reproduces that exact topology with the same Hono version the
 * worker pins (hono 4.10.6, gen.pollinations.ai/package.json) and asserts the
 * consequence. It makes NO network requests.
 *
 * Usage: node scripts/poc-hono-registration-order.mjs
 */
import { Hono } from "hono";

const honoVersion = JSON.parse(
    await (await import("node:fs/promises")).readFile(
        new URL("../node_modules/hono/package.json", import.meta.url),
        "utf8",
    ),
).version;

let limiterHits = 0;
const limiter = async (c, next) => {
    limiterHits++;
    await next();
};

// Mirrors gen.pollinations.ai/src/routes/proxy.ts:432-433
//   export const proxyRoutes = new Hono<Env>().use("*", edgeRateLimit)
const proxyRoutes = new Hono().use("*", limiter).get("/v1/models", (c) =>
    c.json({ models: [] }),
);

// Mirrors gen.pollinations.ai/src/routes/model-status.ts:60 and
// gen.pollinations.ai/src/routes/model-stats.ts:149 (no limiter of their own)
const modelStatusRoutes = new Hono().get("/models/status", (c) =>
    c.json({ data: [] }),
);
const modelStatsRoutes = new Hono().get("/models/stats", (c) =>
    c.json({ data: [] }),
);

// Mirrors gen.pollinations.ai/src/index.ts:307-315 registration order.
const app = new Hono()
    .route("/", modelStatusRoutes)
    .route("/", modelStatsRoutes)
    .route("/", proxyRoutes);

const res = await app.fetch(new Request("https://gen.pollinations.ai/models/status"));
const statusBody = await res.text();
const hitsAfterEarlyRoute = limiterHits;

const res2 = await app.fetch(new Request("https://gen.pollinations.ai/v1/models"));
const modelsBody = await res2.text();
const hitsAfterLateRoute = limiterHits;

const report = {
    honoVersion,
    expectedHonoVersion: "4.10.6",
    request_1: {
        path: "/models/status",
        status: res.status,
        body: statusBody,
        limiterRuns: hitsAfterEarlyRoute,
    },
    request_2: {
        path: "/v1/models",
        status: res2.status,
        body: modelsBody,
        limiterRunsTotal: hitsAfterLateRoute,
    },
    conclusion:
        hitsAfterEarlyRoute === 0 && hitsAfterLateRoute === 1
            ? "CONFIRMED: the limiter registered on the later-mounted router does NOT run for paths handled by the earlier-mounted routers; it DOES run for paths handled by the later-mounted router."
            : "NOT CONFIRMED: observed middleware behaviour differs from the hypothesis; do not report this finding.",
};

console.log(JSON.stringify(report, null, 2));

if (honoVersion !== "4.10.6") {
    console.error(
        `FAIL: expected hono 4.10.6 (the version gen.pollinations.ai pins), got ${honoVersion}`,
    );
    process.exit(1);
}
if (!(hitsAfterEarlyRoute === 0 && hitsAfterLateRoute === 1)) {
    console.error("FAIL: hypothesis not reproduced — refusing to report.");
    process.exit(1);
}
console.error("PASS: hypothesis reproduced deterministically.");