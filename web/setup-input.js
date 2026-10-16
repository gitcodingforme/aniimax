// Turns a saved setup (the object currentConfig() in app.js returns, which is also what a profile,
// a snapshot and a share link hold) into the input find_plan wants, without a page. The page builds
// its own plan input with these same functions (app.js getPlanInputValues and aniimoInput call
// planInputFromSetup and aniimoInputFromSetup on currentConfig(), and readStorage calls
// migrateSetup), so there is one copy; the compare card's sameInput check still guards it. Pure
// functions only (no DOM); the config comes in as an argument (ctx.config, app.js pageConfig()).
// Tested in tests/setup_input.test.mjs and, against the page's own load path, in
// tests/plan_input_equivalence.test.mjs.
//
// Each helper names the app.js function whose page state it reads. Not handled here: the old
// "strategy-coins/exp/aniipods" saves from before Priorities (app.js loadInputsFromStorage); the
// page converts those when it loads one, and here they fall back to the default priorities.
// The rules both files use (priority targets, Aniimo levels, environment abilities) are not
// copied: they come from shared.js.

import { ENVIRONMENT_BUILDING_ABILITY, MAX_ANIIMO_LEVEL, PRIORITY_TARGETS, defaultLevelFor } from './shared.js?v=fork-m10-2';
import { EMODE } from './facility-config.js?v=fork-m10-2';

// app.js numberOrDefault: parseInt that keeps a real 0.
function numberOrDefault(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

// Advanced mode's module inputs (index.html), by the field that holds each.
const MODULE_FIELDS = {
    ecological_module: 'ecological-module-level',
    kitchen_module: 'kitchen-module-level',
    resource_detector: 'resource-detector-level',
    crafting_module: 'crafting-module-level',
};

// facility-config.js PERSONALITY_PAIRS: the first name of each pair is app.js's default.
const PERSONALITY_NAMES = [['Instinctive', 'Energetic'], ['Nimble', 'Practical'], ['Faithful', 'Tenacious'], ['Playful', 'Judicious']];

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

// A save made under older names carried forward (app.js readStorage and initApp load every save
// through this): a setup without a mode but with facilities was hand-entered (advanced); Mineral
// Pile became Mine; the Mineral Detector became the Resource Detector. Works on a copy, so the
// caller's setup is never touched.
export function migrateSetup(setup) {
    const data = { ...(isObject(setup) ? setup : {}) };
    if (data['mode-simple'] === undefined && data.facilityTiers) {
        data['mode-simple'] = false;
        data['mode-advanced'] = true;
    }
    if (isObject(data.facilityTiers) && data.facilityTiers.Mine === undefined && data.facilityTiers['Mineral Pile'] !== undefined) {
        data.facilityTiers = { ...data.facilityTiers, Mine: data.facilityTiers['Mineral Pile'] };
    }
    if (data['resource-detector-level'] === undefined && data['mineral-detector-level'] !== undefined) {
        data['resource-detector-level'] = data['mineral-detector-level'];
    }
    return data;
}

// Which radio of a group is on after loadInputsFromStorage has set the saved
// `checked` flags in field order, starting from index.html's default: a true wins over earlier
// ones, a false turns off only the one that is on.
function radioOn(data, ids, defaultId) {
    let on = defaultId;
    for (const id of ids) {
        if (!(id in data)) continue;
        if (data[id]) on = id;
        else if (on === id) on = null;
    }
    return on;
}

// app.js selectedHomeLevel: the RV select, MAX_HOME_LEVEL when blank or not an option.
function rvOf(data, config) {
    const level = numberOrDefault(data['home-level'], config.MAX_HOME_LEVEL);
    return level >= 1 && level <= config.MAX_HOME_LEVEL ? level : config.MAX_HOME_LEVEL;
}

// app.js loadInputsFromStorage: priorities keep their saved order; a target the page
// knows but the save lacks goes last, off. Unknown targets are dropped.
function priorityOrderOf(data) {
    const saved = Array.isArray(data.priorities) ? data.priorities.filter(p => PRIORITY_TARGETS.some(t => t.id === p?.target)) : null;
    if (!saved) return PRIORITY_TARGETS.map(t => ({ target: t.id, on: t.id === 'coins' }));
    const missing = PRIORITY_TARGETS.filter(t => !saved.some(p => p.target === t.id)).map(t => ({ target: t.id, on: false }));
    return [...saved.map(p => ({ target: p.target, on: !!p.on })), ...missing];
}

// app.js seasonAvailable / seasonActive.
function seasonActiveOf(data, config, simple, homeLevel) {
    const available = !simple || homeLevel >= config.SEASON.minHomeLevel;
    return available && !!data['season-on'];
}

// The Moonray Wheat a day the player can spend on seeds; blank means no limit.
function seasonCurrencyOf(data) {
    const value = String(data['season-currency-per-day'] ?? '').trim();
    return value !== '' && Number(value) >= 0 ? Number(value) : null;
}

// E-mode's input (src/wasm.rs JsEmode) from Advanced mode's generator fields (index.html): the
// checkbox `emode-on`, `emode-generator-level` (1 to 5), `emode-generator-count` and `emode-supply`
// ('100' or '120'), saved by currentConfig() like every persisted field (a checkbox as true/false,
// the others as text). `{ generators: [{ level, count }], supply }` only when E-mode is ticked with
// at least one generator in Advanced mode at RV EMODE.minHomeLevel (12) or above; otherwise
// undefined, so the input has no `emode` key and the plan is exactly the one without E-mode. The
// level is held to the generator's levels (1 to 5) and the count to the most generators any RV
// allows (EMODE.maxGenerators, 3), so a typo can't plan a budget no homeland has. `config.EMODE`
// when the config carries it, else facility-config.js's (fan data, INFERRED).
function emodeOf(data, config, eff) {
    const emode = config?.EMODE || EMODE;
    if (eff.simple || !data['emode-on'] || eff.homeLevel < emode.minHomeLevel) return undefined;
    const most = Math.max(...Object.values(emode.maxGenerators));
    const count = Math.min(most, numberOrDefault(data['emode-generator-count'], 0));
    if (!(count > 0)) return undefined;
    const level = Math.min(emode.generatorCapacity.length, Math.max(1, numberOrDefault(data['emode-generator-level'], 1)));
    return { generators: [{ level, count }], supply: String(data['emode-supply']) === '120' ? '120' : '100' };
}

// app.js initFacilityTiers: the saved tiers per
// facility (defaults for a missing one), a facility without levels always at level 1.
function advancedFacilities(data, config) {
    const facilities = {};
    for (const f of config.FACILITIES) {
        const saved = isObject(data.facilityTiers) ? data.facilityTiers[f.name] : null;
        const tiers = Array.isArray(saved) && saved.length > 0
            ? saved.map(t => ({ count: numberOrDefault(t?.count, 0), level: f.hasLevels === false ? 1 : numberOrDefault(t?.level, 1) }))
            : [{ count: f.defaultCount, level: 1 }];
        facilities[f.name] = tiers.map(t => ({ count: t.count, level: f.hasLevels === false ? 1 : t.level }));
    }
    return facilities;
}

// What a setup means for the plan, before strategy and Aniimo: `{ simple, homeLevel, facilities,
// modules }`. Simple mode builds everything the RV level allows (facility-config.js simpleSetup);
// advanced reads the saved tiers and module levels (app.js initFacilityTiers).
export function effectiveSetup(setup, config, { homeLevel = null } = {}) {
    const data = migrateSetup(setup);
    const simple = radioOn(data, ['mode-simple', 'mode-advanced'], 'mode-simple') === 'mode-simple';
    const rv = Number.isInteger(homeLevel) && homeLevel >= 1 ? homeLevel : rvOf(data, config);
    if (simple) return { simple, homeLevel: rv, ...config.simpleSetup(rv) };
    const modules = {};
    for (const [key, field] of Object.entries(MODULE_FIELDS)) modules[key] = numberOrDefault(data[field], 0);
    return { simple, homeLevel: rv, facilities: advancedFacilities(data, config), modules };
}

// app.js loadInputsFromStorage: the roster as the page holds it after loading.
function rosterOf(data, config) {
    if (!Array.isArray(data.roster)) return [];
    const known = new Set(config.abilities);
    const levelOk = level => Number.isInteger(Number(level)) && level >= 1 && level <= MAX_ANIIMO_LEVEL;
    return data.roster
        .filter(a => a && typeof a === 'object' && a.abilities && typeof a.abilities === 'object')
        .map(a => ({
            count: Math.max(1, Math.round(Number(a.count)) || 1),
            abilities: Object.fromEntries(Object.entries(a.abilities)
                .filter(([ability, level]) => known.has(ability) && levelOk(level))
                .map(([ability, level]) => [ability, Number(level)])),
            personalities: PERSONALITY_NAMES.map((names, p) => (names.includes(a.personalities?.[p]) ? a.personalities[p] : names[0])),
        }));
}

// app.js loadInputsFromStorage: the saved ability levels, 1 to 4 and known abilities only.
function aniimoLevelsOf(data, config) {
    if (!isObject(data.aniimoLevels)) return {};
    const known = new Set(config.abilities);
    return Object.fromEntries(Object.entries(data.aniimoLevels)
        .filter(([ability, level]) => known.has(ability) && Number.isInteger(Number(level)) && level >= 1 && level <= MAX_ANIIMO_LEVEL)
        .map(([ability, level]) => [ability, Number(level)]));
}

// app.js selectedSetupTab: which of Best, Minimum and My Aniimo the setup has on.
export function aniimoTabOf(setup) {
    const on = radioOn(migrateSetup(setup), ['aniimo-best', 'aniimo-minimum', 'aniimo-custom'], 'aniimo-best');
    return on === 'aniimo-minimum' ? 'minimum' : on === 'aniimo-custom' ? 'custom' : 'best';
}

// The Aniimo half of the input (app.js levelledAbilities and bestAniimoLevel; JsRoster in
// src/wasm.rs). 'custom' sends the roster, the others the per-ability levels.
function aniimoInput(tab, data, config) {
    if (tab === 'custom') {
        return {
            aniimo: 'roster',
            roster: {
                members: rosterOf(data, config),
                residents: config.FACILITIES.filter(f => f.category === 'Aniimo Materials').map(f => f.name),
                environment: { ...ENVIRONMENT_BUILDING_ABILITY },
                personalities: Object.fromEntries(config.FACILITIES.filter(f => f.personality).map(f => [f.name, f.personality])),
            },
            aniimo_levels: {},
        };
    }
    const used = new Set(config.FACILITIES.map(f => f.ability).filter(Boolean));
    const saved = aniimoLevelsOf(data, config);
    const levels = {};
    config.abilities.filter(name => used.has(name)).forEach(ability => { levels[ability] = saved[ability] ?? defaultLevelFor(ability); });
    return { aniimo: tab, aniimo_levels: levels };
}

// app.js bestAniipod: the best Aniipod the owned Aniipod Maker can make, or null.
function bestAniipodOf(eff, config) {
    const level = Math.max(0, ...(eff.facilities['Aniipod Maker'] || []).filter(t => t.count > 0).map(t => t.level));
    return level > 0 ? config.ANIIPOD_TIERS[Math.min(level, config.ANIIPOD_TIERS.length) - 1] : null;
}

// app.js levelUpTarget: the next RV level in simple mode, the saved target in advanced (it follows
// RV + 1 until one is saved); null if its cost is unknown. Known edge: a saved target that is not
// in LEVEL_UP_COSTS is used as it is here, while the page's select drops it and plans for RV 7.
function levelUpOf(data, config, eff) {
    let target;
    if (eff.simple) target = eff.homeLevel + 1;
    else if ('level-up-target' in data) target = numberOrDefault(data['level-up-target'], 7);
    else target = config.LEVEL_UP_COSTS[eff.homeLevel + 1] ? eff.homeLevel + 1 : Number(Object.keys(config.LEVEL_UP_COSTS)[0]);
    const cost = config.LEVEL_UP_COSTS[target];
    if (target > config.MAX_HOME_LEVEL || !cost) return null;
    // app.js stockNames and stockAmount: coins, and each chain up to the tier needed.
    const names = ['coins'];
    cost.items.forEach(([item]) => {
        const chain = config.LEVEL_UP_CHAINS.find(c => c.includes(item));
        if (chain) names.push(...chain.slice(0, chain.indexOf(item) + 1));
    });
    const amount = name => {
        const n = Number(isObject(data.levelUpStock) ? data.levelUpStock[name] : 0);
        return Number.isFinite(n) && n > 0 ? n : 0;
    };
    return { cost: [['coins', cost.coins], ...cost.items], stock: names.filter(name => amount(name) > 0).map(name => [name, amount(name)]) };
}

// The find_plan input for a saved setup (app.js getPlanInputValues sends this without its Aniimo
// half, which aniimoInput adds per setup; planSnapshot shows both). Options: `homeLevel` overrides the RV level, `aniimoTab`
// ('best', 'minimum' or 'custom') overrides the setup's own pick.
export function planInputFromSetup(setup, config, { homeLevel = null, aniimoTab = null } = {}) {
    const data = migrateSetup(setup);
    const eff = effectiveSetup(data, config, { homeLevel });
    // app.js activePriorities / shownPriorities: only while Priorities is the strategy.
    const strategy = radioOn(data, ['strategy-level-up', 'strategy-priorities'], 'strategy-level-up');
    const season = seasonActiveOf(data, config, eff.simple, eff.homeLevel);
    const priorities = strategy === 'strategy-priorities'
        ? priorityOrderOf(data)
            .filter(p => season || !PRIORITY_TARGETS.find(t => t.id === p.target)?.season)
            .filter(p => p.on).map(p => p.target)
        : [];
    // Skips, locked special recipes, and (when going for Aniipods) every Aniipod tier but the best one.
    const unlocked = new Set(Array.isArray(data.unlockedSpecial) ? data.unlockedSpecial.filter(n => typeof n === 'string') : []);
    const skipped = Array.isArray(data.skippedRecipes) ? data.skippedRecipes.filter(n => typeof n === 'string') : [];
    const locked = [...config.SPECIAL_RECIPES, ...config.SEASON.recipeNotes].map(r => r.name).filter(name => !unlocked.has(name));
    const best = priorities.includes('aniipods') ? bestAniipodOf(eff, config) : null;
    const lesser = best ? config.ANIIPOD_TIERS.filter(name => name !== best) : [];
    const emode = emodeOf(data, config, eff);
    return {
        currency: 'coins',
        priorities,
        prioritize_byproducts: false,
        level_up: strategy === 'strategy-level-up' ? levelUpOf(data, config, eff) : null,
        exclude: [...new Set([...skipped, ...locked, ...lesser])],
        season,
        season_currency_per_day: seasonCurrencyOf(data),
        facilities: eff.facilities,
        modules: eff.modules,
        ...aniimoInput(aniimoTab || aniimoTabOf(data), data, config),
        // Only with E-mode on: no key at all otherwise (see emodeOf).
        ...(emode ? { emode } : {}),
    };
}

// What the player picked themselves in a saved setup, which the page then leaves alone (app.js
// loadInputsFromStorage): `levelUpTargetChosen` when a level-up target is saved, RV + 1 has a
// level-up cost, and the target is not RV + 1 (a saved RV + 1 is just the target having followed
// the RV level); `rateUnitChosen` when the saved rate unit is not index.html's default 'second'
// (currentConfig() saves the select every time, so its mere presence says nothing). Edge: a player
// who picked 'second' on purpose can still be switched by the next plan. No saved flag of its
// own, so the saved shape is unchanged.
export function savedChoices(setup, config) {
    const data = migrateSetup(setup);
    const rv = rvOf(data, config);
    const next = rv + 1;
    const target = 'level-up-target' in data ? numberOrDefault(data['level-up-target'], NaN) : NaN;
    return {
        levelUpTargetChosen: 'level-up-target' in data && !!config.LEVEL_UP_COSTS?.[next] && target !== next,
        rateUnitChosen: 'rate-unit' in data && data['rate-unit'] !== 'second' && data['rate-unit'] !== '',
    };
}

// Just the Aniimo half of planInputFromSetup for `tab` ('best', 'minimum' or 'custom'):
// `{ aniimo, aniimo_levels }`, plus `roster` for 'custom'.
export function aniimoInputFromSetup(setup, config, tab) {
    return aniimoInput(tab, migrateSetup(setup), config);
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

// Whether two plan inputs are the same, ignoring key order and keys that are undefined.
export function sameInput(a, b) {
    return stableJson(JSON.parse(JSON.stringify(a ?? null))) === stableJson(JSON.parse(JSON.stringify(b ?? null)));
}

// The top-level keys whose values differ between two plan inputs (sorted), for the compare card's
// drift warning: ['level_up', 'priorities'] says where setup-input.js and app.js disagree.
export function differingKeys(a, b) {
    const x = JSON.parse(JSON.stringify(a ?? {}));
    const y = JSON.parse(JSON.stringify(b ?? {}));
    return [...new Set([...Object.keys(x), ...Object.keys(y)])].sort().filter(key => stableJson(x[key]) !== stableJson(y[key]));
}
