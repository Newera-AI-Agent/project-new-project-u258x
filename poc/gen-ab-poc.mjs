#!/usr/bin/env node
// Read-only A/B PoC: gen.pollinations.ai edge rate-limit coverage.
//
// Upstream fact (HEAD 8f369ab): gen/src/index.ts mounts the only global
// limiter inside the LAST-mounted router:
//     .route("/", proxyRoutes)        // index.ts:317
// and proxyRoutes starts with
//     .use("*", edgeRateLimit)        // routes/proxy.ts:433
// Routes registered EARLIER in the chain are therefore never traversed by
// edgeRateLimit:
//     .all("/quests/catalog", ...)    // index.ts:276  (before the limiter)
//     .get("/openapi.json", ...)      // index.ts:304  (before the limiter)
// while /3d/models lives inside proxyRoutes and IS limited.
//
// ETHICS: only unauthenticated GET/HEAD reads of small public endpoints,
// bounded request count, no generation, no credential use, no state change.

const HOST = "gen.pollinations.ai";
const REQUESTS_PER_PHASE = 700;
const CONCURRENCY = 40;
const PHASE_BUDGET_MS = 20_000;

const PHASES = [
    {
        name: "control-limited",
        path: "/3d/models",
        expect: "limited (inside proxyRoutes -> edgeRateLimit, 600/10s)",
    },
    {
        name: "target-quests-catalog",
        path: "/quests/catalog",
        expect: "unlimited in gen (registered before proxyRoutes)",
    },
    {
        name: "target-openapi-json",
        path: "/openapi.json",
        expect: "unlimited in gen (registered before proxyRoutes)",
    },
];

async function runPhase(phase) {
    const statuses = new Map();
    let limited = 0;
    let retryAfterSeen = false;
    let bytes = 0;
    let firstLimitedAt = null;
    let firstOkAt = null;
    const colos = new Set();
    const started = Date.now();
    let issued = 0;

    const worker = async () => {
        while (issued < REQUESTS_PER_PHASE && Date.now() - started < PHASE_BUDGET_MS) {
            const i = issued++;
            const t0 = Date.now();
            try {
                const res = await fetch(`https://${HOST}${phase.path}`, {
                    headers: { "user-agent": "pollinations-redteam-poc/readonly-ab" },
                    redirect: "manual",
                });
                const ray = res.headers.get("cf-ray") || "";
                const colo = ray.includes("-") ? ray.slice(ray.lastIndexOf("-") + 1) : "?";
                if (colo) colos.add(colo);
                const ra = res.headers.get("retry-after");
                if (ra) retryAfterSeen = true;
                statuses.set(res.status, (statuses.get(res.status) || 0) + 1);
                if (res.status === 429) {
                    limited++;
                    if (firstLimitedAt === null) firstLimitedAt = Date.now() - started;
                } else if (firstOkAt === null) {
                    firstOkAt = Date.now() - started;
                }
                // Drain a bounded amount only; do not buffer large bodies.
                const reader = res.body?.getReader();
                if (reader) {
                    let n = 0;
                    while (n < 64 * 1024) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        n += value.byteLength;
                        bytes += value.byteLength;
                    }
                    reader.cancel().catch(() => {});
                }
            } catch (error) {
                statuses.set("error", (statuses.get("error") || 0) + 1);
            }
            if (i % 100 === 0) await new Promise((r) => setTimeout(r, 1));
        }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    return {
        name: phase.name,
        path: phase.path,
        upstreamExpectation: phase.expect,
        requestsIssued: issued,
        durationMs: Date.now() - started,
        statusCounts: Object.fromEntries([...statuses.entries()].map(([k, v]) => [String(k), v])),
        limited429Count: limited,
        retryAfterHeaderSeen: retryAfterSeen,
        firstOkAtMs: firstOkAt,
        first429AtMs: firstLimitedAt,
        colosSeen: [...colos],
        bytesRead: bytes,
    };
}

const startedAt = new Date().toISOString();
const phases = [];
for (const phase of PHASES) phases.push(await runPhase(phase));

const control = phases.find((p) => p.name === "control-limited");
const targets = phases.filter((p) => p.name.startsWith("target-"));
const controlLimited = (control?.limited429Count || 0) > 0;
const targetsUnlimited = targets.every((p) => p.limited429Count === 0);
const verdict = controlLimited && targetsUnlimited
    ? "CONFIRMED: the route mounted behind the edge limiter returned 429 under load while the routes registered before the limiter never returned 429 at the same request volume from the same client IP."
    : controlLimited
      ? "PARTIAL: the limited route returned 429 but at least one pre-limiter route also returned 429 - downstream (Enter) limiting may apply; see per-phase data."
      : "NOT CONFIRMED: the limited route never returned 429 during this run.";

const result = {
    poc: "gen.pollinations.ai edge rate-limit coverage A/B",
    upstreamCommit: "8f369ab561838b4b8a7a3de4e34b1ef528436b6f",
    method: {
        requestsPerPhase: REQUESTS_PER_PHASE,
        concurrency: CONCURRENCY,
        phaseBudgetMs: PHASE_BUDGET_MS,
        method_: "unauthenticated read-only GET, no keys, no generation, bounded volume",
    },
    startedAt,
    finishedAt: new Date().toISOString(),
    phases,
    verdict,
};

console.log(JSON.stringify(result, null, 2));
