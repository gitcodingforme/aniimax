// Goal mode: "reach RV N" or "have K of an item", worked out with the engine's level-up solve. Pure
// functions only (no DOM, no storage); the card is web/cards/goal-mode.js and the tests are
// tests/goal-mode.test.mjs.
//
// How a goal becomes a solve: the planner's level-up input is `{ cost: [[name, amount], ...],
// stock: [[name, amount], ...] }` (LevelUp in src/exact.rs), "coins" for Home Coins. The exact
// planner adds a balance row for every name in it, so any item can be a cost; it then finds the
// soonest time to cover all of it and earns coins with what's left. An RV goal is one solve per
// RV step; an item goal is one solve with that item as the only cost. `priorities: []` is what the
// page sends for its Level up strategy (activePriorities() in app.js), so nothing else is chased.
// `config` is ctx.config (see web/panels.js).
import { stripVariant, summarizePlan } from './plan-summary.js?v=fork-m9-2';

export const GOAL_KEY = 'aniimax-goal-mode-v1';

const copy = value => JSON.parse(JSON.stringify(value ?? null));
const facilityList = config => (Array.isArray(config?.FACILITIES)
    ? config.FACILITIES
    : Object.entries(config?.FACILITIES || {}).map(([name, f]) => ({ name, ...f })));
const tierCount = tiers => (tiers || []).reduce((sum, t) => sum + (t.count > 0 ? t.count : 0), 0);

// Home Coins to raise one facility from `from` to `to`: the page's upgradeCost, else the table.
function upgradeCostOf(config, facility, from, to) {
    if (typeof config.upgradeCost === 'function') return config.upgradeCost(facility, from, to);
    const steps = config.FACILITY_UPGRADE_COSTS?.[facility];
    if (!steps || to <= from) return null;
    let total = 0;
    for (let level = from + 1; level <= to; level++) {
        if (!Number.isFinite(steps[level])) return null;
        total += steps[level];
    }
    return total;
}

// Coins to take every facility in `facilities` (the setup at RV `rv`) to the levels RV `rv`
// unlocks: `{ coins, unknown: ['Mine Lv 3', ...] }`. Facilities placed at that RV are not counted
// beyond that one level.
export function upgradeCoinsAt(config, rv, facilities) {
    let coins = 0;
    const unknown = [];
    for (const f of facilityList(config)) {
        const count = tierCount(facilities?.[f.name]);
        if (!count || f.hasLevels === false) continue;
        for (const [level, need] of Object.entries(f.unlocks || {})) {
            const to = Number(level);
            if (need !== rv || to < 2) continue;
            const cost = upgradeCostOf(config, f.name, to - 1, to);
            if (cost === null || cost === undefined) unknown.push(`${f.name} Lv ${to}`);
            else coins += cost * count;
        }
    }
    return { coins, unknown };
}

// Whether `stock` covers every entry of `cost` (LevelUp::ready in exact.rs).
export function covers(cost, stock) {
    const have = name => (stock || []).filter(([n]) => n === name).reduce((sum, [, a]) => sum + a, 0);
    return (cost || []).every(([name, need]) => have(name) >= need);
}

// A copy of `base` for a goal solve. Under a Priorities strategy going for Aniipods the page
// excludes the lesser Aniipod tiers (excludedRecipes in app.js); a goal chases no priorities, so
// only the tiers in `tiers` the player skipped themselves (`skipped`) stay excluded.
export function goalBase(base, { tiers = [], skipped = [] } = {}) {
    const input = copy(base);
    if (Array.isArray(input?.exclude)) {
        const own = new Set(Array.isArray(skipped) ? skipped : []);
        const lesser = new Set(Array.isArray(tiers) ? tiers : []);
        input.exclude = input.exclude.filter(name => !lesser.has(name) || own.has(name));
    }
    return input;
}

// Everything a player at `rv` could have: the page's simpleSetup, or the same worked out from
// FACILITIES (`unlocks`, `counts`) and MODULE_MAX_LEVELS.
function setupAt(config, rv) {
    if (typeof config.simpleSetup === 'function') return config.simpleSetup(rv);
    const at = list => (Array.isArray(list) && list.length ? list[Math.max(1, Math.min(rv, list.length)) - 1] : 0);
    const facilities = {};
    for (const f of facilityList(config)) {
        const unlocked = Object.entries(f.unlocks || {}).filter(([, need]) => need <= rv).map(([level]) => Number(level));
        facilities[f.name] = unlocked.length ? [{ count: at(f.counts), level: Math.max(...unlocked) }] : [{ count: 0, level: 1 }];
    }
    const modules = Object.fromEntries(Object.entries(config.MODULE_MAX_LEVELS || {}).map(([m, caps]) => [m, at(caps)]));
    return { facilities, modules };
}

const tierLevel = tiers => Math.max(0, ...(tiers || []).filter(t => t.count > 0).map(t => t.level));

// The lowest RV level whose facilities and modules cover everything in `input` (homeLevelCovering
// in web/roadmap.js, copied from app.js), for Advanced mode, which has no RV level input of its own.
export function homeLevelCovering(input, config = {}) {
    const top = Number.isInteger(config.MAX_HOME_LEVEL) ? config.MAX_HOME_LEVEL : 20;
    for (let level = 1; level <= top; level++) {
        const allowed = setupAt(config, level);
        const facilitiesFit = facilityList(config).every((f) => {
            const have = input?.facilities?.[f.name];
            if (tierCount(have) === 0) return true;
            const cap = allowed.facilities[f.name];
            return tierCount(have) <= tierCount(cap) && (f.hasLevels === false || tierLevel(have) <= tierLevel(cap));
        });
        const modulesFit = Object.entries(input?.modules || {}).every(([name, at]) => at <= (allowed.modules?.[name] ?? 0));
        if (facilitiesFit && modulesFit) return level;
    }
    return top;
}

// The RV level a goal starts from. Simple mode: the plan's level-up target less one, else the RV
// level input (`homeLevel`). Advanced mode, where that input is hidden and may be stale: the
// level-up target less one when the plan was a level-up plan, else the lowest RV covering what was
// entered; never below that covering level, since what was entered must already be allowed.
export function startLevel(input, { config = {}, simple = false, homeLevel = null, context = null } = {}) {
    const top = Number.isInteger(config.MAX_HOME_LEVEL) ? config.MAX_HOME_LEVEL : 20;
    const clamp = rv => Math.max(1, Math.min(top, Math.floor(rv)));
    const target = Number(context?.target);
    const hasTarget = Number.isInteger(target) && target > 1;
    if (simple) {
        const given = Number(homeLevel);
        return clamp(hasTarget ? target - 1 : (Number.isInteger(given) && given >= 1 ? given : 1));
    }
    const covering = homeLevelCovering(input, config);
    return clamp(context?.levelUp && hasTarget ? Math.max(covering, target - 1) : covering);
}

// One plan input per RV step from `from` + 1 to `to`: `[{ rv, input, note, ready }]`. Simple mode
// plans each step with everything RV rv - 1 allows (config.simpleSetup); advanced mode keeps the
// player's facilities. The stock on hand counts toward the first step only. `countUpgrades`
// (simple mode) adds the upgrades unlocked at RV rv - 1 to that step's coins. A step without a
// cost table has `input: null` and says so. `skipped` is the player's own skips (see goalBase).
export function rvSteps(base, { from, to, config = {}, simple = false, countUpgrades = false, skipped = [] } = {}) {
    const steps = [];
    const clean = goalBase(base, { tiers: config.ANIIPOD_TIERS, skipped });
    const top = Number.isInteger(config.MAX_HOME_LEVEL) ? config.MAX_HOME_LEVEL : 20;
    const end = Math.min(Math.floor(Number(to)), top);
    const stock = (base?.level_up?.stock || []).filter(([, n]) => n > 0).map(([name, n]) => [name, n]);
    const useSetup = simple && typeof config.simpleSetup === 'function';
    let stockUsed = false;
    for (let rv = Math.floor(Number(from)) + 1; rv <= end; rv++) {
        const table = config.LEVEL_UP_COSTS?.[rv];
        if (!table) {
            steps.push({ rv, input: null, note: `no cost table for RV ${rv}`, ready: false });
            continue;
        }
        const input = copy(clean);
        const notes = [];
        let coins = table.coins || 0;
        if (useSetup) {
            const { facilities, modules } = copy(config.simpleSetup(rv - 1));
            input.facilities = facilities;
            input.modules = modules;
            if (countUpgrades) {
                const up = upgradeCoinsAt(config, rv - 1, facilities);
                coins += up.coins;
                if (up.coins > 0) notes.push(`includes ${up.coins.toLocaleString('en-US')} coins of upgrades unlocked at RV ${rv - 1}`);
                if (up.unknown.length) notes.push(`upgrade cost unknown for ${up.unknown.join(', ')}`);
            } else {
                notes.push(`assumes everything RV ${rv - 1} allows, upgrade coins not counted`);
            }
        } else {
            notes.push('uses your facilities as they are; upgrades are not assumed');
        }
        const cost = [['coins', coins], ...(table.items || []).map(([item, n]) => [item, n])];
        const here = stockUsed ? [] : stock;
        stockUsed = true;
        input.priorities = [];
        input.level_up = { cost, stock: here };
        steps.push({ rv, input, note: notes.join('; '), ready: covers(cost, here) });
    }
    return steps;
}

// The plan input for "have `amount` of `item`", `have` already in stock.
export function itemGoalInput(base, item, amount, have = 0, { tiers = [], skipped = [] } = {}) {
    const input = goalBase(base, { tiers, skipped });
    input.priorities = [];
    input.level_up = { cost: [[item, amount]], stock: have > 0 ? [[item, have]] : [] };
    return input;
}

// Seconds until `streams` (`[{ perSecond, lead }]`, each starting after its lead) make `need`.
function timeForStreams(streams, need) {
    const sorted = [...streams].sort((a, b) => a.lead - b.lead);
    let made = 0;
    let rate = 0;
    let t = 0;
    for (const s of sorted) {
        if (rate > 0 && made + rate * (s.lead - t) >= need) return t + (need - made) / rate;
        made += rate * (s.lead - t);
        t = s.lead;
        rate += s.perSecond;
    }
    return t + (need - made) / rate;
}

// How long the plan on screen takes to make `amount` of `item` (with `have` in stock) from what it
// sells, without solving: `{ seconds, perSecond, lead }`, seconds null when it sells none.
export function atCurrentPlan(plan, item, amount, have = 0) {
    const streams = (plan?.income_streams || [])
        .filter(s => stripVariant(s?.item_name) === item && s.units_per_second > 0)
        .map(s => ({ perSecond: s.units_per_second, lead: Math.max(0, Number(s.lead_time_seconds) || 0) }));
    const perSecond = streams.reduce((sum, s) => sum + s.perSecond, 0);
    const lead = streams.length ? Math.min(...streams.map(s => s.lead)) : null;
    const need = Math.max(0, amount - (have || 0));
    if (need <= 0) return { seconds: 0, perSecond, lead };
    if (!streams.length) return { seconds: null, perSecond: 0, lead: null };
    return { seconds: timeForStreams(streams, need), perSecond, lead };
}

// A level-up plan in short: `{ seconds, slowest: { name, seconds } | null, rows }`, rows one per
// producing facility and item `{ facility, item, count }`, the `focus` items first, then the most
// facilities. A requirement the plan never covers (seconds null) is the slowest.
export function summarizeStep(plan, focus = []) {
    const report = plan?.level_up;
    const seconds = Number.isFinite(report?.seconds) ? report.seconds : null;
    let slowest = null;
    for (const r of report?.requirements || []) {
        const s = Number.isFinite(r.seconds) ? r.seconds : Infinity;
        if (!slowest || s > slowest.rank) slowest = { name: r.name, seconds: Number.isFinite(r.seconds) ? r.seconds : null, rank: s };
    }
    const byKey = new Map();
    for (const row of summarizePlan(plan).rows) {
        const item = stripVariant(row.item);
        const key = `${row.facility}:${item}`;
        if (byKey.has(key)) byKey.get(key).count += row.count;
        else byKey.set(key, { facility: row.facility, item, count: row.count });
    }
    const first = row => (focus.includes(row.item) ? 0 : 1);
    const rows = [...byKey.values()].sort((a, b) => first(a) - first(b) || b.count - a.count);
    return { seconds, slowest: slowest && { name: slowest.name, seconds: slowest.seconds }, rows };
}

// What one solve came back as: `{ status: 'ok', ...summarizeStep }`, 'failed' (with `error`),
// 'unreachable' (the setup can't make the cost) or 'rejected' (a plan without a level-up, e.g.
// from the backup planner, with its `reason`).
export function stepOutcome(plan, focus = []) {
    if (!plan || plan.success === false) return { status: 'failed', error: plan?.error || 'The planner failed' };
    if (plan.level_up_note === 'unreachable') return { status: 'unreachable' };
    if (!plan.level_up) return { status: 'rejected', reason: plan.fallback_reason || null };
    return { status: 'ok', ...summarizeStep(plan, focus) };
}

// "about 2.5 days", "about 5 hours", "under an hour", "ready now", or "never" for null.
export function formatDays(seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'never';
    if (seconds <= 0) return 'ready now';
    if (seconds < 3600) return 'under an hour';
    if (seconds < 86400) {
        const h = Math.round(seconds / 3600);
        return `about ${h} hour${h === 1 ? '' : 's'}`;
    }
    const days = seconds / 86400;
    const d = days < 10 ? Number(days.toFixed(1)) : Math.round(days);
    return `about ${d} day${d === 1 ? '' : 's'}`;
}

// The goal items from get_all_items' recipes: `[{ name, label }]` by label, a quick recipe folded
// into what it makes (made_item in exact.rs), plus the byproducts (Wood Blocks, Mineral Sand).
export function goalItems(recipes, label = name => name) {
    const list = Array.isArray(recipes) ? recipes : [];
    const known = new Set(list.map(r => r?.name).filter(n => typeof n === 'string'));
    const names = new Set();
    for (const r of list) {
        if (typeof r?.name !== 'string') continue;
        const base = stripVariant(r.name);
        names.add(base.startsWith('quick_') && known.has(base.slice(6)) ? base.slice(6) : base);
        if (typeof r.byproduct_item === 'string') names.add(r.byproduct_item);
    }
    return [...names].map(name => ({ name, label: String(label(name)) })).sort((a, b) => a.label.localeCompare(b.label));
}

// The saved goal, read back safely: `{ kind, rv, item, amount, have, countUpgrades }`.
export function readGoal(raw) {
    let g = null;
    try {
        g = JSON.parse(raw);
    } catch (_) { /* nothing saved, or not ours */ }
    if (!g || typeof g !== 'object') g = {};
    const num = (v, min) => (Number.isFinite(v) && v >= min ? v : null);
    return {
        kind: g.kind === 'item' ? 'item' : 'rv',
        rv: Number.isInteger(g.rv) ? g.rv : null,
        item: typeof g.item === 'string' ? g.item : null,
        amount: num(g.amount, 1),
        have: num(g.have, 0),
        countUpgrades: g.countUpgrades === true,
    };
}
