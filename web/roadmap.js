// Upgrade roadmap: what to upgrade next, one change at a time, priced in Home Coins and ranked by
// how fast it pays for itself. Pure functions only (no DOM, no storage, no imports); the card is
// web/cards/roadmap.js and the tests are tests/roadmap.test.mjs.
//
// `config` is ctx.config (see web/panels.js): FACILITIES (with `unlocks` and `counts`),
// FACILITY_UPGRADE_COSTS, LEVEL_UP_COSTS, MODULE_MAX_LEVELS, MAX_HOME_LEVEL, and the page's
// `upgradeCost` and `simpleSetup` when it has them (copies of both are below, for a config
// without them).
//
// What the numbers mean: the card ranks with measure 'coins', so each result's `top` is the most
// Home Coins per second the planner can make with that input (the objective of
// exact_priority_problem(input, no floors, 'coins'), src/exact.rs: "currency per second"),
// ignoring the plan's priorities and level-up pace. The base's `top` is the same solve for the
// setup as it stands, so `(top - baseTop) * 3600` is extra Home Coins an hour.

// The smallest gain worth showing, as a share of the base (RANK_MIN_GAIN in worker.js and app.js):
// below it, a difference is as likely to be the solver's tolerances as a real improvement.
export const ROADMAP_MIN_GAIN = 1e-3;

// How many of a facility `tiers` hold, and the highest level among them (copied from app.js).
export const tierCount = tiers => (tiers || []).reduce((sum, t) => sum + (t.count > 0 ? t.count : 0), 0);
export const tierLevel = tiers => Math.max(0, ...(tiers || []).filter(t => t.count > 0).map(t => t.level));

// The value for RV level `homeLevel` in a per-RV list, keeping the last value past its end.
function atHomeLevel(list, homeLevel) {
    if (!Array.isArray(list) || list.length === 0) return 0;
    return list[Math.max(1, Math.min(homeLevel, list.length)) - 1];
}

// Everything a player at `rv` could have (facility-config.js's simpleSetup, on `config`'s data).
export function setupAt(config, rv) {
    if (typeof config.simpleSetup === 'function') return config.simpleSetup(rv);
    const facilities = {};
    for (const f of config.FACILITIES || []) {
        const unlocked = Object.entries(f.unlocks || {}).filter(([, need]) => need <= rv).map(([level]) => Number(level));
        facilities[f.name] = unlocked.length === 0
            ? [{ count: 0, level: 1 }]
            : [{ count: atHomeLevel(f.counts, rv), level: Math.max(...unlocked) }];
    }
    const modules = Object.fromEntries(Object.entries(config.MODULE_MAX_LEVELS || {}).map(([m, caps]) => [m, atHomeLevel(caps, rv)]));
    return { facilities, modules };
}

// Home Coins to raise one `facility` from `from` to `to` (facility-config.js's upgradeCost), or
// null when any step's cost is unknown.
export function upgradeCostOf(config, facility, from, to) {
    if (typeof config.upgradeCost === 'function') return config.upgradeCost(facility, from, to);
    const steps = config.FACILITY_UPGRADE_COSTS?.[facility];
    if (!steps || !Number.isInteger(from) || !Number.isInteger(to) || to <= from) return null;
    let total = 0;
    for (let level = from + 1; level <= to; level++) {
        if (!Number.isInteger(steps[level])) return null;
        total += steps[level];
    }
    return total;
}

const maxHomeLevel = config => (Number.isInteger(config.MAX_HOME_LEVEL) ? config.MAX_HOME_LEVEL : 20);

// The lowest RV level whose facilities and modules cover everything in `input` (copied from
// app.js), for Advanced mode, where the player enters what they have rather than their RV level.
export function homeLevelCovering(input, config) {
    const top = maxHomeLevel(config);
    for (let level = 1; level <= top; level++) {
        const allowed = setupAt(config, level);
        const facilitiesFit = (config.FACILITIES || []).every((f) => {
            const have = input?.facilities?.[f.name];
            if (tierCount(have) === 0) return true;
            const cap = allowed.facilities[f.name];
            return tierCount(have) <= tierCount(cap) && (f.hasLevels === false || tierLevel(have) <= tierLevel(cap));
        });
        const modulesFit = Object.entries(input?.modules || {}).every(([name, at]) => at <= (allowed.modules[name] ?? 0));
        if (facilitiesFit && modulesFit) return level;
    }
    return top;
}

// The RV level the roadmap works within: the one the player has. Simple mode: the plan's RV level
// (its level-up target less one, else `homeLevel`). Advanced mode: `homeLevel` when the setup
// gives one, else the lowest RV covering what was entered (as the Opportunities card does); never
// below that covering level, since what was entered must already be allowed. A level-up target
// is not used there: it can be several RV levels ahead.
export function roadmapHomeLevel(input, { config, simple = false, homeLevel = null, context = null } = {}) {
    const top = maxHomeLevel(config);
    const clamp = rv => Math.max(1, Math.min(top, Math.floor(rv)));
    const target = Number(context?.target);
    const given = Number(homeLevel);
    const known = Number.isInteger(given) && given >= 1;
    if (simple) return clamp(Number.isInteger(target) && target > 1 ? target - 1 : (known ? given : top));
    const covering = homeLevelCovering(input, config);
    return clamp(known ? Math.max(covering, given) : covering);
}

// Tiers with equal levels merged, lowest level first.
function mergeTiers(tiers) {
    const byLevel = new Map();
    for (const t of tiers) if (t.count > 0) byLevel.set(t.level, (byLevel.get(t.level) || 0) + t.count);
    return [...byLevel.entries()].sort((a, b) => a[0] - b[0]).map(([level, count]) => ({ count, level }));
}

const titleCase = name => String(name).split('_').map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');

// Every change within reach of `base` (a plan input), as `{ candidates, deferred }`. Each is
// `{ id, label, kind, facility, level, input, cost, needsRv, items, note }`; `kind` is 'upgrade'
// (one unit up a level), 'upgrade-all' (every lowest unit up a level), 'build' (one more, at
// level 1, cost not listed) or 'next-rv' (Simple mode: everything the next RV level allows,
// priced at its level-up coins; `items` are its other costs, not priced). An upgrade whose next
// level needs a higher RV than `homeLevel` has `needsRv` and `input: null`: shown, not solved.
// `candidates` holds the first `maxCandidates` solvable changes, cheapest first (a build, with
// no listed cost, counts as cheapest; an upgrade of unknown cost as dearest), then the needsRv
// ones; `deferred` holds the solvable rest, in the same order. `format` ({ item, number }) words
// the next-RV note.
export function roadmapCandidates(base, { config, homeLevel, simple = false, maxCandidates = 20, format = {} } = {}) {
    const itemName = typeof format.item === 'function' ? format.item : titleCase;
    const number = typeof format.number === 'function' ? format.number : n => Number(n).toLocaleString('en-US');
    const rv = Math.max(1, Math.floor(Number(homeLevel) || 1));
    const solvable = [];
    const unsolved = [];
    const facilities = base?.facilities || {};
    for (const f of config.FACILITIES || []) {
        const tiers = mergeTiers(facilities[f.name] || []);
        const k = tierCount(tiers);
        if (k === 0) continue;
        const withTiers = next => ({ ...base, facilities: { ...facilities, [f.name]: mergeTiers(next) } });
        const top = Math.max(0, ...Object.keys(f.unlocks || {}).map(Number));
        if (f.hasLevels !== false && tiers[0].level < top) {
            const from = tiers[0].level;
            const to = from + 1;
            const need = f.unlocks[to];
            const one = upgradeCostOf(config, f.name, from, to);
            const label = k > 1 ? `1 ${f.name} to Lv ${to}` : `${f.name} to Lv ${to}`;
            if (Number.isFinite(need) && need > rv) {
                unsolved.push({ id: `upgrade:${f.name}:${to}`, label, kind: 'upgrade', facility: f.name, level: to, input: null, cost: one, needsRv: need });
            } else {
                const raised = [{ count: tiers[0].count - 1, level: from }, ...tiers.slice(1), { count: 1, level: to }];
                solvable.push({ id: `upgrade:${f.name}:${to}`, label, kind: 'upgrade', facility: f.name, level: to, input: withTiers(raised), cost: one, needsRv: null });
                const m = tiers[0].count;
                if (m > 1) {
                    solvable.push({
                        id: `upgrade-all:${f.name}:${to}`,
                        label: m === k ? `All ${k} ${f.name} to Lv ${to}` : `${m} ${f.name} (Lv ${from}) to Lv ${to}`,
                        kind: 'upgrade-all', facility: f.name, level: to,
                        input: withTiers([{ count: m, level: to }, ...tiers.slice(1)]),
                        cost: one === null ? null : one * m, needsRv: null,
                    });
                }
            }
        }
        if (k < atHomeLevel(f.counts, rv)) {
            solvable.push({
                id: `build:${f.name}`, label: f.hasLevels === false ? `+1 ${f.name}` : `+1 ${f.name} (Lv 1)`,
                kind: 'build', facility: f.name, level: 1, input: withTiers([...tiers, { count: 1, level: 1 }]), cost: null, needsRv: null,
            });
        }
    }
    const next = config.LEVEL_UP_COSTS?.[rv + 1];
    if (simple && rv < maxHomeLevel(config) && next && Number.isFinite(next.coins)) {
        const items = (next.items || []).filter(([, n]) => n > 0);
        const needs = items.map(([name, n]) => `${number(n)} ${itemName(name)}`).join(' and ');
        solvable.push({
            id: `next-rv:${rv + 1}`, label: `Next RV: ${rv + 1}`, kind: 'next-rv', facility: null, level: rv + 1,
            input: { ...base, ...setupAt(config, rv + 1) },
            cost: next.coins, needsRv: null, items,
            note: `${needs ? `Also needs ${needs}. ` : ''}The gain assumes you build and upgrade every facility and module RV ${rv + 1} allows; those costs are not counted.`,
        });
    }
    const capOrder = c => (c.kind === 'build' && c.cost === null ? -1 : c.cost === null ? Infinity : c.cost);
    const ordered = solvable.map((c, i) => ({ c, i })).sort((a, b) => capOrder(a.c) - capOrder(b.c) || a.i - b.i).map(x => x.c);
    const cap = Math.max(0, Math.floor(Number(maxCandidates) || 0));
    unsolved.sort((a, b) => a.needsRv - b.needsRv);
    return { candidates: [...ordered.slice(0, cap), ...unsolved], deferred: ordered.slice(cap) };
}

// The status line when there is nothing to solve (no solvable change shown or deferred), else
// null: the lowest RV level a shown upgrade waits for, or that everything owned is at its top.
export function emptyRoadmapStatus(candidates, deferred, homeLevel, { simple = false } = {}) {
    const list = candidates || [];
    if (list.some(c => c.input) || (deferred || []).length > 0) return null;
    const waits = list.map(c => c.needsRv).filter(Number.isFinite);
    if (waits.length > 0) return `Nothing can be upgraded until RV ${Math.min(...waits)}.`;
    return `Everything you own is at its top level for RV ${homeLevel}${simple ? ', and there is no next RV to plan' : ''}.`;
}

// The next batch to solve, up to `max`: shown candidates with no answer yet (stopped or timed out
// before theirs came), then deferred ones. `results` are keyed by id (an object or a Map).
// `{ batch, deferred }`, `deferred` without those taken.
export function nextBatch(shown, deferred, results, max = 20) {
    const answered = c => resultFor(results, c, -1) !== undefined;
    const retry = (shown || []).filter(c => c.input && !answered(c)).slice(0, max);
    const fresh = (deferred || []).slice(0, Math.max(0, max - retry.length));
    return { batch: [...retry, ...fresh], deferred: (deferred || []).slice(fresh.length) };
}

// How many solvable changes still have no answer: shown ones not answered, plus the deferred.
export function remainingCount(shown, deferred, results) {
    return (shown || []).filter(c => c.input && resultFor(results, c, -1) === undefined).length + (deferred || []).length;
}

// `results` by position (an array lined up with the candidates), by id (an object or a Map).
function resultFor(results, candidate, i) {
    if (Array.isArray(results)) return i >= 0 ? results[i] : undefined;
    if (results instanceof Map) return results.get(candidate.id);
    return results ? results[candidate.id] : undefined;
}

const GROUP = { gain: 0, pending: 2, 'no-gain': 3, failed: 4, 'needs-rv': 5 };

// One row per candidate, best first: `{ id, label, kind, note, cost, needsRv, status,
// gainPerHour, paybackHours, affordInHours, proven }`. `results` line up with `candidates` (or
// are keyed by id); each is rank's `{ top, proven }`, null when no plan came back, undefined
// while it hasn't been answered. `baseTop` is the base's `top` (Home Coins a second);
// `coinsPerHour` the plan's income now, for `affordInHours` (hours to earn the cost from zero).
// `status`: 'gain', 'no-gain' (under ROADMAP_MIN_GAIN of the base), 'pending', 'failed' (no
// plan, or no base to compare with) or 'needs-rv'. `proven` is false when the solver ran out of
// time on this change or on the base (the card marks the gain with "~").
// Order: gains with a known cost by payback, then gains of unknown cost by gain, then pending,
// no gain, failed, and needs-RV changes last (lowest RV first).
export function scoreRoadmap(candidates, baseTop, results, { coinsPerHour = null, baseProven = true } = {}) {
    const base = Number.isFinite(baseTop) ? baseTop : null;
    const income = Number(coinsPerHour) > 0 ? Number(coinsPerHour) : null;
    const rows = (candidates || []).map((c, i) => {
        const cost = Number.isFinite(c.cost) ? c.cost : null;
        const row = {
            id: c.id, label: c.label, kind: c.kind, note: c.note || null, cost, needsRv: c.needsRv ?? null,
            status: 'pending', gainPerHour: null, paybackHours: null, affordInHours: null, proven: null, order: i,
        };
        if (row.needsRv !== null || !c.input) {
            row.status = 'needs-rv';
            return row;
        }
        row.affordInHours = cost !== null && income ? cost / income : null;
        const result = resultFor(results, c, i);
        if (result === undefined) return row;
        if (!result || !Number.isFinite(result.top) || base === null) {
            row.status = 'failed';
            return row;
        }
        row.proven = result.proven !== false && baseProven !== false;
        const delta = result.top - base;
        if (delta > Math.abs(base) * ROADMAP_MIN_GAIN + 1e-12) {
            row.status = 'gain';
            row.gainPerHour = delta * 3600;
            row.paybackHours = cost !== null ? cost / row.gainPerHour : null;
        } else {
            row.status = 'no-gain';
            row.gainPerHour = 0;
        }
        return row;
    });
    const group = r => (r.status === 'gain' ? (r.paybackHours !== null ? 0 : 1) : GROUP[r.status]);
    return rows.sort((a, b) => group(a) - group(b)
        || (group(a) === 0 ? a.paybackHours - b.paybackHours || b.gainPerHour - a.gainPerHour : 0)
        || (group(a) === 1 ? b.gainPerHour - a.gainPerHour : 0)
        || (group(a) === 5 ? a.needsRv - b.needsRv : 0)
        || a.order - b.order);
}
