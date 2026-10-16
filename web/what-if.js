// "What if" sandbox: pure logic for trying a few changes on a copy of the current plan input.
// No DOM, no storage, no imports but plan-summary.js; the card is web/cards/what-if.js and the
// tests are tests/what-if.test.mjs. Nothing here writes the saved profile or a snapshot.
//
// A plan input is what find_plan takes (see getPlanInputValues and aniimoInput in app.js):
//   facilities: { Name: [{ count, level }, ...] }      modules: { ecological_module: n, ... }
//   aniimo: 'best' | 'minimum' | 'roster'              aniimo_levels: { Ability: n }
//   roster: { members: [{ count, abilities: { Ability: n }, personalities: [...] }], ... }
// (rosterPayload, app.js). `config` is ctx.config (see web/panels.js).
//
// Edits: { facilities: { Name: [{ count, level }] }   (replaces that facility's tiers),
//          modules: { id: level }, aniimoLevels: { Ability: n },
//          rosterLevels: { memberIndex: { Ability: n } } }

import { diffPlans, summarizePlan } from './plan-summary.js?v=fork-m9-2';

// A whole number at least `min`, else null.
const whole = (value, min = 0) => {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : null;
};

// 'Tidewhisper Sandcastle' -> 'tidewhisper-sandcastle': the facility part of the card's input ids.
export const slugOf = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const titleCase = name => String(name).split('_').map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');

// A deep copy of `base` with `edits` applied; only what `edits` names changes, and `base` itself
// is never touched. A roster edit sets the level on that member's own `abilities` (a member that
// does not exist is skipped).
export function applyEdits(base, edits = {}) {
    const input = structuredClone(base ?? {});
    for (const [name, tiers] of Object.entries(edits?.facilities || {})) {
        if (!Array.isArray(tiers)) continue;
        input.facilities ||= {};
        input.facilities[name] = tiers
            .map(t => ({ count: whole(t?.count), level: whole(t?.level, 1) }))
            .filter(t => t.count !== null && t.level !== null);
    }
    for (const [id, level] of Object.entries(edits?.modules || {})) {
        const n = whole(level);
        if (n === null) continue;
        input.modules ||= {};
        input.modules[id] = n;
    }
    for (const [ability, level] of Object.entries(edits?.aniimoLevels || {})) {
        const n = whole(level, 1);
        if (n === null) continue;
        input.aniimo_levels ||= {};
        input.aniimo_levels[ability] = n;
    }
    for (const [index, levels] of Object.entries(edits?.rosterLevels || {})) {
        const member = input.roster?.members?.[Number(index)];
        if (!member) continue;
        for (const [ability, level] of Object.entries(levels || {})) {
            const n = whole(level, 1);
            if (n === null) continue;
            member.abilities ||= {};
            member.abilities[ability] = n;
        }
    }
    return input;
}

// The value for RV level `rv` in a per-RV list, keeping the last value past its end (null if none).
const atRv = (list, rv) => (Array.isArray(list) && list.length ? list[Math.min(rv, list.length) - 1] ?? null : null);
const sum = (list, pick) => list.reduce((total, x) => total + (pick(x) > 0 ? pick(x) : 0), 0);

const ownedTiers = (input, name) => (input?.facilities?.[name] || []).filter(t => t.count > 0);
const maxHomeLevel = config => (Number.isInteger(config?.MAX_HOME_LEVEL) ? config.MAX_HOME_LEVEL : 20);

// The lowest RV level with room for every facility `input` owns (the count, and the level's unlock).
export function coveringHomeLevel(input, config) {
    const top = maxHomeLevel(config);
    for (let rv = 1; rv <= top; rv++) {
        const fits = (config?.FACILITIES || []).every((f) => {
            const tiers = ownedTiers(input, f.name);
            if (tiers.length === 0) return true;
            const cap = atRv(f.counts, rv);
            if (cap !== null && sum(tiers, t => t.count) > cap) return false;
            return f.hasLevels === false || !(f.unlocks?.[Math.max(...tiers.map(t => t.level))] > rv);
        });
        if (fits) return rv;
    }
    return top;
}

// The RV level the plan is for. Simple mode: the level-up target less one when there is one
// (as the roadmap card does), else `homeLevel`. Advanced mode: the lowest RV covering what is owned.
export function homeLevelFor(input, config, { simple = false, homeLevel = null, target = null } = {}) {
    if (!simple) return coveringHomeLevel(input, config);
    const rv = Number.isInteger(target) && target > 1 ? target - 1 : Math.floor(Number(homeLevel));
    return Math.min(rv >= 1 ? rv : maxHomeLevel(config), maxHomeLevel(config));
}

// Facility types `input` owns none of that RV level `rv` has unlocked and has room for: the ones
// a "what if I build one" can try. In config order.
export function buildableFacilities(input, config, rv) {
    if (!(rv >= 1)) return [];
    return (config?.FACILITIES || [])
        .filter(f => ownedTiers(input, f.name).length === 0
            && Math.min(...Object.values(f.unlocks || {})) <= rv
            && atRv(f.counts, rv) !== 0)
        .map(f => f.name);
}

// Plain-English notes for anything in `input` past what the game allows: more of a facility than
// RV `homeLevel` has room for, a facility or module level above what that RV (or the game) has,
// more Aniimo than the homeland holds. They only inform; nothing blocks a try. Without a usable
// `homeLevel` (Advanced mode) the RV-based checks are skipped and only "above the game's top" shows.
export function warnings(input, config, homeLevel) {
    const out = [];
    const rv = Number(homeLevel) >= 1 ? Math.floor(Number(homeLevel)) : null;
    for (const f of config?.FACILITIES || []) {
        const tiers = (input?.facilities?.[f.name] || []).filter(t => t.count > 0);
        if (tiers.length === 0) continue;
        const count = sum(tiers, t => t.count);
        const cap = rv ? atRv(f.counts, rv) : null;
        if (cap !== null && count > cap) out.push(`${f.name}: ${count} is more than RV ${rv} has room for (${cap}).`);
        if (f.hasLevels === false) continue;
        const unlocks = f.unlocks || {};
        const top = Math.max(0, ...Object.keys(unlocks).map(Number));
        const level = Math.max(...tiers.map(t => t.level));
        if (top > 0 && level > top) out.push(`${f.name}: level ${level} is above the highest level known (${top}).`);
        else if (rv && unlocks[level] > rv) out.push(`${f.name}: level ${level} needs RV ${unlocks[level]}, above RV ${rv}.`);
    }
    for (const [id, level] of Object.entries(input?.modules || {})) {
        const caps = config?.MODULE_MAX_LEVELS?.[id];
        if (!Array.isArray(caps) || caps.length === 0) continue;
        const name = config?.moduleNames?.[id] || titleCase(id);
        const top = Math.max(...caps);
        const allowed = rv ? atRv(caps, rv) : null;
        if (level > top) out.push(`${name}: level ${level} is above the highest level known (${top}).`);
        else if (allowed !== null && level > allowed) out.push(`${name}: level ${level} is more than RV ${rv} allows (${allowed}).`);
    }
    const members = input?.aniimo === 'roster' ? input?.roster?.members : null;
    const room = rv ? atRv(config?.ANIIMO_MAX, rv) : null;
    if (Array.isArray(members) && room !== null) {
        const size = sum(members, m => (Number.isFinite(m?.count) ? m.count : 1));
        if (size > room) out.push(`Aniimo: ${size} is more than RV ${rv} has room for (${room}).`);
    }
    return out;
}

// Two plans in a few numbers: `a` and `b` are summarizePlan's answers; the deltas are b less a
// (null unless both plans worked, and for the level-up unless both have one); `rows` are the
// facility rows that changed (diffPlans), empty unless both plans worked.
export function sideBySide(planA, planB) {
    const a = summarizePlan(planA);
    const b = summarizePlan(planB);
    const delta = (x, y) => (a.ok && b.ok && Number.isFinite(x) && Number.isFinite(y) ? y - x : null);
    return {
        a,
        b,
        deltaCoinsPerHour: delta(a.coinsPerHour, b.coinsPerHour),
        deltaLevelUpSeconds: delta(a.levelUpSeconds, b.levelUpSeconds),
        rows: a.ok && b.ok ? diffPlans(a, b) : [],
    };
}

// Flat form values turned into edits. Keys, pipe-separated:
//   facility|Name|tier|count and facility|Name|tier|level   (a facility's tiers need both)
//   module|id    ability|Ability    roster|memberIndex|Ability
// Values may be strings; blank or non-numeric ones are dropped, and so is a facility tier that
// lacks its count or level (a facility left with no whole tier is not edited at all).
export function editsFromForm(values = {}) {
    const edits = { facilities: {}, modules: {}, aniimoLevels: {}, rosterLevels: {} };
    const tiersOf = {};
    for (const [key, raw] of Object.entries(values || {})) {
        const n = whole(raw);
        if (n === null) continue;
        const [kind, first, second, third] = String(key).split('|');
        if (kind === 'facility' && first && /^\d+$/.test(second || '') && (third === 'count' || third === 'level')) {
            ((tiersOf[first] ||= [])[Number(second)] ||= {})[third] = n;
        } else if (kind === 'module' && first) {
            edits.modules[first] = n;
        } else if (kind === 'ability' && first) {
            edits.aniimoLevels[first] = n;
        } else if (kind === 'roster' && /^\d+$/.test(first || '') && second) {
            (edits.rosterLevels[Number(first)] ||= {})[second] = n;
        }
    }
    for (const [name, tiers] of Object.entries(tiersOf)) {
        const complete = Array.from(tiers).filter(t => t && t.count !== undefined && t.level !== undefined);
        if (complete.length > 0) edits.facilities[name] = complete;
    }
    return edits;
}
