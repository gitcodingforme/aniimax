import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ANIIPOD_TIERS, EMODE, FACILITIES, LEVEL_UP_CHAINS, LEVEL_UP_COSTS, MAX_HOME_LEVEL, MODULE_MAX_LEVELS, SEASON, SPECIAL_RECIPES, simpleSetup,
} from '../web/facility-config.js';
import { aniimoTabOf, differingKeys, effectiveSetup, planInputFromSetup, sameInput } from '../web/setup-input.js';

// ctx.config's shape (see featureContext in web/app.js); abilities in the page's order.
const config = {
    FACILITIES, LEVEL_UP_COSTS, LEVEL_UP_CHAINS, MODULE_MAX_LEVELS, MAX_HOME_LEVEL, SEASON, SPECIAL_RECIPES, ANIIPOD_TIERS, simpleSetup,
    abilities: ['Fire', 'Grass', 'Water', 'Earth', 'Lightning', 'Ice', 'Wind', 'Dark', 'Light', 'Hauling', 'Artisanship', 'Leisure', 'Perfumery'],
    modules: Object.keys(MODULE_MAX_LEVELS),
};

// What currentConfig() in app.js saves for an advanced-mode player who is levelling up to RV 6.
const advanced = {
    facilityTiers: { Farmland: [{ count: 4, level: 2 }, { count: 2, level: 1 }], Mine: [{ count: 1, level: 3 }] },
    levelUpStock: { coins: 5000, wood_block: 300, mineral_sand: 0 },
    skippedRecipes: ['quick_potato'],
    unlockedSpecial: ['rose_shortbread', 'umbral_pickle'],
    priorities: [{ target: 'coins', on: true }],
    aniimoLevels: { Earth: 2, Fire: 9 },
    roster: [],
    'strategy-level-up': true, 'strategy-priorities': false, 'level-up-target': '6',
    'mode-simple': false, 'mode-advanced': true, 'home-level': '5',
    'ecological-module-level': '1', 'kitchen-module-level': '2', 'resource-detector-level': '0', 'crafting-module-level': '0',
    'season-on': false, 'season-currency-per-day': '', 'aniimo-best': true, 'aniimo-minimum': false, 'aniimo-custom': false,
};

test('test_advanced_level_up_setup_gives_the_pages_input', () => {
    const before = JSON.stringify(advanced);
    const input = planInputFromSetup(advanced, config);
    assert.equal(JSON.stringify(advanced), before, 'the setup is not changed');
    assert.equal(input.currency, 'coins');
    assert.deepEqual(input.priorities, []);
    assert.deepEqual(input.facilities.Farmland, [{ count: 4, level: 2 }, { count: 2, level: 1 }]);
    assert.deepEqual(input.facilities.Mine, [{ count: 1, level: 3 }]);
    const blank = FACILITIES.find(f => f.name !== 'Farmland' && f.name !== 'Mine');
    assert.deepEqual(input.facilities[blank.name], [{ count: blank.defaultCount, level: 1 }], 'a facility missing from the save has its default');
    for (const f of FACILITIES.filter(f => f.hasLevels === false)) assert.ok(input.facilities[f.name].every(t => t.level === 1));
    assert.deepEqual(input.modules, { ecological_module: 1, kitchen_module: 2, resource_detector: 0, crafting_module: 0 });
    assert.deepEqual(input.level_up, {
        cost: [['coins', 32000], ['wood_block', 1300], ['mineral_sand', 700]],
        stock: [['coins', 5000], ['wood_block', 300]],
    });
    assert.ok(input.exclude.includes('quick_potato'));
    assert.ok(input.exclude.includes('potato_kvass') && input.exclude.includes('harvest_platter'), 'locked special recipes are excluded');
    assert.ok(!input.exclude.includes('rose_shortbread') && !input.exclude.includes('umbral_pickle'), 'unlocked ones are not');
    assert.equal(input.season, false);
    assert.equal(input.season_currency_per_day, null);
    assert.equal(input.aniimo, 'best');
    assert.equal(input.aniimo_levels.Earth, 2);
    assert.equal(input.aniimo_levels.Perfumery, 3);
    assert.ok(!('Fire' in input.aniimo_levels) || input.aniimo_levels.Fire === 4, 'a level of 9 is dropped');
});

test('test_simple_mode_uses_the_rv_level_and_the_next_level_up', () => {
    const input = planInputFromSetup({ 'mode-simple': true, 'home-level': '5' }, config);
    assert.deepEqual(input.facilities, simpleSetup(5).facilities);
    assert.deepEqual(input.modules, simpleSetup(5).modules);
    assert.deepEqual(input.level_up.cost, [['coins', 32000], ['wood_block', 1300], ['mineral_sand', 700]]);
    assert.deepEqual(input.level_up.stock, []);
    assert.equal(planInputFromSetup({ 'mode-simple': true, 'home-level': String(MAX_HOME_LEVEL) }, config).level_up, null, 'no level above the top one');
    assert.equal(effectiveSetup({ 'mode-simple': true }, config).homeLevel, MAX_HOME_LEVEL, 'a blank RV is the top level');
    assert.equal(effectiveSetup({ 'mode-simple': true, 'home-level': '3' }, config, { homeLevel: 8 }).homeLevel, 8);
});

test('test_priorities_season_and_aniipods', () => {
    const setup = {
        'mode-simple': true, 'home-level': String(MAX_HOME_LEVEL), 'strategy-level-up': false, 'strategy-priorities': true,
        priorities: [{ target: 'season_points', on: true }, { target: 'aniipods', on: true }, { target: 'bogus', on: true }, { target: 'coins', on: true }],
        'season-on': true, 'season-currency-per-day': '25',
    };
    const input = planInputFromSetup(setup, config);
    assert.deepEqual(input.priorities, ['season_points', 'aniipods', 'coins']);
    assert.equal(input.level_up, null);
    assert.equal(input.season, true);
    assert.equal(input.season_currency_per_day, 25);
    const level = Math.max(...simpleSetup(MAX_HOME_LEVEL).facilities['Aniipod Maker'].map(t => t.level));
    const best = ANIIPOD_TIERS[Math.min(level, ANIIPOD_TIERS.length) - 1];
    for (const tier of ANIIPOD_TIERS) assert.equal(input.exclude.includes(tier), tier !== best, `${tier} excluded unless best`);
    // Before the season opens (RV below SEASON.minHomeLevel) it is off, and so is its priority.
    const early = planInputFromSetup({ ...setup, 'home-level': String(SEASON.minHomeLevel - 1) }, config);
    assert.equal(early.season, false);
    assert.deepEqual(early.priorities, ['aniipods', 'coins']);
});

test('test_my_aniimo_sends_the_cleaned_roster', () => {
    const setup = {
        ...advanced,
        'aniimo-best': false, 'aniimo-custom': true,
        roster: [
            { name: 'Sprout', count: 2.6, abilities: { Earth: 3, Bogus: 2, Fire: 7 }, personalities: ['Energetic', 'Nimble'] },
            { name: 'bad' },
        ],
    };
    const input = planInputFromSetup(setup, config);
    assert.equal(input.aniimo, 'roster');
    assert.deepEqual(input.aniimo_levels, {});
    assert.deepEqual(input.roster.members, [{ count: 3, abilities: { Earth: 3 }, personalities: ['Energetic', 'Nimble', 'Faithful', 'Playful'] }]);
    assert.deepEqual(input.roster.residents, FACILITIES.filter(f => f.category === 'Aniimo Materials').map(f => f.name));
    assert.deepEqual(input.roster.environment, { 'Heat Furnace': 'Fire', 'Cooling Unit': 'Ice', Sunlamp: 'Light' });
    assert.equal(aniimoTabOf(setup), 'custom');
    assert.equal(planInputFromSetup(setup, config, { aniimoTab: 'minimum' }).aniimo, 'minimum');
});

test('test_old_saves_and_input_comparison', () => {
    const old = { facilityTiers: { 'Mineral Pile': [{ count: 3, level: 2 }] }, 'mineral-detector-level': '4' };
    const input = planInputFromSetup(old, config);
    assert.deepEqual(input.facilities.Mine, [{ count: 3, level: 2 }], 'a save with facilities and no mode is advanced; Mineral Pile is Mine');
    assert.equal(input.modules.resource_detector, 4);
    assert.ok(sameInput({ a: 1, b: [1, { c: 2, d: undefined }] }, { b: [1, { c: 2 }], a: 1 }));
    assert.ok(!sameInput({ a: 1 }, { a: 2 }));
    assert.ok(!sameInput(input, planInputFromSetup({ ...old, 'mineral-detector-level': '5' }, config)));
});

// What currentConfig() in app.js returns on a fresh visit (nothing in storage, every default from
// index.html and the page's own variables) after the player picks RV 5 in Simple mode.
const fresh = {
    facilityTiers: Object.fromEntries(FACILITIES.map(f => [f.name, [{ count: f.defaultCount, level: 1 }]])),
    levelUpStock: {}, skippedRecipes: [], unlockedSpecial: [],
    priorities: [{ target: 'coins', on: true }, { target: 'aniimo_exp', on: false }, { target: 'aniipods', on: false },
        { target: 'Wood Blocks', on: false }, { target: 'Mineral Sand', on: false }, { target: 'season_points', on: false }],
    aniimoLevels: {}, roster: [],
    'target-amount': '', 'current-amount': '',
    'strategy-level-up': true, 'strategy-priorities': false, 'level-up-target': '2',
    'mode-simple': true, 'mode-advanced': false, 'home-level': '5',
    'ecological-module-level': '0', 'kitchen-module-level': '0', 'resource-detector-level': '0', 'crafting-module-level': '0',
    'rate-unit': 'second', 'season-on': false, 'layout-sim-on': true, 'season-currency-per-day': '',
    'aniimo-best': true, 'aniimo-minimum': false, 'aniimo-custom': false,
};

test('test_fresh_visit_simple_rv5_matches_what_the_page_sends', () => {
    // Written by hand from getPlanInputValues, levelUpInput, excludedRecipes and aniimoInput in app.js.
    const expected = {
        currency: 'coins',
        priorities: [],
        prioritize_byproducts: false,
        level_up: { cost: [['coins', 32000], ['wood_block', 1300], ['mineral_sand', 700]], stock: [] },
        exclude: ['rose_shortbread', 'potato_kvass', 'ginseng_porridge', 'strawberry_candy', 'flowers_in_a_bottle', 'lotion',
            'harvest_platter', 'umbral_pickle', 'umbral_hot_pot', 'umbral_sweet_and_spicy_sauce'],
        season: false,
        season_currency_per_day: null,
        facilities: simpleSetup(5).facilities,
        modules: { ecological_module: 1, kitchen_module: 2, resource_detector: 1, crafting_module: 1 },
        aniimo: 'best',
        aniimo_levels: { Fire: 4, Water: 4, Earth: 4, Lightning: 4, Wind: 4, Dark: 4, Artisanship: 4, Leisure: 4, Perfumery: 3 },
    };
    assert.deepEqual(expected.facilities.Farmland, [{ count: 12, level: 3 }]);
    assert.deepEqual(expected.facilities.Mine, [{ count: 3, level: 1 }]);
    const input = planInputFromSetup(fresh, config, { aniimoTab: 'best' });
    assert.deepEqual(differingKeys(input, expected), []);
    assert.deepEqual(input, expected);
    assert.ok(sameInput(planInputFromSetup(fresh, config), expected), 'the tab is read from the setup too');
});

test('test_differing_keys_names_where_two_inputs_disagree', () => {
    assert.deepEqual(differingKeys({ a: 1, b: [1], c: { d: 1 } }, { c: { d: 1 }, b: [1], a: 1 }), []);
    assert.deepEqual(differingKeys({ priorities: [], level_up: null, x: 1 }, { priorities: ['coins'], level_up: null, y: 2 }), ['priorities', 'x', 'y']);
    assert.deepEqual(differingKeys(null, { a: 1 }), ['a']);
});

test('test_emode_only_when_on_with_a_generator_in_advanced_mode', () => {
    assert.ok(!('emode' in planInputFromSetup(advanced, config)), 'a setup without the E-mode fields sends no emode key');
    const rv13 = { ...advanced, 'home-level': '13' };
    const fields = { 'emode-on': true, 'emode-generator-level': '2', 'emode-generator-count': '1', 'emode-supply': '120' };
    assert.deepEqual(planInputFromSetup({ ...rv13, ...fields }, config).emode, { generators: [{ level: 2, count: 1 }], supply: '120' });
    const off = planInputFromSetup({ ...rv13, ...fields, 'emode-on': false }, config);
    assert.ok(!('emode' in off), 'unticked: no key');
    assert.ok(sameInput(off, planInputFromSetup(rv13, config)), 'unticked: the same input as without the fields');
    assert.ok(!('emode' in planInputFromSetup({ ...rv13, ...fields, 'emode-generator-count': '0' }, config)), 'no generator: no key');
    assert.ok(!('emode' in planInputFromSetup({ ...rv13, ...fields, 'emode-generator-count': '' }, config)), 'blank count: no key');
    const simple = { ...rv13, ...fields, 'mode-simple': true, 'mode-advanced': false };
    assert.ok(!('emode' in planInputFromSetup(simple, config)), 'Simple mode never sends E-mode');
    // A level the game doesn't have is held to 1 to 5, a count to 3 generators; any supply but 120 is 100.
    const odd = planInputFromSetup({ ...rv13, ...fields, 'emode-generator-level': '9', 'emode-generator-count': '10', 'emode-supply': 'x' }, config);
    assert.deepEqual(odd.emode, { generators: [{ level: 5, count: 3 }], supply: '100' });
    const low = planInputFromSetup({ ...rv13, 'emode-on': true, 'emode-generator-level': '0', 'emode-generator-count': '2' }, config);
    assert.deepEqual(low.emode, { generators: [{ level: 1, count: 2 }], supply: '100' }, 'level 0 is level 1; no supply is 100');
});

test('test_emode_starts_at_rv_12', () => {
    const fields = { 'emode-on': true, 'emode-generator-level': '1', 'emode-generator-count': '1' };
    assert.ok(!('emode' in planInputFromSetup({ ...advanced, ...fields }, config)), 'RV 5: no key');
    assert.ok(!('emode' in planInputFromSetup({ ...advanced, ...fields, 'home-level': '11' }, config)), 'RV 11: no key');
    assert.deepEqual(planInputFromSetup({ ...advanced, ...fields, 'home-level': '12' }, config).emode, { generators: [{ level: 1, count: 1 }], supply: '100' });
    // The page's config may carry its own EMODE (pageConfig); it is the one used.
    const later = { ...config, EMODE: { ...EMODE, minHomeLevel: 13 } };
    assert.ok(!('emode' in planInputFromSetup({ ...advanced, ...fields, 'home-level': '12' }, later)));
});
