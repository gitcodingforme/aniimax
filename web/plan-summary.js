// A plan in a few numbers, what changed between two plans, and the RV level the player is at
// (playerHomeLevel, below), for the feature cards. Pure functions only (no DOM, no storage; its
// one import is shared.js); tested in tests/plan_summary.test.mjs.
//
// A plan is what find_plan returns (JsProductionPlan in src/wasm.rs): `success`,
// `rate_per_second` (Home Coins), `proven_optimal`, `level_up: { seconds } | null`, and
// `coin_items`, one row per facility group with `facility`, `item_name`, `facility_count`,
// `status` ('producing', 'nothing_available', 'not_needed', 'idle') and `cycle_time` (seconds).

import { tierCount, tierLevel } from './shared.js?v=fork-m10-1';

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

// --- The player's RV level ---------------------------------------------------------------
// One answer to "which RV (Homeland) level is the player at", shared by the roadmap, goal-mode,
// what-if and roster-advisor cards so they never disagree. `config` is ctx.config (see
// web/panels.js): FACILITIES (an array, or an object by name) with `unlocks` and `counts`,
// MODULE_MAX_LEVELS, MAX_HOME_LEVEL, and the page's `simpleSetup` when it has one.

const facilityList = config => (Array.isArray(config?.FACILITIES)
    ? config.FACILITIES
    : Object.entries(config?.FACILITIES || {}).map(([name, f]) => ({ name, ...f })));
const topHomeLevel = config => (Number.isInteger(config?.MAX_HOME_LEVEL) ? config.MAX_HOME_LEVEL : 20);
// The value for RV level `rv` in a per-RV list, keeping the last value past its end.
const atRv = (list, rv) => (Array.isArray(list) && list.length ? list[Math.max(1, Math.min(rv, list.length)) - 1] : 0);

// Everything a player at RV `rv` could have, `{ facilities: { name: [{count, level}] }, modules }`:
// the page's simpleSetup when `config` has it, else the same worked out from FACILITIES
// (`unlocks`, `counts`) and MODULE_MAX_LEVELS (facility-config.js's simpleSetup).
export function setupAtHomeLevel(config, rv) {
    if (typeof config?.simpleSetup === 'function') return config.simpleSetup(rv);
    const facilities = {};
    for (const f of facilityList(config)) {
        const unlocked = Object.entries(f.unlocks || {}).filter(([, need]) => need <= rv).map(([level]) => Number(level));
        facilities[f.name] = unlocked.length === 0
            ? [{ count: 0, level: 1 }]
            : [{ count: atRv(f.counts, rv), level: Math.max(...unlocked) }];
    }
    const modules = Object.fromEntries(Object.entries(config?.MODULE_MAX_LEVELS || {}).map(([m, caps]) => [m, atRv(caps, rv)]));
    return { facilities, modules };
}

// Whether RV `rv` allows everything `input` (a plan input) owns: of each facility no more than
// that RV has room for and no level above the highest it unlocks, and every module at or below
// that RV's cap (the page's covering rule; a module the RV has no cap for allows level 0 only).
export function coversHomeLevel(input, config, rv) {
    const allowed = setupAtHomeLevel(config, rv);
    const facilitiesFit = facilityList(config).every((f) => {
        const have = input?.facilities?.[f.name];
        if (tierCount(have) === 0) return true;
        const cap = allowed.facilities?.[f.name];
        return tierCount(have) <= tierCount(cap) && (f.hasLevels === false || tierLevel(have) <= tierLevel(cap));
    });
    const modulesFit = Object.entries(input?.modules || {}).every(([name, level]) => !(level > (allowed.modules?.[name] ?? 0)));
    return facilitiesFit && modulesFit;
}

// The lowest RV level that allows every facility and module `input` owns, or MAX_HOME_LEVEL when
// none does. Two rules, on purpose: the page (app.js) uses only this covering rule, for Advanced
// mode's layout RV and the Opportunities card's "Within RV X" (what the entered setup allows,
// whatever level-up is planned), while the cards use playerHomeLevel below, which starts from a
// level-up target or the saved RV level. Switching the page to playerHomeLevel would visibly change
// those two, so it keeps this one.
export function coveringHomeLevel(input, config) {
    const top = topHomeLevel(config);
    for (let rv = 1; rv <= top; rv++) if (coversHomeLevel(input, config, rv)) return rv;
    return top;
}

// The RV level to assume the player is at, for a plan input `input`. The one rule:
//   1. A level-up plan (`context.levelUp` with a whole `context.target` above 1) is worked toward
//      from one level below its target: `target - 1`. (INFERRED: the page prices a level-up
//      plan at that one level's cost, LEVEL_UP_COSTS[target], so the player is at target - 1.)
//   2. Otherwise the saved RV level input (`savedHomeLevel`, the page's #home-level).
//   3. Otherwise (no saved level) the lowest RV covering what `input` owns (coveringHomeLevel).
// Advanced mode, where the RV input is hidden and may be stale, never goes below that covering
// level, since what was entered must already be allowed: a saved level that does not cover the
// owned facilities and modules gives way to the covering level, and so does a level-up target
// whose level below is too low. Simple mode's input comes from its own RV level, so it is used
// as it is. The answer is a whole number from 1 to MAX_HOME_LEVEL. `simple` defaults to
// `context.simple`. `context` is the 'plan' topic's planContext (see docs/plans/card-contract.md).
export function playerHomeLevel({ input = null, config = {}, simple = undefined, savedHomeLevel = null, context = null } = {}) {
    const top = topHomeLevel(config);
    const clamp = rv => Math.max(1, Math.min(top, Math.floor(rv)));
    const isSimple = typeof simple === 'boolean' ? simple : context?.simple === true;
    const target = Number(context?.target);
    const levellingUp = !!context?.levelUp && Number.isInteger(target) && target > 1;
    const given = savedHomeLevel === null || savedHomeLevel === undefined || savedHomeLevel === '' ? NaN : Number(savedHomeLevel);
    const saved = Number.isFinite(given) && given >= 1 ? clamp(given) : null;
    if (isSimple) {
        if (levellingUp) return clamp(target - 1);
        return saved ?? coveringHomeLevel(input, config);
    }
    const covering = coveringHomeLevel(input, config);
    if (levellingUp) return clamp(Math.max(covering, target - 1));
    if (saved !== null && coversHomeLevel(input, config, saved)) return saved;
    return covering;
}
