// Read-only A/B PoC for media.pollinations.ai rate-limit coverage.
//
// Claim under test (issue1.md):
//   GET /:id and GET /:id/metadata are registered WITHOUT keyCheckRateLimit,
//   while the sibling GET /media IS protected by it.
//   => after the protected route starts returning 429 for this IP, the
//      unprotected routes keep returning 200/206 from the same IP.
//
// Safety: GET/HEAD only, public data, one shared IP, <=180 requests total,
// no uploads, no deletes, no state mutation. Nothing is fired at scale.

const ORIGIN = "https://media.pollinations.ai";
const REQUESTS_PER_PHASE = 60;
const CONCURRENCY = 10;
const GALLERY_TAG = process.env.POC_TAG || "test";

async function discoverMediaId() {
    const res = await fetch(`${ORIGIN}/media?tag=${GALLERY_TAG}&limit=1`);
    if (!res.ok) throw new Error(`gallery discovery failed: HTTP ${res.status}`);
    const body = await res.json();
    const id = body?.items?.[0]?.id;
    if (!id) throw new Error("gallery discovery returned no media id");
    return id;
}

async function hit(url, method = "GET") {
    const started = Date.now();
    try {
        const res = await fetch(url, { method, redirect: "manual" });
        // Drain so the connection is reusable, but count the bytes.
        const buf = method === "HEAD" ? null : await res.arrayBuffer();
        return {
            status: res.status,
            ms: Date.now() - started,
            bytes: buf ? buf.byteLength : 0,
            retryAfter: res.headers.get("retry-after"),
            cacheControl: res.headers.get("cache-control"),
            cfCacheStatus: res.headers.get("cf-cache-status"),
        };
    } catch (err) {
        return { status: 0, ms: Date.now() - started, bytes: 0, error: String(err) };
    }
}

async function phase(label, url, { count, method }) {
    const results = [];
    const started = Date.now();
    for (let i = 0; i < count; i += CONCURRENCY) {
        const batch = [];
        for (let j = 0; j < CONCURRENCY && i + j < count; j += 1) {
            batch.push(hit(url, method));
        }
        results.push(...(await Promise.all(batch)));
    }
    const elapsed = Date.now() - started;
    const counts = {};
    let bytes = 0;
    for (const r of results) {
        counts[r.status] = (counts[r.status] || 0) + 1;
        bytes += r.bytes || 0;
    }
    const limited = results.filter((r) => r.status === 429).length;
    const summary = {
        phase: label,
        method,
        url,
        requests: count,
        elapsedMs: elapsed,
        statusCounts: counts,
        rateLimited: limited,
        servedOk: results.filter((r) => r.status >= 200 && r.status < 400).length,
        bytesServed: bytes,
        sampleRetryAfter: results.find((r) => r.retryAfter)?.retryAfter || null,
        sampleCacheControl: results.find((r) => r.cacheControl)?.cacheControl || null,
        sampleCfCacheStatus: results.find((r) => r.cfCacheStatus)?.cfCacheStatus || null,
    };
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(summary, null, 2));
    return summary;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    console.log(`media-ab-poc start ${new Date().toISOString()}`);
    console.log(`origin=${ORIGIN} tag=${GALLERY_TAG} per-phase=${REQUESTS_PER_PHASE} concurrency=${CONCURRENCY}`);

    const id = await discoverMediaId();
    console.log(`discovered media id: ${id}`);
    console.log("sleeping 12s so the discovery request leaves the 10s limiter window");
    await sleep(12000);

    const out = {
        startedAt: new Date().toISOString(),
        origin: ORIGIN,
        mediaId: id,
        phases: [],
    };

    // A: PROTECTED control (keyCheckRateLimit -> EDGE_RATE_LIMITER 50/10s per IP)
    out.phases.push(
        await phase("A: PROTECTED GET /media?tag=... (keyCheckRateLimit)", `${ORIGIN}/media?tag=${GALLERY_TAG}&limit=1`, {
            count: REQUESTS_PER_PHASE,
            method: "GET",
        }),
    );

    // B: UNPROTECTED metadata (no limiter at all)
    out.phases.push(
        await phase("B: UNPROTECTED GET /:id/metadata (no limiter)", `${ORIGIN}/${id}/metadata`, {
            count: REQUESTS_PER_PHASE,
            method: "GET",
        }),
    );

    // C: UNPROTECTED object HEAD (no limiter, R2 head() per request)
    out.phases.push(
        await phase("C: UNPROTECTED HEAD /:id (no limiter)", `${ORIGIN}/${id}`, {
            count: REQUESTS_PER_PHASE,
            method: "HEAD",
        }),
    );

    // D: small sample of full-body GETs to quantify egress per request
    out.phases.push(
        await phase("D: UNPROTECTED GET /:id full body (5 requests, no limiter)", `${ORIGIN}/${id}`, {
            count: 5,
            method: "GET",
        }),
    );

    const a = out.phases[0];
    const b = out.phases[1];
    const c = out.phases[2];
    out.verdict = {
        protectedRouteStartedThrottling: a.rateLimited > 0,
        protectedRoute429: a.rateLimited,
        unprotectedMetadata429: b.rateLimited,
        unprotectedHead429: c.rateLimited,
        unprotectedServedWhileProtectedThrottled:
            a.rateLimited > 0 && b.rateLimited === 0 && c.rateLimited === 0,
        conclusion:
            a.rateLimited > 0 && b.rateLimited === 0 && c.rateLimited === 0
                ? "CONFIRMED: same IP is throttled on /media but /:id and /:id/metadata keep serving."
                : "NOT CONFIRMED on this run - see raw phase data before drawing conclusions.",
    };
    console.log("\n=== VERDICT ===");
    console.log(JSON.stringify(out.verdict, null, 2));
    console.log("\nfull JSON:\n" + JSON.stringify(out, null, 2));
    return out;
}

main().catch((err) => {
    console.error("poc failed:", err);
    process.exitCode = 1;
});
