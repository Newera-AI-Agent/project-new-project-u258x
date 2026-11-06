// Read-only, interleaved A/B PoC for media.pollinations.ai rate-limit coverage.
//
// Claim under test (issue1.md):
//   GET /media is wrapped by keyCheckRateLimit (EDGE_RATE_LIMITER, 50 req / 10 s,
//   keyed per client IP), while GET /:id and GET /:id/metadata are registered
//   WITHOUT any limiter middleware.
//   => from one and the same IP, once the protected route starts answering 429,
//      the unprotected routes keep answering 200/206.
//
// Method: the two routes are hit INTERLEAVED at a constant rate, so both see the
// same source IP, the same request rate and the same 10 s window. A 429 that only
// appears on the protected route is therefore caused by the route's middleware
// wiring, not by load, timing or a different client.
//
// Safety: GET/HEAD only, public data, no API key, no writes, no deletes.
// The burst is deliberately small (default 120 requests per route = 240 total,
// ~10 requests/second for ~12 s) and is stopped as soon as the protected route
// starts throttling. Nothing is "fired" at scale.

const ORIGIN = process.env.POC_ORIGIN || "https://media.pollinations.ai";
const PER_ROUTE = Number(process.env.POC_PER_ROUTE || 120);
const RATE_PER_SEC = Number(process.env.POC_RATE || 10);
const GALLERY_TAG = process.env.POC_TAG || "test";
const DISCOVER = process.env.POC_MEDIA_ID || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        const res = await fetch(url, {
            method,
            redirect: "manual",
            headers: { "cache-control": "no-cache" },
        });
        const buf = method === "HEAD" ? null : await res.arrayBuffer();
        return {
            status: res.status,
            ms: Date.now() - started,
            bytes: buf ? buf.byteLength : 0,
            retryAfter: res.headers.get("retry-after"),
            cacheControl: res.headers.get("cache-control"),
            cfCacheStatus: res.headers.get("cf-cache-status"),
            cfRay: res.headers.get("cf-ray"),
        };
    } catch (err) {
        return { status: 0, ms: Date.now() - started, bytes: 0, error: String(err) };
    }
}

function tally(results) {
    const counts = {};
    let bytes = 0;
    for (const r of results) {
        counts[r.status] = (counts[r.status] || 0) + 1;
        bytes += r.bytes || 0;
    }
    return {
        requests: results.length,
        statusCounts: counts,
        rateLimited: results.filter((r) => r.status === 429).length,
        servedOk: results.filter((r) => r.status >= 200 && r.status < 400).length,
        bytesServed: bytes,
        sampleRetryAfter: results.find((r) => r.retryAfter)?.retryAfter || null,
        sampleCacheControl: results.find((r) => r.cacheControl)?.cacheControl || null,
        sampleCfCacheStatus: results.find((r) => r.cfCacheStatus)?.cfCacheStatus || null,
    };
}

async function main() {
    const startedAt = new Date().toISOString();
    const mediaId = DISCOVER || (await discoverMediaId());
    const protectedUrl = `${ORIGIN}/media?tag=${GALLERY_TAG}&limit=1`;
    const unprotectedUrl = `${ORIGIN}/${mediaId}/metadata`;

    console.log(`media-ab-poc start ${startedAt}`);
    console.log(
        `origin=${ORIGIN} id=${mediaId} per-route=${PER_ROUTE} rate=${RATE_PER_SEC}/s total=${PER_ROUTE * 2}`,
    );
    console.log(
        `protected   : GET ${protectedUrl}   (keyCheckRateLimit -> EDGE_RATE_LIMITER 50/10s)`,
    );
    console.log(`unprotected : GET ${unprotectedUrl} (no limiter middleware)`);
    console.log("sleeping 12s so the discovery request leaves the 10s limiter window");
    await sleep(12000);

    const protectedResults = [];
    const unprotectedResults = [];
    const perBatch = RATE_PER_SEC / 2; // each route gets half of the total rate
    const intervalMs = Math.round(1000 / perBatch);
    const total = Math.max(PER_ROUTE, Math.ceil(PER_ROUTE * 2 * (intervalMs / 1000)));
    let stopped = false;
    const t0 = Date.now();

    for (let i = 0; i < total; i += 1) {
        const [p, u] = await Promise.all([
            hit(protectedUrl),
            hit(unprotectedUrl),
        ]);
        protectedResults.push(p);
        unprotectedResults.push(u);
        if (p.status === 429 && !stopped) {
            stopped = true;
            console.log(
                `protected route started throttling after ${protectedResults.length} requests ` +
                    `(t=${Date.now() - t0}ms); stopping the burst`,
            );
            break;
        }
        const target = i * intervalMs - (Date.now() - t0);
        if (target > 0) await sleep(target);
    }

    const out = {
        startedAt,
        finishedAt: new Date().toISOString(),
        origin: ORIGIN,
        mediaId,
        ratePerSecond: RATE_PER_SEC,
        protected: {
            route: "GET /media?tag=... (keyCheckRateLimit)",
            url: protectedUrl,
            ...tally(protectedResults),
        },
        unprotected: {
            route: "GET /:id/metadata (no limiter middleware)",
            url: unprotectedUrl,
            ...tally(unprotectedResults),
        },
    };

    out.verdict = {
        protected429: out.protected.rateLimited,
        unprotected429: out.unprotected.rateLimited,
        unprotectedServedWhileProtectedThrottled:
            out.protected.rateLimited > 0 && out.unprotected.rateLimited === 0,
        conclusion:
            out.protected.rateLimited > 0 && out.unprotected.rateLimited === 0
                ? "CONFIRMED: from the same IP and the same request rate, the rate-limited route answers 429 while the unrated route keeps answering 200."
                : out.protected.rateLimited === 0
                  ? "NOT CONFIRMED (limiter never fired): the protected route served every request with no 429 either - the declared 50/10s limit was not enforced during this burst."
                  : "NOT CONFIRMED: both routes throttled, so no differential was measured.",
    };

    console.log("\n=== PROTECTED ===");
    console.log(JSON.stringify(out.protected, null, 2));
    console.log("\n=== UNPROTECTED ===");
    console.log(JSON.stringify(out.unprotected, null, 2));
    console.log("\n=== VERDICT ===");
    console.log(JSON.stringify(out.verdict, null, 2));
    console.log("\nfull JSON:\n" + JSON.stringify(out, null, 2));
    return out;
}

main().catch((err) => {
    console.error("poc failed:", err);
    process.exitCode = 1;
});
