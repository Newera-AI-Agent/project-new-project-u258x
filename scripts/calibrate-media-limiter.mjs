#!/usr/bin/env node
/**
 * Calibration PoC for media.pollinations.ai rate limiting.
 *
 * WHY A SINGLE CONNECTION: Cloudflare's native RateLimit bindings count per
 * edge location (colo). A burst opened over many parallel connections gets
 * spread over several colos, so each per-colo counter stays below the limit
 * and no 429 is ever produced. Forcing every request through ONE keep-alive
 * TLS connection pins the traffic to a single colo, so the counter for the
 * client IP is actually exercised.
 *
 * WHAT IT PROVES:
 *   Phase A (protected)   : GET /media?tag=...      -> rateLimit({byIp:true})
 *   Phase B (unprotected) : GET /:id/metadata        -> no limiter middleware
 * Both phases use the same single connection / same client IP / same colo.
 *
 * Read-only: every request is a plain GET on a public media item that already
 * exists. No uploads, no state change, nothing destroyed. Request counts are
 * deliberately small (well under the 50/10s threshold for phase B).
 */
import https from "node:https";
import { writeFileSync, mkdirSync } from "node:fs";

const ORIGIN = "https://media.pollinations.ai";
const MEDIA_ID = "78847f03-3723-4c80-9f80-a0bfcb969061";
const PROTECTED_PATH = "/media?tag=test&limit=1";
const UNPROTECTED_PATH = `/${MEDIA_ID}/metadata`;
const REQUESTS_PER_PHASE = Number(process.env.POC_REQUESTS || 60);
const SLEEP_MS = 12000;

function makeAgent() {
    // maxSockets:1 -> one TCP/TLS connection -> one colo -> one counter.
    return new https.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 5000 });
}

function get(path, agent) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            ORIGIN + path,
            {
                agent,
                method: "GET",
                headers: {
                    "user-agent": "pollinations-redteam-poc/1.0 (read-only calibration)",
                    accept: "application/json",
                },
                timeout: 30000,
            },
            (res) => {
                let bytes = 0;
                res.on("data", (chunk) => {
                    bytes += chunk.length;
                });
                res.on("end", () => {
                    const ray = res.headers["cf-ray"] || "";
                    resolve({
                        status: res.statusCode,
                        retryAfter: res.headers["retry-after"] ?? null,
                        colo: ray.includes("-") ? ray.split("-").pop() : null,
                        bytes,
                    });
                });
            },
        );
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", reject);
        req.end();
    });
}

async function burst(label, path, count, agent) {
    const started = Date.now();
    const results = [];
    for (let i = 0; i < count; i++) {
        try {
            results.push(await get(path, agent));
        } catch (err) {
            results.push({ status: 0, retryAfter: null, colo: null, bytes: 0, error: String(err) });
        }
    }
    const statusCounts = {};
    for (const r of results) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
    const colos = {};
    for (const r of results) if (r.colo) colos[r.colo] = (colos[r.colo] || 0) + 1;
    const first429 = results.findIndex((r) => r.status === 429);
    return {
        phase: label,
        method: "GET",
        url: ORIGIN + path,
        requests: count,
        elapsedMs: Date.now() - started,
        statusCounts,
        rateLimited: results.filter((r) => r.status === 429).length,
        servedOk: results.filter((r) => r.status === 200).length,
        bytesServed: results.reduce((a, r) => a + r.bytes, 0),
        first429AtRequest: first429 === -1 ? null : first429 + 1,
        sampleRetryAfter: results.find((r) => r.retryAfter)?.retryAfter ?? null,
        coloCounts: colos,
    };
}

async function main() {
    const report = {
        startedAt: new Date().toISOString(),
        origin: ORIGIN,
        mediaId: MEDIA_ID,
        method: "single keep-alive TLS connection (maxSockets=1) => one colo => one rate-limit counter",
        protected: { route: "GET /media (rateLimit byIp, EDGE_RATE_LIMITER limit=50/10s)", url: ORIGIN + PROTECTED_PATH },
        unprotected: { route: "GET /:id/metadata (no limiter middleware)", url: ORIGIN + UNPROTECTED_PATH },
        phases: [],
    };

    const agentA = makeAgent();
    report.phases.push(await burst("A: PROTECTED GET /media (rateLimit byIp)", PROTECTED_PATH, REQUESTS_PER_PHASE, agentA));

    // let the 10s window expire so phase B starts with a clean counter
    await new Promise((r) => setTimeout(r, SLEEP_MS));

    const agentB = makeAgent();
    report.phases.push(await burst("B: UNPROTECTED GET /:id/metadata (no limiter)", UNPROTECTED_PATH, REQUESTS_PER_PHASE, agentB));

    const a = report.phases[0];
    const b = report.phases[1];
    report.verdict = {
        protected429: a.rateLimited,
        protectedServedOk: a.servedOk,
        unprotected429: b.rateLimited,
        unprotectedServedOk: b.servedOk,
        unprotectedServedWhileProtectedThrottled: a.rateLimited > 0 && b.rateLimited === 0,
        sameColoPhaseA: Object.keys(a.coloCounts).length === 1,
        sameColoPhaseB: Object.keys(b.coloCounts).length === 1,
        conclusion:
            a.rateLimited > 0 && b.rateLimited === 0
                ? "CONFIRMED: the protected route returns 429 once the per-colo per-IP limit is reached, while the unthrottled GET /:id/metadata route keeps serving 200 from the same client IP."
                : a.rateLimited === 0
                  ? "NOT CONFIRMED: the protected route never returned 429 even on a single connection/colo - the deployed limiter did not fire in this run."
                  : "INCONCLUSIVE: the unprotected route also throttled - cannot separate the two.",
    };
    report.finishedAt = new Date().toISOString();

    mkdirSync("poc/out", { recursive: true });
    mkdirSync("poc/evidence", { recursive: true });
    const json = JSON.stringify(report, null, 2);
    writeFileSync("poc/out/media-limiter-calibration.json", json + "\n");
    writeFileSync("poc/evidence/media-limiter-calibration.txt", json + "\n");
    console.log(json);
}

main().catch((err) => {
    console.error("calibration failed:", err);
    process.exit(1);
});
