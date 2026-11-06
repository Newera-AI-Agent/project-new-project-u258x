#!/usr/bin/env node
/**
 * media.pollinations.ai - rate-limit A/B PoC (read-only)
 *
 * METHOD
 * ------
 * Cloudflare's native RateLimit binding counts per edge location (colo) and
 * per client IP. Two earlier PoC shapes failed to cross the threshold:
 *   - a parallel burst was spread over several colos, so each per-colo counter
n *     stayed below the limit;
 *   - a sequential burst was limited by RTT (~240 ms/request), so only ~40 of
 *     the 60 requests fell inside any 10 second window (limit is 50/10s).
 *
 * This PoC therefore uses ONE HTTP/2 session (single TLS connection => single
 * colo => single counter) and fires many concurrent streams over it. That
 * guarantees more than 50 requests inside the 10 second window without
 * opening new connections to other colos.
 *
 * PHASES
 * ------
 *   A  GET /media?tag=...      -> keyCheckRateLimit = rateLimit({byIp:true})
 *                                  -> EDGE_RATE_LIMITER (50 requests / 10 s / IP / colo)
 *   B  GET /:id/metadata        -> NO limiter middleware on this route
 *
 * Both phases use the same client IP, the same colo and the same request
 * count. Read-only: plain GETs of an already published media item and its
 * metadata. No uploads, no writes, no state change, nothing deleted.
 */
import http2 from "node:http2";
import { writeFileSync, mkdirSync } from "node:fs";

const ORIGIN = "https://media.pollinations.ai";
const MEDIA_ID = "78847f03-3723-4c80-9f80-a0bfcb969061";
const PROTECTED_PATH = "/media?tag=test&limit=1";
const UNPROTECTED_PATH = `/${MEDIA_ID}/metadata`;
const STREAM_COUNT = Number(process.env.POC_STREAMS || 80);
const SETTLE_MS = 12000; // wait out the 10s window before phase B

function once(session, path) {
    return new Promise((resolve) => {
        const req = session.request({
            ":method": "GET",
            ":path": path,
            "user-agent": "pollinations-redteam-poc/1.0 (read-only A/B)",
            accept: "application/json",
        });
        let status = 0;
        let retryAfter = null;
        let bytes = 0;
        let headers = null;
        req.on("response", (h) => {
            status = h[":status"];
            headers = h;
            retryAfter = h["retry-after"] ?? null;
        });
        req.on("data", (c) => {
            bytes += c.length;
        });
        req.on("end", () =>
            resolve({
                status,
                retryAfter,
                bytes,
                ray: headers?.["cf-ray"] ?? null,
                colo: headers?.["cf-ray"]?.split("-").pop() ?? null,
                cacheStatus: headers?.["cf-cache-status"] ?? null,
            }),
        );
        req.on("error", (e) =>
            resolve({ status: 0, retryAfter: null, bytes: 0, error: String(e) }),
        );
        req.end();
    });
}

async function phase(label, path) {
    const session = http2.connect(ORIGIN, {
        settings: { enablePush: false },
    });
    await new Promise((res, rej) => {
        session.once("connect", res);
        session.once("error", rej);
    });
    const started = Date.now();
    const results = await Promise.all(
        Array.from({ length: STREAM_COUNT }, () => once(session, path)),
    );
    session.close();

    const statusCounts = {};
    for (const r of results) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
    const colos = {};
    for (const r of results) if (r.colo) colos[r.colo] = (colos[r.colo] || 0) + 1;
    const first429 = results.findIndex((r) => r.status === 429);
    return {
        phase: label,
        method: "GET",
        url: ORIGIN + path,
        connection: "single HTTP/2 session (1 colo, 1 counter)",
        requests: STREAM_COUNT,
        elapsedMs: Date.now() - started,
        statusCounts,
        servedOk: results.filter((r) => r.status === 200).length,
        rateLimited: results.filter((r) => r.status === 429).length,
        first429AtRequest: first429 === -1 ? null : first429 + 1,
        sampleRetryAfter: results.find((r) => r.retryAfter)?.retryAfter ?? null,
        bytesServed: results.reduce((a, r) => a + r.bytes, 0),
        coloCounts: colos,
    };
}

async function main() {
    const report = {
        startedAt: new Date().toISOString(),
        origin: ORIGIN,
        mediaId: MEDIA_ID,
        note: "read-only; plain GETs; no writes, uploads or deletions",
        phases: [],
    };

    report.phases.push(
        await phase("A: PROTECTED GET /media (keyCheckRateLimit, 50/10s)", PROTECTED_PATH),
    );

    await new Promise((r) => setTimeout(r, SETTLE_MS));

    report.phases.push(
        await phase("B: UNPROTECTED GET /:id/metadata (no limiter)", UNPROTECTED_PATH),
    );

    const a = report.phases[0];
    const b = report.phases[1];
    report.verdict = {
        protected429: a.rateLimited,
        protectedServedOk: a.servedOk,
        unprotected429: b.rateLimited,
        unprotectedServedOk: b.servedOk,
        sameColoPhaseA: Object.keys(a.coloCounts).length === 1,
        sameColoPhaseB: Object.keys(b.coloCounts).length === 1,
        conclusion:
            a.rateLimited > 0 && b.rateLimited === 0
                ? "CONFIRMED: the limited route returned 429 once >50 requests/10s hit one colo from one IP, while the route without limiter middleware kept answering 200 for the same client IP and the same request volume."
                : a.rateLimited === 0
                  ? "NOT CONFIRMED: the limited route never returned 429 even above 50 requests in the 10s window on a single colo."
                  : "INCONCLUSIVE: both routes were throttled - the two cannot be separated.",
    };
    report.finishedAt = new Date().toISOString();

    mkdirSync("poc/out", { recursive: true });
    mkdirSync("poc/evidence", { recursive: true });
    const json = JSON.stringify(report, null, 2);
    writeFileSync("poc/out/media-ab-h2-poc.json", json + "\n");
    writeFileSync("poc/evidence/media-ab-h2-poc.txt", json + "\n");
    console.log(json);
}

main().catch((err) => {
    console.error("poc failed:", err);
    process.exit(1);
});
