// Roster advisor: for a player planning with "My Aniimo" (their own roster), which Aniimo is the
// weakest link and which change to the team would help most. Pure functions only (no DOM, no
// storage, no imports); the card is web/cards/roster-advisor.js and the tests are
// tests/roster-advisor.test.mjs.
//
// Inputs are plan inputs as the 'plan' topic carries them (planSnapshot in app.js). In My Aniimo
// mode they hold `aniimo: 'roster'` and `roster: { members: [{ count, abilities: { Fire: 3 },
// personalities: [...] }], residents, environment: { 'Heat Furnace': 'Fire', ... },
// personalities }` (rosterPayload in app.js, JsRoster in src/wasm.rs).
//
// What the numbers mean (rankImprovements in worker.js): a result's `top` is the best the planner
// gets of the measure the plan leads with: Home Coins per second for 'coins', that target per
// second for another priority, or level-ups per day for 'level_up' (PACE_UNIT = 86400 in
// src/exact.rs, so the level-up takes 86400 / top seconds). `coins` ({ base, value }, per second)
// comes only when the measure doesn't move: the most Home Coins while keeping it.

// The smallest change worth showing, as a share of the base (RANK_MIN_GAIN in worker.js).
export const ADVISOR_MIN_GAIN = 1e-3;
export const PACE_UNIT_SECONDS = 86400;
// Abilities whose top level in game is below the usual 4 (ABILITY_DEFAULTS in app.js).
export const ABILITY_CAPS = { Perfumery: 3 };
// The ability that waters crops and trees (WATERING_ABILITY in src/models.rs); it only speeds them up.
export const WATERING_ABILITY = 'Water';

// What a change is measured by (rankMeasure in app.js): level-up time for a level-up plan that
// can be worked toward, else the first ranked priority, else Home Coins.
export function measureFor(input, context) {
    if (context?.levelUp && !context.unavailable && !context.ready) return 'level_up';
    return (input?.priorities || [])[0] || 'coins';
}

const MEASURE_LABELS = { coins: 'Home Coins', level_up: 'level-up time', aniimo_exp: 'Aniimo EXP', aniipods: 'Aniipods' };
export function measureLabel(measure, seasonPoints = 'season points') {
    if (measure === 'season_points') return seasonPoints;
    return MEASURE_LABELS[measure] || String(measure);
}

// Ability requirement rows `{ name, facility, facility_level, season, ability, min_level }` from
// the worker's get_all_items (ctx.items()): each recipe's `aniimo` ([ability, min level], from
// data/aniimo_requirements.csv), each crop or tree job in `jobs` ([step, ability, min level], from
// data/grower_steps.csv), and watering for every crop and tree.
export function requirementsFromItems(items) {
    const rows = [];
    for (const item of Array.isArray(items) ? items : []) {
        if (!item?.facility) continue;
        const base = { name: item.name, facility: item.facility, facility_level: Number(item.facility_level) || 1, season: !!item.season };
        const aniimo = Array.isArray(item.aniimo) ? { ability: item.aniimo[0], level: item.aniimo[1] } : item.aniimo;
        if (aniimo?.ability) rows.push({ ...base, ability: aniimo.ability, min_level: Number(aniimo.level) || 1 });
        const jobs = Array.isArray(item.jobs) ? item.jobs : [];
        for (const job of jobs) if (Array.isArray(job) && job[1]) rows.push({ ...base, ability: job[1], min_level: Number(job[2]) || 1 });
        if (jobs.length > 0) rows.push({ ...base, ability: WATERING_ABILITY, min_level: 1 });
    }
    return rows;
}

// The abilities the owned facilities (and environment buildings) can use, as a Set in the game's
// ability order (`config.abilities`). `requirements` is a list of `{ facility, ability, min_level }`
// (optionally `name`, `facility_level`, `season`): a row counts when its facility is owned at that
// level, its recipe isn't excluded and, for a season recipe, the season is on. An owned facility
// with no row at all falls back to its own `ability` in `config.FACILITIES`. Environment buildings
// take the ability in `input.roster.environment` (or `config.environment`).
export function neededAbilities(input, config = {}, requirements = []) {
    const owned = new Map();
    for (const [name, tiers] of Object.entries(input?.facilities || {})) {
        const live = (Array.isArray(tiers) ? tiers : []).filter(t => t && t.count > 0);
        if (live.length > 0) owned.set(name, Math.max(...live.map(t => Number(t.level) || 1)));
    }
    const excluded = new Set(input?.exclude || []);
    const rows = Array.isArray(requirements) ? requirements : [];
    const found = new Set();
    for (const r of rows) {
        if (!r?.ability || !owned.has(r.facility)) continue;
        if (r.name && excluded.has(r.name)) continue;
        if (r.season && !input?.season) continue;
        if (Number(r.facility_level) > owned.get(r.facility)) continue;
        found.add(r.ability);
    }
    const listed = new Set(rows.map(r => r?.facility));
    for (const f of config?.FACILITIES || []) if (f.ability && owned.has(f.name) && !listed.has(f.name)) found.add(f.ability);
    for (const [building, ability] of Object.entries(input?.roster?.environment || config?.environment || {})) {
        if (owned.has(building) && ability) found.add(ability);
    }
    const order = config?.abilities || [];
    const at = a => (order.includes(a) ? order.indexOf(a) : order.length);
    return new Set([...found].sort((a, b) => at(a) - at(b)));
}

// How many Aniimo the homeland holds (ANIIMO_MAX, index = RV level - 1), or null when unknown.
// Simple mode: the RV level input. Advanced mode only knows it from a level-up target (INFERRED:
// someone working toward RV n is at RV n - 1).
export function homeCapFor({ config, simple = false, homeLevel = null, context = null } = {}) {
    const list = config?.ANIIMO_MAX;
    if (!Array.isArray(list) || list.length === 0) return null;
    const target = Number(context?.target);
    const rv = simple ? Number(homeLevel) : (context?.levelUp && Number.isInteger(target) && target > 1 ? target - 1 : null);
    if (!Number.isInteger(rv) || rv < 1) return null;
    const cap = list[Math.min(rv, list.length) - 1];
    return Number.isFinite(cap) && cap > 0 ? cap : null;
}

const describe = (member, i) => {
    const abilities = Object.entries(member?.abilities || {}).map(([a, l]) => `${a} ${l}`).join(', ');
    return abilities ? `${abilities} Aniimo` : `Aniimo ${i + 1}`;
};

// The changes to try, as `{ id, label, kind, input, overCap, who? }`: the Best team as a reference
// ('best'), each member left out ('remove': one fewer of several alike), each member a level higher
// in every needed ability below its top ('level': of several alike, one), and a new Aniimo for each
// needed ability nobody has, at level 1 and at the top ('add', no personality bonus). A member with
// none of the needed abilities isn't tried (Hauling, for one, isn't planned, so leaving it out
// would look free). At most `maxCandidates`: reference, then removes, then levels, then adds.
export function rosterCandidates(base, { neededAbilities: needed = [], maxLevel = 4, homeCap = null, maxCandidates = 30, names = [], abilityCaps = ABILITY_CAPS } = {}) {
    const members = base?.roster?.members || [];
    const neededList = [...(needed || [])];
    const neededSet = new Set(neededList);
    const uses = ability => neededSet.size === 0 || neededSet.has(ability);
    const topLevel = ability => Math.min(maxLevel, abilityCaps?.[ability] ?? maxLevel);
    const total = members.reduce((sum, m) => sum + Math.max(0, Number(m?.count) || 0), 0);
    const cap = Number.isFinite(homeCap) && homeCap > 0 ? homeCap : null;
    const withMembers = list => ({ ...base, roster: { ...base.roster, members: list } });
    const lessOne = i => members.map((m, k) => (k === i ? { ...m, count: m.count - 1 } : m));
    const removes = [];
    const levels = [];
    members.forEach((m, i) => {
        if (!(m?.count > 0)) return;
        const abilities = Object.entries(m.abilities || {}).filter(([a, l]) => l > 0 && uses(a));
        if (abilities.length === 0) return;
        const who = String(names[i] || '').trim() || describe(m, i);
        const several = m.count > 1;
        removes.push({
            id: `remove:${i}`, kind: 'remove', who, overCap: false,
            label: several ? `One fewer ${who} (of ${m.count})` : `Without ${who}`,
            input: withMembers(several ? lessOne(i) : members.filter((_, k) => k !== i)),
        });
        const raise = abilities.filter(([a, l]) => l < topLevel(a));
        if (raise.length === 0) return;
        const trained = { ...m, count: 1, abilities: { ...m.abilities, ...Object.fromEntries(raise.map(([a, l]) => [a, l + 1])) } };
        levels.push({
            id: `level:${i}`, kind: 'level', who, overCap: false,
            label: `${several ? 'One ' : ''}${who} a level higher (${raise.map(([a, l]) => `${a} ${l} to ${l + 1}`).join(', ')})`,
            input: withMembers(several ? [...lessOne(i), trained] : members.map((x, k) => (k === i ? trained : x))),
        });
    });
    const have = new Set(members.filter(m => m?.count > 0).flatMap(m => Object.entries(m.abilities || {}).filter(([, l]) => l > 0).map(([a]) => a)));
    const adds = [];
    for (const ability of neededList.filter(a => !have.has(a))) {
        for (const level of [...new Set([1, topLevel(ability)])]) {
            adds.push({
                id: `add:${ability}:${level}`, kind: 'add', label: `New ${ability} Aniimo Lv.${level}`,
                overCap: cap !== null && total + 1 > cap,
                input: withMembers([...members, { count: 1, abilities: { [ability]: level }, personalities: [] }]),
            });
        }
    }
    const reference = {
        id: 'best', kind: 'best', label: 'Best team (reference)', overCap: false,
        input: { ...base, aniimo: 'best', roster: undefined, aniimo_levels: {} },
    };
    return [reference, ...removes, ...levels, ...adds].slice(0, Math.max(0, maxCandidates));
}

// `{ top, proven }` from a number, a rank answer (`top`) or a plan's measure_top (`objective`).
function topOf(value) {
    if (typeof value === 'number') return { top: Number.isFinite(value) ? value : null, proven: true };
    const top = value?.top ?? value?.objective;
    return { top: Number.isFinite(top) ? top : null, proven: value?.proven !== false };
}

// One row per answered candidate (the reference and unanswered ones left out), best first. Each:
// `{ id, label, kind, who, overCap, status: 'ok'|'none', proven, top, change (share of the base),
// flat, delta (per hour of the measure, or hours sooner for 'level_up'), hoursSaved,
// levelUpSeconds, coinsPerHour, coinsDelta, coinsChange, tier, score, note }`. Sorted by tier (2:
// the measure goes up, 1: it stays and the Home Coins decide, 0: it goes down, -1: no plan), then
// score.
export function rankRows(candidates, baseTop, results, measure) {
    const base = topOf(baseTop);
    const known = base.top !== null;
    const rows = [];
    (candidates || []).forEach((c, i) => {
        const result = results?.[i];
        if (!c || c.kind === 'best' || result === undefined) return;
        const row = { id: c.id, label: c.label, kind: c.kind, who: c.who, overCap: !!c.overCap, note: '' };
        const top = Number.isFinite(result?.top) ? result.top : null;
        if (top === null) {
            rows.push({ ...row, status: 'none', tier: -1, score: 0, note: c.kind === 'remove' ? 'no plan without it' : '' });
            return;
        }
        const change = !known ? 0 : base.top > 0 ? (top - base.top) / base.top : (top > 0 ? 1 : 0);
        Object.assign(row, { status: 'ok', proven: result.proven !== false && base.proven, top, change, flat: !known || Math.abs(change) <= ADVISOR_MIN_GAIN });
        row.levelUpSeconds = null;
        row.hoursSaved = null;
        if (measure === 'level_up') {
            row.levelUpSeconds = top > 0 ? PACE_UNIT_SECONDS / top : null;
            const before = known && base.top > 0 ? PACE_UNIT_SECONDS / base.top : null;
            row.hoursSaved = before !== null && row.levelUpSeconds !== null ? (before - row.levelUpSeconds) / 3600 : null;
            row.delta = row.hoursSaved;
        } else {
            row.delta = known ? (top - base.top) * 3600 : null;
        }
        row.coinsPerHour = null;
        row.coinsDelta = null;
        row.coinsChange = null;
        if (measure === 'coins') {
            Object.assign(row, { coinsPerHour: top * 3600, coinsDelta: row.delta, coinsChange: known ? change : null });
        } else if (Number.isFinite(result.coins?.value)) {
            row.coinsPerHour = result.coins.value * 3600;
            if (Number.isFinite(result.coins.base)) {
                row.coinsDelta = (result.coins.value - result.coins.base) * 3600;
                row.coinsChange = result.coins.base > 0 ? (result.coins.value - result.coins.base) / result.coins.base : 0;
            }
        }
        if (!row.flat) {
            row.tier = change > 0 ? 2 : 0;
            row.score = change;
        } else {
            row.tier = 1;
            row.score = row.coinsChange ?? 0;
            if (c.kind === 'remove' && known && Math.abs(row.score) <= ADVISOR_MIN_GAIN) row.note = 'not needed by this plan';
        }
        rows.push(row);
    });
    return rows.sort((a, b) => b.tier - a.tier || b.score - a.score);
}

// The member the plan misses least: the best-placed 'remove' row with a plan (rows as rankRows
// sorts them), or null.
export function weakestLink(rows) {
    return (rows || []).find(r => r.kind === 'remove' && r.status === 'ok') || null;
}

// The roster's measure as a percentage of the Best team's (for 'level_up', the share of its pace),
// or null when either is unknown or the Best team gets nothing.
export function bestShare(baseTop, bestTop) {
    const base = topOf(baseTop).top;
    const best = topOf(bestTop).top;
    if (base === null || !(best > 0)) return null;
    return (base / best) * 100;
}

// Whether a new 'plan' value should stop a check running for `checked` (the plan it started
// from): another Aniimo setup is on screen, or the inputs were solved again (a new setupHash).
// A null value (a setup still solving) stops nothing; the next value decides.
export function stopsCheck(checked, value) {
    if (!checked || !value) return false;
    return value.tab !== 'custom' || value.setupHash !== checked.setupHash;
}
