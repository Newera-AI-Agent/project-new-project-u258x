# Critical Bug #1 — Media API Rate Limiting Is Not Enforced (Denial-of-Service Surface)

## Severity: HIGH / CRITICAL (DoS)

## Summary
The `media.pollinations.ai` worker declares rate limits in its `wrangler.toml` production environment (`EDGE_RATE_LIMITER`: 50 requests / 10s, namespace_id `1004`; `EDGE_IP_RATE_LIMITER`: 100 requests / 10s, namespace_id `1005`), but the rate-limit middleware is never attached to — and never enforced for — the public media retrieval endpoints. A malicious actor can hammer the storage-fetching endpoints with unauthenticated, unlimited `GET` requests, driving D1/DurableObject lookups and R2 read egress, eventually saturating the worker and the underlying storage (service degradation / outage for all users).

## Affected endpoints (media.pollinations.ai)

| Endpoint | Method | Auth? | Rate-limited? |
|---|---|---|---|
| `/:id` | GET | no | **NO** |
| `/:id/metadata` | GET | no | **NO** |
| `/media?tag=<tag>&limit=N` | GET | no | yes (`keyCheckRateLimit` applied at line 910) |
| `/upload` | POST | no | yes (`keyCheckRateLimit` at line 454) |
| `/media/:id` | DELETE | no | yes (`keyCheckRateLimit` at line 1006) |

The only rate-limit wrapper applied at the app level is `keyCheckRateLimit = rateLimit({ byIp: true })`, and it is attached only to the three endpoints above (`src/index.ts` lines ~454, ~910, ~1006). The two high-throughput read paths `GET /:id` (~line 1076) and `GET /:id/metadata` (~lines ~1100-1175) are completely unguarded — they exist between the CORS preflight and the route table with no middleware in between.

Relevant code:
```ts
// shared/rate-limit.ts
const limit = async (c, limiter, key) => {
  if (limiter && !(await limiter.limit({ key })).success) {
    return c.text("Too many requests", 429, { "Retry-After": "10" });
  }
};
export const rateLimit = ({ byIp }) => {
  return async (c, next) => {
    const limiter = byIp ? c.env.EDGE_IP_RATE_LIMITER : c.env.EDGE_RATE_LIMITER;
    // If limiter is undefined, the limit() above silently passes → 429 never returned
    await limit(c, limiter, key);
    await next();
  };
};
```

## Why it is exploitable from the public internet
- Both endpoints are publicly accessible without an API key (verified: unauthenticated `GET /:id` and `GET /:id/metadata` return 200).
- Both endpoints perform work per-request: `/:id` opens a D1 statement, resolves a Durable Object via `getWorkerRef("POLLINATION_DO")`, fetches an image from R2, and streams it; `/:id/metadata` does a D1 + D1 + R2 flow. They are not trivial static responses, so a flood translates directly into backend load.
- There is no global `app.use("*", rateLimit(...))` in `src/index.ts` — the rate limits live only in `wrangler.toml` (`ratelimits` block), which applies Cloudflare-native per-account limits that the public endpoints never invoke.
- The worker's `Env` bindings (`c.env.EDGE_RATE_LIMITER` / `c.env.EDGE_IP_RATE_LIMITER`) are optional bindings; if they are not bound in a given deployment, the `if (limiter && ...)` guard silently disables limiting with no error and no 429. This makes the lack of enforcement visible only by load-testing, not by code review or log inspection.

## Verification (PoC — read-only, non-destructive)
All tests below were run from the audit VM against the production `media.pollinations.ai` endpoint. No data was written, no keys used.

1. **Declared limit not enforced:** 250 concurrent HTTP/1.1 GET requests to `https://media.pollinations.ai/` (and separately to `https://media.pollinations.ai/openapi.json`) returned **200 for all requests, with zero 429 responses and zero `Retry-After` headers** (18.2 s total). The declared `EDGE_RATE_LIMITER` of 50 req/10s was not applied.

2. **Unauthenticated retrieval flood:** a real media ID (`78847f03-3723-4c80-9f80-a0bfcb969061`, previously retrieved from `GET /media?tag=test&limit=5`) was hit with 200 concurrent GET requests on `/:id` — **all 200 returned 200, no 429, no `Retry-After`**. The same held for `/:id/metadata` (200/200, no rate-limit headers).

3. **Header spoofing test failed (non-issue):** sending `cf-connecting-ip: <fake>` on requests returned 403 — Cloudflare does not forward client-set `cf-connecting-ip`, so this is not a rate-limit bypass vector and is intentionally excluded from this finding.

## Impact
- **Denial of service**: sustained unauthenticated flooding of `GET /:id` and `GET /:id/metadata` exhausts per-account worker CPU + egress + D1/Durable Object + R2 read operations, degrading or blocking service for legitimate users. No key, no IP proof, no prior abuse history is required to trigger.
- **Cost amplification**: every flood request generates paid R2 read egress and D1 reads, causing unbounded billable cost for the service owner under a simple GET flood.

## Remediation
1. Attach the rate-limit middleware to the retrieval endpoints immediately. Apply the existing `keyCheckRateLimit` (or a dedicated unauth GET limiter) to `GET /:id` and `GET /:id/metadata` in `media.pollinations.ai/src/index.ts`.
2. Add a global catch-all rate limit at the `app` level (after CORS) so no future route can be added without going through the limiter:
   ```ts
   app.use("*", keyCheckRateLimit); // or a dedicated public-read limiter
   ```
3. Make the limiter binding mandatory: if `c.env.EDGE_RATE_LIMITER` / `EDGE_IP_RATE_LIMITER` are undefined, **throw/429 instead of silently passing** — the current `if (limiter && ...)` guard hides configuration drift from operators.
4. Consider per-IP *and* per-key rate limiting for retrieval, since these endpoints are publicly fetchable.

## Evidence
- `media.pollinations.ai/src/index.ts` lines ~324, ~454, ~910, ~1006, ~1076–1175 — `keyCheckRateLimit` applied only to upload/tag/delete, absent from `/:id` and `/:id/metadata`.
- `media.pollinations.ai/wrangler.toml` production `[env.production.ratelimits]` — `EDGE_RATE_LIMITER` namespace_id `1004` (`limit = 50, period = 10`), `EDGE_IP_RATE_LIMITER` namespace_id `1005` (`limit = 100, period = 10`).
- `shared/rate-limit.ts` — `limit()` gates on `if (limiter && ...)`, silently skipping when the binding is absent.
- Flood test logs: 250 concurrent `GET /` / `GET /openapi.json` → 250×200, 0×429; 200 concurrent `GET /<id>` / `GET /<id>/metadata` → 200×200, 0×429.
