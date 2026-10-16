// Turns a saved setup (the object currentConfig() in app.js returns, which is also what a profile,
// a snapshot and a share link hold) into the input find_plan wants, without a page. It is a careful
// COPY of what app.js does with the page's inputs; the compare card checks it against the page's
// own input at run time (sameInput), so a drift in app.js shows up as a warning, not as quiet
// wrong numbers. Pure functions only (no DOM); the config comes in as an argument (ctx.config).
// Tested in tests/setup_input.test.mjs.
//
// Each helper names the app.js lines it mirrors (as of the m9 build; the numbers drift, the
// function names do not). Not mirrored: the old "strategy-coins/exp/aniipods" saves from before
// Priorities (app.js loadInputsFromStorage, ~533-538); they fall back to the default priorities.

// app.js numberOrDefault (~3756): parseInt that keeps a real 0.
function numberOrDefault(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

// app.js PRIORITY_TARGETS (~3275): what Priorities can rank; `season` ones show only while the season is on.
const PRIORITY_TARGETS = [
    { id: 'coins' }, { id: 'aniimo_exp' }, { id: 'aniipods' },
    { id: 'Wood Blocks' }, { id: 'Mineral Sand' }, { id: 'season_points', season: true },
];

// app.js getPlanInputValues (~3708): advanced mode's module inputs, by the field that holds each.
const MODULE_FIELDS = {
    ecological_module: 'ecological-module-level',
    kitchen_module: 'kitchen-module-level',
    resource_detector: 'resource-detector-level',
    crafting_module: 'crafting-module-level',
};

// app.js ENVIRONMENT_BUILDING_ABILITY (~3924): the ability each environment building's Aniimo needs.
const ENVIRONMENT_BUILDING_ABILITY = { 'Heat Furnace': 'Fire', 'Cooling Unit': 'Ice', 'Sunlamp': 'Light' };

// app.js ABILITY_DEFAULTS and defaultLevelFor (~3182): no level-4 Perfumery Aniimo is assumed.
const ABILITY_DEFAULTS = { Perfumery: 3 };
const MAX_ANIIMO_LEVEL = 4;
const defaultLevelFor = ability => ABILITY_DEFAULTS[ability] ?? MAX_ANIIMO_LEVEL;

// facility-config.js PERSONALITY_PAIRS (~292): the first name of each pair is app.js's default.
const PERSONALITY_NAMES = [['Instinctive', 'Energetic'], ['Nimble', 'Practical'], ['Faithful', 'Tenacious'], ['Playful', 'Judicious']];

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

// app.js migrateSavedConfig (~437): a setup without a mode but with facilities was hand-entered
// (advanced); Mineral Pile became Mine; the Mineral Detector became the Resource Detector.
// Works on a copy, so the caller's setup is never touched.
function migrated(setup) {
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

// Which radio of a group is on after loadInputsFromStorage (~524-566) has set the saved
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

// app.js selectedHomeLevel (~1637): the RV select, MAX_HOME_LEVEL when blank or not an option.
function rvOf(data, config) {
    const level = numberOrDefault(data['home-level'], config.MAX_HOME_LEVEL);
    return level >= 1 && level <= config.MAX_HOME_LEVEL ? level : config.MAX_HOME_LEVEL;
}

// app.js loadInputsFromStorage (~526-532): priorities keep their saved order; a target the page
// knows but the save lacks goes last, off. Unknown targets are dropped.
function priorityOrderOf(data) {
    const saved = Array.isArray(data.priorities) ? data.priorities.filter(p => PRIORITY_TARGETS.some(t => t.id === p?.target)) : null;
    if (!saved) return PRIORITY_TARGETS.map(t => ({ target: t.id, on: t.id === 'coins' }));
    const missing = PRIORITY_TARGETS.filter(t => !saved.some(p => p.target === t.id)).map(t => ({ target: t.id, on: false }));
    return [...saved.map(p => ({ target: p.target, on: !!p.on })), ...missing];
}

// app.js seasonAvailable / seasonActive (~3021-3027).
function seasonActiveOf(data, config, simple, homeLevel) {
    const available = !simple || homeLevel >= config.SEASON.minHomeLevel;
    return available && !!data['season-on'];
}

// app.js seasonCurrencyPerDay (~3016): blank means no limit.
function seasonCurrencyOf(data) {
    const value = String(data['season-currency-per-day'] ?? '').trim();
    return value !== '' && Number(value) >= 0 ? Number(value) : null;
}

// app.js initFacilityTiers (~457) and getPlanInputValues (~3692-3699): the saved tiers per
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
// advanced reads the saved tiers and module levels (app.js getPlanInputValues, ~3685-3712).
export function effectiveSetup(setup, config, { homeLevel = null } = {}) {
    const data = migrated(setup);
    const simple = radioOn(data, ['mode-simple', 'mode-advanced'], 'mode-simple') === 'mode-simple';
    const rv = Number.isInteger(homeLevel) && homeLevel >= 1 ? homeLevel : rvOf(data, config);
    if (simple) return { simple, homeLevel: rv, ...config.simpleSetup(rv) };
    const modules = {};
    for (const [key, field] of Object.entries(MODULE_FIELDS)) modules[key] = numberOrDefault(data[field], 0);
    return { simple, homeLevel: rv, facilities: advancedFacilities(data, config), modules };
}

// app.js loadInputsFromStorage (~545-556): the roster as the page holds it after loading.
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

// app.js loadInputsFromStorage (~540-544): the saved ability levels, 1 to 4 and known abilities only.
function aniimoLevelsOf(data, config) {
    if (!isObject(data.aniimoLevels)) return {};
    const known = new Set(config.abilities);
    return Object.fromEntries(Object.entries(data.aniimoLevels)
        .filter(([ability, level]) => known.has(ability) && Number.isInteger(Number(level)) && level >= 1 && level <= MAX_ANIIMO_LEVEL)
        .map(([ability, level]) => [ability, Number(level)]));
}

// app.js selectedSetupTab (~3212): which of Best, Minimum and My Aniimo the setup has on.
export function aniimoTabOf(setup) {
    const on = radioOn(migrated(setup), ['aniimo-best', 'aniimo-minimum', 'aniimo-custom'], 'aniimo-best');
    return on === 'aniimo-minimum' ? 'minimum' : on === 'aniimo-custom' ? 'custom' : 'best';
}

// app.js aniimoInput (~3199), levelledAbilities (~3188) and rosterPayload (~2822): the Aniimo half
// of the input. 'custom' sends the roster, the others the per-ability levels.
function aniimoInput(tab, data, config) {
    if (tab === 'custom') {
        return {
            aniimo: 'roster',
            roster: {
                members: rosterOf(data, config),
                residents: config.FACILITIES.filter(f => f.category === 'Aniimo Materials').map(f => f.name),
                environment: ENVIRONMENT_BUILDING_ABILITY,
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

// app.js bestAniipod (~3397): the best Aniipod the owned Aniipod Maker can make, or null.
function bestAniipodOf(eff, config) {
    const level = Math.max(0, ...(eff.facilities['Aniipod Maker'] || []).filter(t => t.count > 0).map(t => t.level));
    return level > 0 ? config.ANIIPOD_TIERS[Math.min(level, config.ANIIPOD_TIERS.length) - 1] : null;
}

// app.js levelUpTarget (~3406) and levelUpInput (~3498): the next RV level in simple mode, the
// saved target in advanced (it follows RV + 1 until one is saved); null if its cost is unknown.
function levelUpOf(data, config, eff) {
    let target;
    if (eff.simple) target = eff.homeLevel + 1;
    else if ('level-up-target' in data) target = numberOrDefault(data['level-up-target'], 7);
    else target = config.LEVEL_UP_COSTS[eff.homeLevel + 1] ? eff.homeLevel + 1 : Number(Object.keys(config.LEVEL_UP_COSTS)[0]);
    const cost = config.LEVEL_UP_COSTS[target];
    if (target > config.MAX_HOME_LEVEL || !cost) return null;
    // app.js stockNames (~3425) and stockAmount (~3434): coins, and each chain up to the tier needed.
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

// The find_plan input for a saved setup (see app.js getPlanInputValues, ~3685, and planSnapshot,
// ~197, which adds the Aniimo half). Options: `homeLevel` overrides the RV level, `aniimoTab`
// ('best', 'minimum' or 'custom') overrides the setup's own pick.
export function planInputFromSetup(setup, config, { homeLevel = null, aniimoTab = null } = {}) {
    const data = migrated(setup);
    const eff = effectiveSetup(data, config, { homeLevel });
    // app.js activePriorities / shownPriorities (~3295-3303): only while Priorities is the strategy.
    const strategy = radioOn(data, ['strategy-level-up', 'strategy-priorities'], 'strategy-level-up');
    const season = seasonActiveOf(data, config, eff.simple, eff.homeLevel);
    const priorities = strategy === 'strategy-priorities'
        ? priorityOrderOf(data)
            .filter(p => season || !PRIORITY_TARGETS.find(t => t.id === p.target)?.season)
            .filter(p => p.on).map(p => p.target)
        : [];
    // app.js excludedRecipes (~3050): skips, locked special recipes, and (when going for Aniipods)
    // every Aniipod tier but the best one.
    const unlocked = new Set(Array.isArray(data.unlockedSpecial) ? data.unlockedSpecial.filter(n => typeof n === 'string') : []);
    const skipped = Array.isArray(data.skippedRecipes) ? data.skippedRecipes.filter(n => typeof n === 'string') : [];
    const locked = [...config.SPECIAL_RECIPES, ...config.SEASON.recipeNotes].map(r => r.name).filter(name => !unlocked.has(name));
    const best = priorities.includes('aniipods') ? bestAniipodOf(eff, config) : null;
    const lesser = best ? config.ANIIPOD_TIERS.filter(name => name !== best) : [];
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
    };
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
