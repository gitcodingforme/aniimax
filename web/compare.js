// Compare homelands: logic for the "Compare homelands" card (web/cards/compare.js). The other
// side's setup comes from a profile file, pasted setup JSON, a share link or one of my own earlier
// snapshots, and lives in memory only. Pure functions only (no DOM, no storage); the config
// (ctx.config) comes in as an argument. Tested in tests/compare.test.mjs.
import { parseProfile } from './profile.js?v=fork-m9-1';
import { diffSetups, isSnapshot } from './history.js?v=fork-m9-1';
import { summarizePlan } from './plan-summary.js?v=fork-m9-1';
import { effectiveSetup } from './setup-input.js?v=fork-m9-1';

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const hasTiers = value => isObject(value) && isObject(value.facilityTiers);

// A setup that came from somewhere other than a file (a share link): `{ setup, actual, source }`.
export function otherFromSetup(setup, source = 'setup') {
    if (!hasTiers(setup)) throw new Error('this is not a homeland setup');
    return { setup, actual: {}, source };
}

// Text from a file or a paste: a profile file (format 'aniimax-profile') or a raw saved setup
// (JSON with `facilityTiers`). Throws a short plain-language reason otherwise.
export function otherFromText(text) {
    if (typeof text !== 'string' || text.trim() === '') throw new Error('there is nothing to read yet');
    let data;
    try {
        data = JSON.parse(text);
    } catch (_) {
        throw new Error('this is not valid JSON (a profile file, a setup, or a share link starting with http)');
    }
    if (isObject(data) && data.format === 'aniimax-profile') {
        const profile = parseProfile(text);
        return { setup: profile.setup, actual: profile.actual, source: 'profile' };
    }
    if (hasTiers(data)) return { setup: data, actual: {}, source: 'setup' };
    throw new Error('this is neither an Aniimax profile nor a homeland setup');
}

// One of my own snapshots (history.js makeSnapshot) as the other side.
export function otherFromSnapshot(snapshot) {
    if (!isSnapshot(snapshot)) throw new Error('this is not a snapshot');
    return { setup: snapshot.setup, actual: snapshot.actual || {}, source: `snapshot of ${snapshot.id.slice(0, 10)}` };
}

function tiersText(tiers) {
    const parts = tiers.filter(t => t.count > 0).map(t => `${t.count}×Lv.${t.level}`);
    return parts.length ? parts.join(' + ') : 'none';
}

const countOf = tiers => tiers.reduce((sum, t) => sum + (t.count > 0 ? t.count : 0), 0);

// "2× Earth 4, Grass 3; 1× Fire 4" for a saved roster, or 'no roster'. Entries without a usable
// count count once.
export function rosterSummary(roster) {
    const list = (Array.isArray(roster) ? roster : []).filter(isObject);
    if (list.length === 0) return 'no roster';
    const total = list.reduce((sum, e) => sum + Math.max(1, Math.round(Number(e.count)) || 1), 0);
    const parts = list.map(e => {
        const count = Math.max(1, Math.round(Number(e.count)) || 1);
        const abilities = Object.entries(isObject(e.abilities) ? e.abilities : {}).map(([a, l]) => `${a} ${l}`).join(', ');
        return `${count}× ${abilities || 'no abilities'}`;
    });
    return `${total} Aniimo: ${parts.join('; ')}`;
}

function rvOf(setup, effective) {
    const value = parseInt(setup?.['home-level'], 10);
    return Number.isInteger(value) && value >= 1 ? value : (effective.simple ? effective.homeLevel : null);
}

// The two setups side by side. `facilities` has a row for every facility either side owns:
// `{ name, a: { count, levels, tiers }, b: ..., same }` (simple mode counts as everything the RV
// level allows); `modules` has `{ id, name, a, b }`; `rv` is `{ a, b }` (null if unknown);
// `roster` is `{ a, b }` as text; `diff` is history.js diffSetups.
export function compareSetups(a, b, config) {
    const ea = effectiveSetup(a, config);
    const eb = effectiveSetup(b, config);
    const side = tiers => ({ count: countOf(tiers), levels: tiersText(tiers), tiers });
    const facilities = [];
    for (const f of config.FACILITIES) {
        const sa = side(ea.facilities[f.name] || []);
        const sb = side(eb.facilities[f.name] || []);
        if (sa.count === 0 && sb.count === 0) continue;
        facilities.push({ name: f.name, a: sa, b: sb, same: sa.levels === sb.levels });
    }
    const modules = (config.modules || Object.keys(ea.modules)).map(id => ({
        id, name: config.moduleNames?.[id] || id, a: ea.modules[id] ?? 0, b: eb.modules[id] ?? 0,
    }));
    return {
        facilities,
        modules,
        rv: { a: rvOf(a, ea), b: rvOf(b, eb) },
        roster: { a: rosterSummary(a?.roster), b: rosterSummary(b?.roster) },
        diff: diffSetups(a, b),
    };
}

const subtract = (x, y) => (Number.isFinite(x) && Number.isFinite(y) ? y - x : null);

// Two solved plans (find_plan results; `a` mine, `b` the other) in a few numbers. `a` and `b` are
// plan-summary.js summaries; the deltas are b minus a (null when either side has no number, for
// instance no level-up in a Priorities plan); `rows` is every producing facility and item either
// plan has: `{ key, facility, item, a, b }` with the facility counts (0 when absent).
export function compareResults(planA, planB) {
    const a = summarizePlan(planA);
    const b = summarizePlan(planB);
    const byKey = new Map(a.rows.map(r => [r.key, { key: r.key, facility: r.facility, item: r.item, a: r.count, b: 0 }]));
    for (const r of b.rows) {
        const known = byKey.get(r.key);
        if (known) known.b = r.count;
        else byKey.set(r.key, { key: r.key, facility: r.facility, item: r.item, a: 0, b: r.count });
    }
    return {
        a,
        b,
        deltaCoinsPerHour: subtract(a.coinsPerHour, b.coinsPerHour),
        deltaLevelUpSeconds: subtract(a.levelUpSeconds, b.levelUpSeconds),
        rows: [...byKey.values()],
    };
}
