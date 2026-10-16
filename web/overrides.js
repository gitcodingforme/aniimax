// Structure overrides: game structure I verified in game (data/overrides/structure.json, copied to
// web/structure-overrides.json by scripts/apply_overrides.py) patched over facility-config.js
// constants when the page loads, so upstream's file stays untouched and merges stay clean.
// Pure function, tested in tests/overrides.test.mjs.

const nonNegativeInts = list => Array.isArray(list) && list.length > 0 && list.every(n => Number.isInteger(n) && n >= 0);
// Output caps allow `null` for "unknown at this level".
const capsList = list => Array.isArray(list) && list.length > 0 && list.every(n => n === null || (Number.isInteger(n) && n >= 0));

// Mutates the given constants in place. Returns what was applied and what was ignored, as text.
// `OUTPUT_CAPS` and `FACILITY_UPGRADE_COSTS` are optional so older callers (and tests) keep
// working without them.
export function applyStructureOverrides(overrides, { FACILITIES, LEVEL_UP_COSTS, MODULE_MAX_LEVELS, OUTPUT_CAPS = null, FACILITY_UPGRADE_COSTS = null }) {
    const applied = [];
    const problems = [];
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
        return { applied, problems: ['structure overrides must be one JSON object'] };
    }

    for (const [name, patch] of Object.entries(overrides.facilities || {})) {
        const facility = FACILITIES.find(f => f.name === name);
        if (!facility || !patch || typeof patch !== 'object') {
            problems.push(`unknown facility "${name}"`);
            continue;
        }
        if ('counts' in patch) {
            if (nonNegativeInts(patch.counts)) {
                facility.counts = [...patch.counts];
                applied.push(`${name} counts`);
            } else {
                problems.push(`${name} counts must be a list of whole numbers`);
            }
        }
        if ('unlocks' in patch) {
            const entries = Object.entries(patch.unlocks || {})
                .filter(([level, rv]) => /^\d+$/.test(level) && Number.isInteger(rv) && rv >= 1);
            if (entries.length > 0 && entries.length === Object.keys(patch.unlocks || {}).length) {
                facility.unlocks = Object.fromEntries(entries.map(([level, rv]) => [Number(level), rv]));
                applied.push(`${name} unlocks`);
            } else {
                problems.push(`${name} unlocks must map facility level to RV level`);
            }
        }
        if ('outputCaps' in patch) {
            if (!OUTPUT_CAPS) {
                problems.push(`${name} outputCaps: this page has no output-cap table to override`);
            } else if (capsList(patch.outputCaps)) {
                OUTPUT_CAPS[name] = [...patch.outputCaps];
                applied.push(`${name} output caps`);
            } else {
                problems.push(`${name} outputCaps must be a list of whole numbers (or null), one per facility level`);
            }
        }
    }

    for (const [level, patch] of Object.entries(overrides.levelUpCosts || {})) {
        const cost = LEVEL_UP_COSTS[level];
        if (!cost || !patch || typeof patch !== 'object') {
            problems.push(`no level-up cost for RV ${level} to override`);
            continue;
        }
        if ('coins' in patch) {
            if (Number.isInteger(patch.coins) && patch.coins >= 0) {
                cost.coins = patch.coins;
                applied.push(`RV ${level} coins`);
            } else {
                problems.push(`RV ${level} coins must be a whole number`);
            }
        }
        if ('items' in patch) {
            const ok = Array.isArray(patch.items)
                && patch.items.every(pair => Array.isArray(pair) && typeof pair[0] === 'string' && Number.isInteger(pair[1]) && pair[1] >= 0);
            if (ok) {
                cost.items = patch.items.map(([item, amount]) => [item, amount]);
                applied.push(`RV ${level} items`);
            } else {
                problems.push(`RV ${level} items must be a list of [item, amount] pairs`);
            }
        }
    }

    for (const [module, levels] of Object.entries(overrides.moduleMaxLevels || {})) {
        if (!(module in MODULE_MAX_LEVELS)) {
            problems.push(`unknown module "${module}"`);
        } else if (nonNegativeInts(levels)) {
            MODULE_MAX_LEVELS[module] = [...levels];
            applied.push(`${module} max levels`);
        } else {
            problems.push(`${module} must be a list of whole numbers, one per RV level`);
        }
    }

    // Upgrade costs: `{ Facility: { level: coins } }`, the Home Coins to reach that facility level
    // from the one below. Merged level by level, so one corrected step keeps the others.
    for (const [name, levels] of Object.entries(overrides.upgradeCosts || {})) {
        if (!FACILITY_UPGRADE_COSTS) {
            problems.push(`${name} upgradeCosts: this page has no upgrade-cost table to override`);
        } else if (!FACILITIES.some(f => f.name === name)) {
            problems.push(`unknown facility "${name}" in upgradeCosts`);
        } else if (!levels || typeof levels !== 'object' || Array.isArray(levels) || Object.keys(levels).length === 0
            || !Object.entries(levels).every(([level, coins]) => /^\d+$/.test(level) && Number(level) >= 2 && Number.isInteger(coins) && coins > 0)) {
            problems.push(`${name} upgradeCosts must map facility level (2 and up) to a whole number of Home Coins`);
        } else {
            FACILITY_UPGRADE_COSTS[name] = {
                ...(FACILITY_UPGRADE_COSTS[name] || {}),
                ...Object.fromEntries(Object.entries(levels).map(([level, coins]) => [Number(level), coins])),
            };
            applied.push(`${name} upgrade costs`);
        }
    }

    return { applied, problems };
}
