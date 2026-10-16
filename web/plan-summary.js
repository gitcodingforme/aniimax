// A plan in a few numbers, and what changed between two plans, for the feature cards. Pure
// functions only (no DOM, no storage); tested in tests/plan_summary.test.mjs.
//
// A plan is what find_plan returns (JsProductionPlan in src/wasm.rs): `success`,
// `rate_per_second` (Home Coins), `proven_optimal`, `level_up: { seconds } | null`, and
// `coin_items`, one row per facility group with `facility`, `item_name`, `facility_count`,
// `status` ('producing', 'nothing_available', 'not_needed', 'idle') and `cycle_time` (seconds).

// The recipe or crop behind a plan item name: without a roster copy's `__by<n>` or an uncovered
// crop's `__uncovered` (see base_item_name in src/models.rs). 'rose__uncovered__by2' -> 'rose'.
export function stripVariant(name) {
    if (typeof name !== 'string') return name;
    return name.replace(/__by\d+$/, '').replace(/__uncovered$/, '');
}

// `{ ok, coinsPerHour, levelUpSeconds, proven, rows }`: Home Coins an hour, seconds until the
// level-up is covered (null without one), whether the exact planner proved it best, and one row
// per producing facility and item `{ key, facility, item, count, cycleSeconds }`, key
// `${facility}:${item}`. Rows of the same facility and item are merged (their counts added). A
// missing or failed plan gives `ok: false`, null numbers and no rows.
export function summarizePlan(plan) {
    if (!plan || typeof plan !== 'object' || !plan.success) {
        return { ok: false, coinsPerHour: null, levelUpSeconds: null, proven: false, rows: [] };
    }
    const rows = [];
    const byKey = new Map();
    for (const step of Array.isArray(plan.coin_items) ? plan.coin_items : []) {
        if (!step || step.status !== 'producing' || !step.item_name || !(step.facility_count > 0)) continue;
        const key = `${step.facility}:${step.item_name}`;
        const known = byKey.get(key);
        if (known) {
            known.count += step.facility_count;
            continue;
        }
        const row = {
            key,
            facility: step.facility,
            item: step.item_name,
            count: step.facility_count,
            cycleSeconds: Number.isFinite(step.cycle_time) ? step.cycle_time : null,
        };
        byKey.set(key, row);
        rows.push(row);
    }
    const rate = Number(plan.rate_per_second);
    const seconds = plan.level_up?.seconds;
    return {
        ok: true,
        coinsPerHour: Number.isFinite(rate) ? rate * 3600 : null,
        levelUpSeconds: Number.isFinite(seconds) ? seconds : null,
        proven: plan.proven_optimal === true,
        rows,
    };
}

function rowsOf(planOrSummary) {
    // A summary (from summarizePlan) is used as it is; anything else is summarized first.
    if (planOrSummary && Array.isArray(planOrSummary.rows) && !('coin_items' in planOrSummary)) return planOrSummary.rows;
    return summarizePlan(planOrSummary).rows;
}

// Where two plans (or two summaries) differ in how many facilities make what:
// `[{ key, facility, item, before, after }]`, `before` from `a` and `after` from `b`, 0 for a row
// only one of them has. In `a`'s row order, then the rows only `b` has.
export function diffPlans(a, b) {
    const before = rowsOf(a);
    const after = rowsOf(b);
    const afterByKey = new Map(after.map(row => [row.key, row]));
    const beforeKeys = new Set(before.map(row => row.key));
    const changes = [];
    for (const row of before) {
        const other = afterByKey.get(row.key);
        const count = other ? other.count : 0;
        if (count !== row.count) changes.push({ key: row.key, facility: row.facility, item: row.item, before: row.count, after: count });
    }
    for (const row of after) {
        if (!beforeKeys.has(row.key)) changes.push({ key: row.key, facility: row.facility, item: row.item, before: 0, after: row.count });
    }
    return changes;
}
