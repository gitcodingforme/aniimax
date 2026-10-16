import assert from 'node:assert/strict';
import test from 'node:test';

import * as facilityConfig from '../web/facility-config.js';
import {
    coveringHomeLevel, coversHomeLevel, diffPlans, playerHomeLevel, setupAtHomeLevel, stripVariant, summarizePlan,
} from '../web/plan-summary.js';
import { startLevel } from '../web/goal-mode.js';
import { roadmapHomeLevel } from '../web/roadmap.js';
import { homeCapFor } from '../web/roster-advisor.js';
import { buildableFacilities, homeLevelFor } from '../web/what-if.js';

// Shaped like find_plan's answer (JsProductionPlan in src/wasm.rs), cut down to what matters here.
const plan = {
    success: true,
    rate_per_second: 0.5,
    proven_optimal: true,
    level_up: { seconds: 7200, requirements: [] },
    coin_items: [
        { item_name: 'rice', facility: 'Farmland', facility_count: 4, status: 'producing', cycle_time: 1800 },
        { item_name: 'rice', facility: 'Farmland', facility_count: 2, status: 'producing', cycle_time: 1800 },
        { item_name: 'milled_rice__by2', facility: 'Carousel Mill', facility_count: 1, status: 'producing', cycle_time: 120 },
        { item_name: null, facility: 'Well', facility_count: 1, status: 'idle', cycle_time: null },
        { item_name: 'wheat', facility: 'Farmland', facility_count: 0, status: 'producing', cycle_time: 600 },
        { item_name: 'jam', facility: 'Jam Press', facility_count: 1, status: 'nothing_available', cycle_time: null },
    ],
};

test('test_summary_gives_rates_and_producing_rows', () => {
    const summary = summarizePlan(plan);
    assert.equal(summary.ok, true);
    assert.equal(summary.coinsPerHour, 1800);
    assert.equal(summary.levelUpSeconds, 7200);
    assert.equal(summary.proven, true);
    assert.deepEqual(summary.rows, [
        { key: 'Farmland:rice', facility: 'Farmland', item: 'rice', count: 6, cycleSeconds: 1800 },
        { key: 'Carousel Mill:milled_rice__by2', facility: 'Carousel Mill', item: 'milled_rice__by2', count: 1, cycleSeconds: 120 },
    ]);
});

test('test_summary_of_no_plan_or_a_failed_one', () => {
    const empty = { ok: false, coinsPerHour: null, levelUpSeconds: null, proven: false, rows: [] };
    assert.deepEqual(summarizePlan(null), empty);
    assert.deepEqual(summarizePlan({ success: false, error: 'no plan' }), empty);
    const bare = summarizePlan({ success: true, rate_per_second: 0, coin_items: [], level_up: null, proven_optimal: null });
    assert.deepEqual(bare, { ok: true, coinsPerHour: 0, levelUpSeconds: null, proven: false, rows: [] });
});

test('test_diff_lists_count_changes_and_rows_on_one_side_only', () => {
    const after = {
        ...plan,
        coin_items: [
            { item_name: 'rice', facility: 'Farmland', facility_count: 4, status: 'producing', cycle_time: 1800 },
            { item_name: 'milled_rice__by2', facility: 'Carousel Mill', facility_count: 1, status: 'producing', cycle_time: 120 },
            { item_name: 'potato', facility: 'Farmland', facility_count: 2, status: 'producing', cycle_time: 2400 },
        ],
    };
    assert.deepEqual(diffPlans(plan, after), [
        { key: 'Farmland:rice', facility: 'Farmland', item: 'rice', before: 6, after: 4 },
        { key: 'Farmland:potato', facility: 'Farmland', item: 'potato', before: 0, after: 2 },
    ]);
    assert.deepEqual(diffPlans(after, null), [
        { key: 'Farmland:rice', facility: 'Farmland', item: 'rice', before: 4, after: 0 },
        { key: 'Carousel Mill:milled_rice__by2', facility: 'Carousel Mill', item: 'milled_rice__by2', before: 1, after: 0 },
        { key: 'Farmland:potato', facility: 'Farmland', item: 'potato', before: 2, after: 0 },
    ]);
    assert.deepEqual(diffPlans(plan, plan), []);
    // Summaries work as well as plans.
    assert.deepEqual(diffPlans(summarizePlan(plan), summarizePlan(after)), diffPlans(plan, after));
});

test('test_strip_variant_gives_the_recipe_behind_an_item_name', () => {
    assert.equal(stripVariant('milled_rice__by2'), 'milled_rice');
    assert.equal(stripVariant('rose__uncovered'), 'rose');
    assert.equal(stripVariant('rose__uncovered__by12'), 'rose');
    assert.equal(stripVariant('quick_wheat'), 'quick_wheat');
    assert.equal(stripVariant('odd__by'), 'odd__by', 'a crew suffix needs its number');
    assert.equal(stripVariant(null), null);
});

// --- The player's RV level (playerHomeLevel) ---

// The page's own data in ctx.config's shape (no overrides).
const pageConfig = {
    FACILITIES: facilityConfig.FACILITIES,
    MODULE_MAX_LEVELS: facilityConfig.MODULE_MAX_LEVELS,
    MAX_HOME_LEVEL: facilityConfig.MAX_HOME_LEVEL,
    ANIIMO_MAX: facilityConfig.ANIIMO_MAX,
    simpleSetup: facilityConfig.simpleSetup,
};
const setupOf = rv => ({ currency: 'coins', ...facilityConfig.simpleSetup(rv) });

// What each of the four cards takes the RV level to be, for one plan on screen:
// [roadmap, goal-mode, what-if, roster-advisor's Aniimo cap].
function everyCard(input, { simple, saved = null, context }) {
    return [
        roadmapHomeLevel(input, { config: pageConfig, simple, homeLevel: saved, context }),
        startLevel(input, { config: pageConfig, simple, homeLevel: saved, context }),
        homeLevelFor(input, pageConfig, { simple, homeLevel: saved, context }),
        homeCapFor({ config: pageConfig, simple, homeLevel: saved, context, input }),
    ];
}
const capAt = rv => facilityConfig.ANIIMO_MAX[rv - 1];

test('test_cards_agree_on_a_saved_rv_that_covers_advanced_facilities', () => {
    // Reviewer case: Advanced mode, RV 8's facilities and modules, a saved RV input of 12.
    const input = setupOf(8);
    assert.equal(coveringHomeLevel(input, pageConfig), 8);
    const context = { levelUp: false, target: 9, simple: false };
    assert.equal(playerHomeLevel({ input, config: pageConfig, simple: false, savedHomeLevel: 12, context }), 12);
    assert.deepEqual(everyCard(input, { simple: false, saved: 12, context }), [12, 12, 12, capAt(12)]);
    // A saved RV below what is owned is stale: the covering level instead.
    assert.deepEqual(everyCard(input, { simple: false, saved: 5, context }), [8, 8, 8, capAt(8)]);
    assert.deepEqual(everyCard(input, { simple: false, context }), [8, 8, 8, capAt(8)]);
});

test('test_modules_count_toward_the_covering_rv', () => {
    // Reviewer case: RV 1 facilities (4 Farmland) with every module at its top level, which
    // RV 19 first allows (Kitchen Module 7, Resource Detector 8, Crafting Module 7).
    const input = { ...setupOf(1), modules: facilityConfig.simpleSetup(20).modules };
    assert.equal(coveringHomeLevel(input, pageConfig), 19);
    assert.equal(coversHomeLevel(input, pageConfig, 18), false);
    assert.equal(coversHomeLevel(input, pageConfig, 19), true);
    const context = { levelUp: false, target: 2, simple: false };
    assert.deepEqual(everyCard(input, { simple: false, context }), [19, 19, 19, capAt(19)]);
    assert.deepEqual(everyCard(input, { simple: false, saved: 12, context }), [19, 19, 19, capAt(19)]);
    // So what-if's "Not built yet" list is for RV 19: Floral Windmill (RV 18) is in it.
    const rv = homeLevelFor(input, pageConfig, { simple: false, context });
    assert.ok(buildableFacilities(input, pageConfig, rv).includes('Floral Windmill'));
});

test('test_a_level_up_plan_works_from_the_level_below_its_target', () => {
    const input = setupOf(8);
    // Advanced mode: the target less one comes before the saved RV input...
    const levelUp = { levelUp: true, target: 10, simple: false };
    assert.deepEqual(everyCard(input, { simple: false, saved: 12, context: levelUp }), [9, 9, 9, capAt(9)]);
    // ...but never below what is owned.
    const tooLow = { levelUp: true, target: 5, simple: false };
    assert.deepEqual(everyCard(input, { simple: false, saved: 12, context: tooLow }), [8, 8, 8, capAt(8)]);
    // Simple mode: the target less one when levelling up, else the saved RV input.
    const simpleUp = { levelUp: true, target: 9, simple: true };
    assert.deepEqual(everyCard(input, { simple: true, saved: 8, context: simpleUp }), [8, 8, 8, capAt(8)]);
    assert.deepEqual(everyCard(setupOf(12), { simple: true, saved: 7, context: { levelUp: true, target: 13 } }), [12, 12, 12, capAt(12)]);
    assert.deepEqual(everyCard(input, { simple: true, saved: 8, context: { levelUp: false, target: 15 } }), [8, 8, 8, capAt(8)]);
    // A target with no level-up plan says nothing.
    assert.equal(playerHomeLevel({ input, config: pageConfig, simple: false, context: { levelUp: false, target: 15 } }), 8);
});

test('test_player_home_level_edges', () => {
    // A small made-up config without simpleSetup: worked out from unlocks, counts and module caps.
    const config = {
        MAX_HOME_LEVEL: 6,
        FACILITIES: [
            { name: 'Farmland', unlocks: { 1: 1, 2: 3 }, counts: [2, 3, 4] },
            { name: 'Heat Furnace', hasLevels: false, unlocks: { 1: 2 }, counts: [0, 1] },
        ],
        MODULE_MAX_LEVELS: { kitchen_module: [0, 1, 1, 2] },
    };
    assert.deepEqual(setupAtHomeLevel(config, 3), {
        facilities: { Farmland: [{ count: 4, level: 2 }], 'Heat Furnace': [{ count: 1, level: 1 }] },
        modules: { kitchen_module: 1 },
    });
    const owned = { facilities: { Farmland: [{ count: 3, level: 1 }], 'Heat Furnace': [{ count: 0, level: 1 }] }, modules: { kitchen_module: 0 } };
    assert.equal(coveringHomeLevel(owned, config), 2, 'three Farmland need RV 2');
    assert.equal(coveringHomeLevel({ ...owned, modules: { kitchen_module: 2 } }, config), 4, 'Kitchen Module 2 needs RV 4');
    assert.equal(coveringHomeLevel({ facilities: { Farmland: [{ count: 9, level: 1 }] } }, config), 6, 'nothing covers: the top');
    assert.equal(coveringHomeLevel(undefined, config), 1);
    // The answer is a whole RV level within 1 and the top; the saved input may be a string.
    assert.equal(playerHomeLevel({ input: owned, config, simple: false, savedHomeLevel: '5' }), 5);
    assert.equal(playerHomeLevel({ input: owned, config, simple: false, savedHomeLevel: 40 }), 6);
    assert.equal(playerHomeLevel({ input: owned, config, simple: true, savedHomeLevel: '' }), 2);
    assert.equal(playerHomeLevel({ input: owned, config, simple: true, savedHomeLevel: 1 }), 1, 'Simple mode uses its RV input as it is');
    assert.equal(playerHomeLevel({ input: owned, config, simple: false, context: { levelUp: true, target: 30 } }), 6);
    // `simple` defaults to the plan context's.
    assert.equal(playerHomeLevel({ input: owned, config, savedHomeLevel: 1, context: { simple: true } }), 1);
    assert.equal(playerHomeLevel({ input: owned, config, savedHomeLevel: 1, context: { simple: false } }), 2);
    assert.equal(playerHomeLevel(), 1);
});

test('test_emode_rows_stay_apart_from_the_ones_an_aniimo_works', () => {
    const emode = {
        success: true,
        rate_per_second: 1,
        coin_items: [
            { item_name: 'milled_rice', facility: 'Carousel Mill', facility_count: 1, status: 'producing', cycle_time: 54 },
            { item_name: 'milled_rice', facility: 'Carousel Mill', facility_count: 1, status: 'producing', cycle_time: 45, electric: true },
            { item_name: 'milled_rice', facility: 'Carousel Mill', facility_count: 1, status: 'producing', cycle_time: 54 },
        ],
    };
    const { rows } = summarizePlan(emode);
    assert.deepEqual(rows, [
        { key: 'Carousel Mill:milled_rice', facility: 'Carousel Mill', item: 'milled_rice', count: 2, cycleSeconds: 54 },
        { key: 'Carousel Mill:milled_rice:E', facility: 'Carousel Mill', item: 'milled_rice', count: 1, cycleSeconds: 45, electric: true },
    ]);
    // Going from Aniimo to power shows as a change on both rows, not as no change.
    const manualOnly = { ...emode, coin_items: [{ ...emode.coin_items[0], facility_count: 3 }] };
    assert.deepEqual(diffPlans(manualOnly, emode).map(c => [c.key, c.before, c.after]), [
        ['Carousel Mill:milled_rice', 3, 2],
        ['Carousel Mill:milled_rice:E', 0, 1],
    ]);
    assert.equal(stripVariant('milled_rice__electric'), 'milled_rice');
    assert.equal(stripVariant('rough_lumber__electric'), 'rough_lumber');
});
