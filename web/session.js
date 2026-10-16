// Session planner: "I have 40 minutes tonight" or "overnight, 8 hours". Pure functions only (no
// DOM, no storage); tested in tests/session.test.mjs. The card (web/cards/session.js) wires the
// inputs, the solver and the page.
//
// Session mode leaves out every recipe whose batch takes longer than the window, so whatever is
// started now is done before the player stops. Overnight mode does the opposite: it leaves out
// every row whose output store would fill before morning, so nothing sits full and idle while they
// sleep. Either way the plan is solved again with those recipes added to the input's `exclude`,
// which takes whole recipe names (`__by<n>` and `__uncovered` stripped, as base_item_name in
// src/models.rs does; quick variants have names of their own, so they stay in).
//
// Output caps are fan-wiki figures (OUTPUT_CAPS in facility-config.js), not checked in game. A row
// whose cap (or batch size) is unknown counts as "never fills" and is listed apart.

import { DEFAULT_ASSUMPTIONS, batchesUntilFull, outputCap, planRows } from './reminders.js?v=fork-m10-1';
import { stripVariant } from './plan-summary.js?v=fork-m10-1';

export const SESSION_KEY = 'aniimax-session-v1';
export const DEFAULTS = Object.freeze({ mode: 'session', minutes: 40, hours: 8 });
export const LIMITS = Object.freeze({ minutes: [1, 720], hours: [1, 24] });

// --- saved inputs ------------------------------------------------------------------

function clamp(value, [min, max], fallback, step) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    const rounded = Math.round(n / step) * step;
    return Math.min(max, Math.max(min, rounded));
}

// The card's saved inputs from localStorage's text (anything unreadable gives the defaults):
// `{ mode: 'session' | 'overnight', minutes, hours }`. Minutes are whole, hours in halves.
export function readSettings(text) {
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch (_) {
        data = null;
    }
    return {
        mode: data?.mode === 'overnight' ? 'overnight' : 'session',
        minutes: clamp(data?.minutes, LIMITS.minutes, DEFAULTS.minutes, 1),
        hours: clamp(data?.hours, LIMITS.hours, DEFAULTS.hours, 0.5),
    };
}

export function writeSettings(settings) {
    return JSON.stringify(readSettings(JSON.stringify(settings ?? {})));
}

// The window in seconds for the chosen mode.
export function windowSecondsFor(settings) {
    const s = readSettings(JSON.stringify(settings ?? {}));
    return s.mode === 'overnight' ? s.hours * 3600 : s.minutes * 60;
}

// The plan input for "Aim for": the strategy as it is, or Home Coins only (what the Priorities
// strategy sends with only Home Coins ticked: priorities ['coins'] and no level-up). Going for
// Aniipods puts the lesser tiers in `exclude` (excludedRecipes in app.js); Home Coins only would
// not, so every `aniipodTiers` name (ctx.config.ANIIPOD_TIERS) the player did not skip themselves
// (`skipped`, the setup's skippedRecipes) comes back out. The rest of the input stays as it is.
export function aimInput(input, aim, { aniipodTiers = [], skipped = [] } = {}) {
    if (aim !== 'coins') return input;
    const own = new Set(Array.isArray(skipped) ? skipped : []);
    const tiers = new Set((Array.isArray(aniipodTiers) ? aniipodTiers : []).filter(name => !own.has(name)));
    const exclude = (Array.isArray(input?.exclude) ? input.exclude : []).filter(name => !tiers.has(name));
    return { ...input, priorities: ['coins'], level_up: null, exclude };
}

// Whether a row keeps working by itself after its first batch (the reminders' assumption
// switches: plotsResow for crops, processorsRepeat for processors; gatherers always repeat).
export function repeats(row, assumptions = DEFAULT_ASSUMPTIONS) {
    const a = { ...DEFAULT_ASSUMPTIONS, ...(assumptions || {}) };
    if (row?.kind === 'crop') return !!a.plotsResow;
    if (row?.kind === 'processor') return !!a.processorsRepeat;
    return true;
}

// --- rows that do not suit the window ------------------------------------------------------

function producingSteps(plan) {
    return (Array.isArray(plan?.coin_items) ? plan.coin_items : [])
        .filter(s => s && s.status === 'producing' && s.item_name && s.facility_count > 0);
}

function addName(names, item) {
    const name = stripVariant(item);
    if (!names.includes(name)) names.push(name);
    return names;
}

// Recipes the plan runs whose batch takes longer than the window, as whole recipe names, once
// each. (A processor's first batch may also wait for its ingredients; that wait is not counted.)
export function longRecipes(plan, windowSeconds) {
    return producingSteps(plan)
        .filter(step => Number(step.cycle_time) > windowSeconds)
        .reduce((names, step) => addName(names, step.item_name), []);
}

// Seconds between finished batches: the row's effectiveCycleSeconds (from the plan's output rate,
// set by planRows) when it has one, else the batch time.
export function batchInterval(row) {
    const interval = Number(row?.effectiveCycleSeconds ?? row?.cycleSeconds);
    return interval > 0 ? interval : row?.cycleSeconds;
}

// Seconds from setup until this row's output store is full (a planRows row), or null when the cap
// or the batch size is unknown. The same moment as the reminders' "collect" event: the store's
// batches times the interval between finished batches (batchInterval), plus, for a processor, the
// wait for its first ingredients (its leadSeconds already holds that wait and its first batch). A
// row that does not repeat (see `repeats`) stops after one batch, as the reminders assume, cap or
// no cap.
export function fillSeconds(row, caps, assumptions = DEFAULT_ASSUMPTIONS) {
    if (!row || !(row.cycleSeconds > 0)) return null;
    if (!repeats(row, assumptions)) return row.kind === 'processor' && row.leadSeconds > 0 ? row.leadSeconds : row.cycleSeconds;
    const batches = batchesUntilFull(outputCap(caps, row.facility, row.level), row.yieldPerBatch);
    if (!batches) return null;
    const wait = row.kind === 'processor' && row.leadSeconds > row.cycleSeconds ? row.leadSeconds - row.cycleSeconds : 0;
    return batches * batchInterval(row) + wait;
}

// Rows whose store fills before the window ends, soonest first: `[{ key, item, facility, fillSeconds }]`.
export function cappedRows(rows, caps, windowSeconds, assumptions = DEFAULT_ASSUMPTIONS) {
    return (rows || [])
        .map(row => ({ key: row.key, item: row.item, facility: row.facility, fillSeconds: fillSeconds(row, caps, assumptions) }))
        .filter(r => r.fillSeconds !== null && r.fillSeconds < windowSeconds)
        .sort((a, b) => a.fillSeconds - b.fillSeconds);
}

// Rows with no known cap (they count as "never fills"): `[{ key, item, facility }]`.
export function unknownCapRows(rows, caps, assumptions = DEFAULT_ASSUMPTIONS) {
    return (rows || [])
        .filter(row => fillSeconds(row, caps, assumptions) === null)
        .map(row => ({ key: row.key, item: row.item, facility: row.facility }));
}

// The first store to fill: `{ key, item, facility, fillSeconds }`, or null when no cap is known.
export function firstCollectBy(rows, caps, assumptions = DEFAULT_ASSUMPTIONS) {
    let first = null;
    for (const row of rows || []) {
        const seconds = fillSeconds(row, caps, assumptions);
        if (seconds !== null && (first === null || seconds < first.fillSeconds)) {
            first = { key: row.key, item: row.item, facility: row.facility, fillSeconds: seconds };
        }
    }
    return first;
}

// --- coins in the window ------------------------------------------------------------------

// Each row's share of the plan's Home Coins a second, in `rows` order: `{ perRow, unmatched,
// prorated }`. The plan's income_streams say what each sold product earns; a stream's share of
// `rate_per_second` goes to the rows that make that product (same facility first), split by their
// facility counts. Rows that only feed other recipes earn nothing directly. A stream no row makes
// (a byproduct) is `unmatched`. Without income_streams (a cut-down plan), rate_per_second is
// prorated: every row gets an equal share by row count, and `prorated` says so.
export function rowRates(plan, rows) {
    const list = rows || [];
    const rate = Number(plan?.rate_per_second);
    const total = Number.isFinite(rate) && rate > 0 ? rate : 0;
    const perRow = list.map(() => 0);
    if (total === 0 || list.length === 0) return { perRow, unmatched: total, prorated: false };
    const streams = (Array.isArray(plan.income_streams) ? plan.income_streams : [])
        .filter(s => s && Number(s.rate_per_second) > 0);
    const streamTotal = streams.reduce((sum, s) => sum + Number(s.rate_per_second), 0);
    if (streamTotal > 0) {
        let unmatched = 0;
        for (const stream of streams) {
            const share = total * Number(stream.rate_per_second) / streamTotal;
            const name = stripVariant(stream.item_name);
            let makers = list.map((row, i) => i).filter(i => stripVariant(list[i].item) === name && list[i].facility === stream.facility);
            if (makers.length === 0) makers = list.map((row, i) => i).filter(i => stripVariant(list[i].item) === name);
            if (makers.length === 0) {
                unmatched += share;
                continue;
            }
            const weight = i => (list[i].count > 0 ? list[i].count : 1);
            const weights = makers.reduce((sum, i) => sum + weight(i), 0);
            for (const i of makers) perRow[i] += share * weight(i) / weights;
        }
        return { perRow, unmatched, prorated: false };
    }
    return { perRow: list.map(() => total / list.length), unmatched: 0, prorated: true };
}

// Home Coins the plan makes in the window if nobody collects: each row earns its share of the
// rate until its store is full or, if it does not repeat, its one batch is done (or for the whole window when its cap is unknown). An estimate:
// it ignores lead times and whether a full store upstream starves a processor downstream. Never
// more than rate_per_second times the window. Null for a missing or failed plan.
export function windowCoins(plan, rows, caps, windowSeconds, assumptions = DEFAULT_ASSUMPTIONS) {
    if (!plan?.success || !(windowSeconds > 0)) return null;
    const list = rows || [];
    const { perRow, unmatched } = rowRates(plan, list);
    let coins = unmatched * windowSeconds;
    list.forEach((row, i) => {
        const fill = fillSeconds(row, caps, assumptions);
        coins += perRow[i] * Math.min(windowSeconds, fill ?? windowSeconds);
    });
    return coins;
}

// --- the level-up ------------------------------------------------------------------

// What the level-up needs (plan.level_up.requirements, coins aside) that `excluded` leaves out,
// directly or as an ingredient on the way (followed through `recipes`, the recipe index with
// `ingredients` or `raw_materials`). Names once each, in requirement order.
export function levelUpLosses(plan, excluded, recipes = null) {
    const out = new Set((excluded || []).map(stripVariant));
    const needed = (plan?.level_up?.requirements || []).map(r => r?.name).filter(n => n && n !== 'coins');
    const seen = new Set();
    const losses = [];
    const visit = (name, depth) => {
        if (seen.has(name) || depth > 8) return;
        seen.add(name);
        if (out.has(name) && !losses.includes(name)) losses.push(name);
        for (const recipe of Array.isArray(recipes) ? recipes : []) {
            if (recipe?.name !== name) continue;
            for (const part of recipe.ingredients || recipe.raw_materials || []) visit(part, depth + 1);
        }
    };
    needed.forEach(name => visit(name, 0));
    return losses;
}

// --- re-solving ------------------------------------------------------------------

function usable(plan) {
    return !!plan?.success && producingSteps(plan).length > 0;
}

function cancelled() {
    return new Error('cancelled');
}

// Solves `base` (a find_plan input) again without the recipes that do not suit the window, until
// the plan fits or `maxRounds` re-solves have run. `plan` is base's own plan when already solved;
// without it, base is solved first (that solve is not counted in `rounds`). Resolves with
// `{ plan, excluded, rounds, complete, remaining, unknown, error }`: `excluded` the recipe names
// added to base.exclude, `rounds` the re-solves, `complete` false while some rows still do not
// fit (`remaining`, their names), `unknown` the final plan's rows with no known cap. `plan` is
// null when nothing fits (every recipe left out, or the planner found nothing); `error` then says
// why. `assumptions` are the reminders' switches (which rows repeat). Rejects with
// Error('cancelled') when `signal` aborts, and with findPlan's own errors.
export async function adaptPlan({
    base, plan = null, mode, windowSeconds, findPlan, recipes = null, facilities = null, caps = null,
    assumptions = DEFAULT_ASSUMPTIONS, maxRounds = 3, signal, onRound,
} = {}) {
    if (mode !== 'session' && mode !== 'overnight') throw new Error(`unknown session mode "${mode}"`);
    if (!(windowSeconds > 0)) throw new RangeError('the window must be a positive number of seconds');
    if (typeof findPlan !== 'function') throw new TypeError('adaptPlan needs a findPlan function');
    if (!base || typeof base !== 'object') throw new TypeError('adaptPlan needs the plan input');
    const rowsOf = p => planRows(p, { recipes, facilities });
    const offendersOf = p => (mode === 'session'
        ? longRecipes(p, windowSeconds)
        : cappedRows(rowsOf(p), caps, windowSeconds, assumptions).reduce((names, r) => addName(names, r.item), []));
    const out = new Set(Array.isArray(base.exclude) ? base.exclude : []);
    const excluded = [];
    let rounds = 0;
    const nothing = error => ({ plan: null, excluded: [...excluded], rounds, complete: false, remaining: [], unknown: [], error });
    const solve = async () => {
        if (signal?.aborted) throw cancelled();
        const answer = await findPlan({ ...base, exclude: [...out] }, { signal });
        if (signal?.aborted) throw cancelled();
        return answer;
    };

    let current = plan;
    if (!usable(current)) {
        current = await solve();
        if (!usable(current)) return nothing(current?.error || 'The planner found no plan for this setup.');
    }
    let offenders = offendersOf(current);
    let fresh = offenders.filter(name => !out.has(name));
    while (fresh.length > 0 && rounds < maxRounds) {
        for (const name of fresh) {
            out.add(name);
            excluded.push(name);
        }
        const every = Array.isArray(recipes) && recipes.length > 0 && recipes.every(r => out.has(r?.name));
        if (every) return nothing('Every recipe would be left out.');
        if (onRound) {
            try {
                onRound(rounds + 1, [...excluded]);
            } catch (e) {
                console.warn('A session planner listener failed:', e);
            }
        }
        const next = await solve();
        rounds++;
        if (!usable(next)) return nothing(next?.error || 'Nothing is left to make once those recipes are left out.');
        current = next;
        offenders = offendersOf(current);
        fresh = offenders.filter(name => !out.has(name));
    }
    return {
        plan: current,
        excluded,
        rounds,
        complete: offenders.length === 0,
        remaining: offenders,
        unknown: unknownCapRows(rowsOf(current), caps, assumptions),
        error: null,
    };
}

// Whether a new 'plan' value should stop a run that is running (`running`) from the plan
// `previous`: no plan is on screen any more (null: another Aniimo setup is solving, or the solve
// failed), or the inputs were solved again (a different setupHash or a different setup string). The same setupHash
// stops nothing, so a repeat of the plan on screen leaves the run alone.
export function shouldStop(running, previous, next) {
    if (!running) return false;
    if (!next) return true;
    if (!previous) return false;
    return next.setupHash !== previous.setupHash
        || next.setup !== previous.setup;
}
