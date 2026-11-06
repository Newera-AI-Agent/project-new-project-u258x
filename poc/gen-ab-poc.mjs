#!/usr/bin/env node
/**
 * PoC (read-only, non-destructive): A/B rate-limit coverage test against
 * gen.pollinations.ai.
 *
 * FINDING UNDER TEST (gen.pollinations.ai/src/index.ts):
 *   The edge rate limiter is mounted INSIDE the proxy router:
 *     gen.pollinations.ai/src/routes/proxy.ts:433  .use("*", edgeRateLimit)
 *   and that router is mounted LAST:
 *     gen.pollinations.ai/src/index.ts:317          .route("/", proxyRoutes)
 *   Hono applies middleware in registration order, so every route registered
 *   BEFORE line 317 never traverses the limiter:
 *     index.ts:276  .all("/quests/catalog", ...)   -> Enter /api/quests/catalog
 *     index.ts:304  .get("/openapi.json", ...)     -> merged OpenAPI spec
 *     index.ts:309  .route("/", modelStatusRoutes)  -> /models/status
 *   while routes INSIDE proxyRoutes do traverse it, e.g. /3d/models
 *   (proxy.ts:440 .use("/3d/models", auth()), proxy.ts:553 .get("/3d/models"))
 *
 * METHOD (ethical / minimal impact):
 *   - Only HEAD requests (no body transferred, no generation, no writes).
 *   - Bounded volume, bounded concurrency, per-phase.
 *   - Read-only endpoints only; no keys, no credentials, no data change.
 *
 * The script prints a verdict per phase:
 *   - a phase whose route is covered by the limiter must start returning 429
 *     once the per-IP budget (600 req / 10 s in production) is exhausted;
 *   - a phase whose route is mounted before the limiter must stay 2xx.
 *
 * Usage:
 *   node poc/gen-ab-poc.mjs                 # default: 700 req/phase, 40 conc
 *   REQUESTS=200 CONCURRENCY=20 node poc/gen-ab-poc.mjs
 *   SKIP_PRODUCTION=1 node poc/gen-ab-poc.mjs   # offline self-check only
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const ORIGIN = process.env.ORIGIN ?? "https://gen.pollinations.ai";
const REQUESTS = Number(process.env.REQUESTS ?? 700);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 40);
const METHOD = process.env.METHOD ?? "HEAD";
const SKIP_PRODUCTION = process.env.SKIP_PRODUCTION === "1";
const OUT_JSON = resolve(REPO, "poc/out/gen-ab-poc.json");
const OUT_TXT = resolve(REPO, "poc/evidence/gen-ab-poc.txt");

/**
 * phase.name         human label
 * phase.path         path on the origin
 * phase.expectLimited true  -> the route is mounted behind edgeRateLimit,
 *                               so it MUST start returning 429 under load
 *                     false -> the route is registered before the limiter mount,
 *                               so it is expected to keep answering 2xx
 * phase.note         why, in upstream-code terms
 */
const PHASES = [
    {
        name: "limited-control",
        path: "/3d/models",
        expectLimited: true,
        note: "proxy.ts:433 .use('*', edgeRateLimit) applies; proxy.ts:553 .get('/3d/models'). Control: this route must 429 under load.",
    },
    {
        name: "unlimited-quests-catalog",
        path: "/quests/catalog",
        expectLimited: false,
        note: "index.ts:276 .all('/quests/catalog') is registered BEFORE index.ts:317 .route('/', proxyRoutes) -> gen's edge limiter never runs. Proxied to Enter /api/quests/catalog (index.ts:192 fetchEnter).",
    },
    {
        name: "unlimited-openapi-json",
        path: "/openapi.json",
        expectLimited: false,
        note: "index.ts:304 .get('/openapi.json') is registered BEFORE index.ts:317 -> no gen edge limiter; builds the merged OpenAPI spec per request.",
    },
    {
        name: "unlimited-models-status",
        path: "/models/status?minutes=1",
        expectLimited: false,
        note: "index.ts:309 .route('/', modelStatusRoutes) (routes/model-status.ts) is registered BEFORE index.ts:317 and has no limiter of its own.",
    },
];

function tally(map) {
    const out = {};
    for (const [k, v] of map) out[k] = (out[k] ?? 0) + v;
    return out;
}

async function runPhase(phase) {
    const url = `${ORIGIN}${phase.path}`;
    const statuses = new Map();
    const retryAfter = new Set();
    const serverErrors = [];
    let bytes = 0;
    let done = 0;
    const started = Date.now();

    async function one() {
        try {
            const res = await fetch(url, {
                method: METHOD,
                headers: { "user-agent": "pollinations-redteam-readonly-poc/1.0", accept: "application/json" },
                redirect: "manual",
            });
            statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
            const ra = res.headers.get("retry-after");
            if (ra) retryAfter.add(ra);
            if (res.status >= 500) serverErrors.push(res.status);
            // HEAD has no body; GET bodies are discarded without buffering.
            if (res.body) {
                bytes += Number(res.headers.get("content-length") ?? 0) || 0;
                await res.body.cancel();
            }
        } catch (err) {
            statuses.set("network-error", (statuses.get("network-error") ?? 0) + 1);
            if (serverErrors.length < 5) serverErrors.push(String(err?.message ?? err));
        } finally {
            done++;
        }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, REQUESTS) }, async () => {
        while (done < REQUESTS) await one();
    });
    await Promise.all(workers);

    const durationMs = Date.now() - started;
    const counts = tally(statuses);
    const ok2xx = Object.entries(counts)
        .filter(([k]) => /^2/.test(k))
        .reduce((acc, [, v]) => acc + v, 0);
    const limited429 = counts["429"] ?? 0;

    let verdict;
    if (phase.expectLimited) {
        verdict =
            limited429 > 0
                ? `CONFIRMED: the route mounted behind edgeRateLimit returned 429 for ${limited429}/${REQUESTS} requests under load (control behaves as designed).`
                : `NOT CONFIRMED: the control route never returned 429 in this run (${REQUESTS} requests, ${durationMs} ms) - the limiter did not fire, so the comparison is inconclusive.`;
    } else {
        verdict =
            limited429 === 0 && ok2xx > 0
                ? `CONFIRMED: the route registered before the limiter mount answered ${ok2xx}/${REQUESTS} requests with 2xx and ZERO 429, while the control route behind the limiter was throttled in the same run.`
                : limited429 > 0
                    ? `PARTIAL: this route did return 429 (${limited429}/${REQUESTS}) - a downstream limiter (Enter /api/*) or another control applies; gen's own limiter is still not on this route.`
                    : `NOT CONFIRMED: no 2xx and no 429 observed (${JSON.stringify(counts)}).`;
    }

    return {
        name: phase.name,
        path: phase.path,
        method: METHOD,
        expectLimited: phase.expectLimited,
        note: phase.note,
        requests: REQUESTS,
        concurrency: CONCURRENCY,
        durationMs,
        statusCounts: counts,
        ok2xx,
        limited429,
        retryAfterHeaders: [...retryAfter],
        serverErrors: serverErrors.slice(0, 5),
        verdict,
    };
}

async function main() {
    await mkdir(resolve(REPO, "poc/out"), { recursive: true });
    await mkdir(resolve(REPO, "poc/evidence"), { recursive: true });

    const startedAt = new Date().toISOString();
    const summary = {
        startedAt,
        origin: ORIGIN,
        method: METHOD,
        requestsPerPhase: REQUESTS,
        concurrency: CONCURRENCY,
        safety: "HEAD only, read-only endpoints, bounded volume, no credentials, no writes",
        phases: [],
    };

    if (SKIP_PRODUCTION) {
        summary.finishedAt = new Date().toISOString();
        summary.skipped = "SKIP_PRODUCTION=1 - no production requests were sent";
        summary.verdict = "SKIPPED (offline self-check only)";
    } else {
        for (const phase of PHASES) {
            const result = await runPhase(phase);
            summary.phases.push(result);
            console.log(`[${phase.name}] ${phase.path} -> ${JSON.stringify(result.statusCounts)} (${result.durationMs} ms)`);
            console.log(`   ${result.verdict}`);
        }
        summary.finishedAt = new Date().toISOString();

        const limitedPhase = summary.phases.find((p) => p.expectLimited);
        const unguardedPhases = summary.phases.filter((p) => !p.expectLimited);
        const controlThrottled = (limitedPhase?.limited429 ?? 0) > 0;
        const unguardedNeverThrottled = unguardedPhases.filter((p) => p.limited429 === 0).length;

        if (controlThrottled && unguardedNeverThrottled > 0) {
            summary.verdict = `CONFIRMED: ${unguardedNeverThrottled}/${unguardedPhases.length} routes registered before the edge limiter mount served every request without a 429, while the control route behind the limiter was throttled in the same run.`;
        } else if (controlThrottled) {
            summary.verdict = `PARTIAL: the control route was throttled, but every pre-limiter route also returned 429 in this run - downstream limiting must be examined before claiming no limit.`;
        } else {
            summary.verdict = "NOT CONFIRMED: the control route behind the limiter never returned 429, so this run cannot demonstrate the difference.";
        }
        console.log(`\nVERDICT: ${summary.verdict}`);
    }

    const json = `${JSON.stringify(summary, null, 2)}\n`;
    await writeFile(OUT_JSON, json, "utf8");
    await writeFile(
        OUT_TXT,
        [
            "# gen.pollinations.ai A/B rate-limit coverage PoC (read-only HEAD)",
            `started:  ${summary.startedAt}`,
            `finished: ${summary.finishedAt ?? new Date().toISOString()}`,
            `origin:   ${summary.origin}`,
            `method:   ${summary.method}   requests/phase: ${summary.requestsPerPhase}   concurrency: ${summary.concurrency}`,
            `safety:   ${summary.safety}`,
            "",
            ...summary.phases.flatMap((p) => [
                `## ${p.name}  ${p.method} ${p.path}`,
                `expectLimited: ${p.expectLimited}`,
                `note: ${p.note}`,
                `statusCounts: ${JSON.stringify(p.statusCounts)}`,
                `ok2xx: ${p.ok2xx}  429: ${p.limited429}  durationMs: ${p.durationMs}`,
                `retryAfter: ${JSON.stringify(p.retryAfterHeaders)}`,
                `verdict: ${p.verdict}`,
                "",
            ]),
            `VERDICT: ${summary.verdict}`,
            "",
        ].join("\n"),
        "utf8",
    );
    console.log(`\nwrote ${OUT_JSON}\nwrote ${OUT_TXT}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
