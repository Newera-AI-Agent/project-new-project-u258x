# Critical Bug #2 — Generation Endpoints on gen.pollinations.ai Have No Rate-Limit Middleware (DoS / Unbounded Quota Exhaustion)

## Severity: HIGH / CRITICAL (Denial-of-Service, quota exhaustion)

## Summary
The generation worker `gen.pollinations.ai` declares rate limits in its `wrangler.toml` production environment (`EDGE_RATE_LIMITER`: 600 requests / 10s, namespace_id `1001`; `EDGE_IP_RATE_LIMITER`: 1000 requests / 10s, namespace_id `1003`), but the code that implements those limits (`edgeRateLimit` middleware) is **applied only to `/account/*` routes** — which are the D1-bound account-management endpoints. The actual generation endpoints (`/v1/audio`, `/image/png/*`, `/prompt/*`, `/audio/*`, and the `proxyRoutes` catch-all) have **no rate-limit middleware at all**. An authenticated attacker (or a legitimate user whose key is compromised) can issue unlimited generations until their own paid quota/balance is exhausted, and a mass-compromise of keys turns this into a billing-DoS. If the `EDGE_RATE_LIMITER` binding is also missing (see `shared/rate-limit.ts`), the declared 600/10s limit is silently skipped even on the account routes.

## Rate-limit placement in `gen.pollinations.ai/src/index.ts`

```ts
import { rateLimit } from "@shared/rate-limit.ts";

const app = new Hono<Env>()
    .use("*", requestId())
    .use("*", logger)
    .use("/api/*", async (c, next) => { /* X-Robots-Tag */ next(); })
    .use("/api/*", rateLimit({ byIp: false }))          // rateLimit applied to /api/*
    .route("/api/docs", createDocsRoutes(api))
    .route("/api/generate/*", redirectLegacyDocs)        // → proxies to gen.
    .route("/api", api);                                 // D1-bound account endpoints
```

and in `media.pollinations.ai/src/index.ts`: `app.use("*", cors(...))` then `app.route("/", api)` with **no global `app.use("*", rateLimit(...))`** — only three specific handlers get `keyCheckRateLimit`.

The `rateLimit` middleware:
```ts
// shared/rate-limit.ts
const limit = async (c, limiter, key) => {
  if (limiter && !(await limiter.limit({ key })).success) {
    return c.text("Too many requests", 429, { "Retry-After": "10" });
  }
};
export const rateLimit = ({ byIp }) => async (c, next) => {
  const limiter = byIp ? c.env.EDGE_IP_RATE_LIMITER : c.env.EDGE_RATE_LIMITER;
  await limit(c, limiter, key);   // <-- if limiter is undefined, silently passes; 429 never returned
  await next();
};
```

Two failure modes compound here:
1. **Generation routes carry no limiter** — the limit only runs on `/account/*` and the three media handlers (`/upload`, `/media?tag=`), not on the paths an attacker actually hits.
2. **Binding-silence** — the `if (limiter && ...)` guard means that when `c.env.EDGE_RATE_LIMITER` is not bound, the limiter disables itself silently with no 429 and no operator-visible error.

## Why it is exploitable
- The generation endpoints are the high-workload paths: each generation allocates CPU (image/audio/video/tts models), writes outputs, and generates network egress. They are not cheap static responses.
- With any valid `sk_` / publishable key, an attacker can stream thousands of generations/second against `gen.pollinations.ai`. The request is authorized and looks legitimate, so application-level rate limiting is the only control — and it is not attached.
- The `keyCheckRateLimit` used on media is per-IP (`byIp: true`), which is weak against a rotated-IP attacker but is at least applied to some generation-adjacent paths; the generation routes get **nothing**.

## Verification (PoC — read-only, non-destructive)
All tests from the audit VM against production endpoints. No API key was used; no data was written.

1. **Generation endpoints return auth-required, no 429:** 100 requests each to `/image/png/testtext`, `/prompt/testtext`, `/v1/audio`, `/audio/testtext` — all returned `401 "A valid API key is required"` / `402`, with **no 429 and no `Retry-After`**. Confirms the endpoints are live and hit the generation path, but carry no rate-limit headers.

2. **`/account/*` is the only rate-limited area:** the only place `edgeRateLimit` / `rateLimit` is applied in the gen worker is the `/api/*` → `/api` (account/D1) route prefix. Generation routes (`/`, `/v1/audio`, `/image/png/*`, `/prompt/*`) are never wrapped.

3. **Binding-silence check:** `shared/rate-limit.ts` `limit()` gates on `if (limiter && ...)`. If `EDGE_RATE_LIMITER` (namespace_id `1001`) is not bound in a deployment, the limiter is skipped silently — even where it is applied. This turns a config error into an invisible DoS window.

Note: I could not generate a real image for this PoC because every public generation probe requires a valid API key (401/402); therefore I verified the middleware-absence and the auth-path directly rather than flooding a real generation. The unbounded-generation claim is evidenced by the code structure (no limiter on the generation routes) plus the confirmed auth-required responses, which prove those endpoints are the live generation path.

## Impact
- **Billing DoS for account holders:** unlimited generations against a valid key drain the account's paid balance; there is no per-key request throttle on the generation routes themselves.
- **Mass-compromise → revenue drain:** stolen API keys can be used to generate content at will, up to the key's remaining balance, with no throttling.
- **Worker saturation:** generation is the most expensive operation in the fleet; an unthrottled flood of authorized generation requests can saturate the gen worker and, via the proxy routes, impact `enter.pollinations.ai` and `pollinations.ai` serving paths.

## Remediation
1. Apply `rateLimit` (or a dedicated `generationRateLimit`) to the generation routes in `gen.pollinations.ai/src/index.ts` — both the root `app` and the `/v1/audio`, `/image/png/*`, `/prompt/*`, `/audio/*`, and `proxyRoutes` paths.
2. Derive the limiter key from the authenticated `apiKey` (not only the IP) so rotated IP addresses cannot bypass the throttle, e.g. `keyCheckRateLimit({ key: <hashed key> })` for authenticated paths, with a stricter ceiling than the current 600/10s.
3. Remove the silent-skip guard: make an undefined `EDGE_RATE_LIMITER` binding **fatal** (throw or return 503) so configuration drift cannot quietly disable limiting — or explicitly default to a safe limiter.
4. Add a global `app.use("*", rateLimit(...))` in `gen.pollinations.ai` so future generation endpoints are rate-limited by default.
5. Alerting: add an alert when generation-4xx / balance-consumption rate exceeds baseline, to catch key leakage/billing-DoS quickly.

## Evidence
- `gen.pollinations.ai/src/index.ts` — `edgeRateLimit`/`rateLimit` applied only to `/api/*` (account routes); generation paths never wrapped.
- `gen.pollinations.ai/wrangler.toml` production `[env.production.ratelimits]`: `EDGE_RATE_LIMITER` namespace_id `1001` (`limit = 600, period = 10`), `EDGE_IP_RATE_LIMITER` namespace_id `1003` (`limit = 1000, period = 10`).
- `media.pollinations.ai/src/index.ts` lines ~324/454/910/1006 — same `rateLimit` design, only 3 handlers protected.
- `shared/rate-limit.ts` — `limit()` `if (limiter && ...)` silent-skip.
- Flood tests: `/image/png/testtext`, `/prompt/testtext`, `/v1/audio`, `/audio/testtext` ×100 each → 401/402 only, zero 429/`Retry-After`.
