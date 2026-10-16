import assert from 'node:assert/strict';
import test from 'node:test';

import {
    atCurrentPlan, covers, formatDays, goalBase, goalItems, homeLevelCovering, itemGoalInput, readGoal, rvSteps, shouldStop, startLevel, stepOutcome,
    summarizeStep, unmakeable, upgradeCoinsAt,
} from '../web/goal-mode.js';

// A small made-up config in ctx.config's shape. simpleSetup(rv) gives rv Farmland at level
// min(rv, 3) and rv - 2 Mines (none before RV 3) at level 1 or 2.
const config = {
    MAX_HOME_LEVEL: 8,
    FACILITIES: [
        { name: 'Farmland', unlocks: { 1: 1, 2: 2, 3: 3 } },
        { name: 'Mine', unlocks: { 1: 3, 2: 4 } },
        { name: 'Heat Furnace', hasLevels: false, unlocks: { 1: 4 } },
    ],
    FACILITY_UPGRADE_COSTS: { Farmland: { 2: 60, 3: 700 }, Mine: {} },
    LEVEL_UP_COSTS: {
        4: { coins: 2900, items: [['wood_block', 100], ['mineral_sand', 120]] },
        5: { coins: 7300, items: [['wood_block', 550]] },
        7: { coins: 69000, items: [['rough_lumber', 290]] },
    },
    simpleSetup: rv => ({
        facilities: {
            Farmland: [{ count: rv, level: Math.min(rv, 3) }],
            Mine: [{ count: Math.max(0, rv - 2), level: rv >= 4 ? 2 : 1 }],
            'Heat Furnace': [{ count: rv >= 4 ? 1 : 0, level: 1 }],
        },
        modules: { kitchen_module: rv },
    }),
};

const base = {
    currency: 'coins',
    priorities: ['coins', 'aniimo_exp'],
    exclude: ['rose_shortbread'],
    aniimo: 'best',
    facilities: { Farmland: [{ count: 9, level: 2 }] },
    modules: { kitchen_module: 1 },
    level_up: { cost: [['coins', 1]], stock: [['coins', 500], ['wood_block', 100], ['mineral_sand', 0]] },
};

test('test_rv_steps_in_simple_mode_use_each_previous_rv_setup', () => {
    const steps = rvSteps(base, { from: 3, to: 5, config, simple: true });
    assert.deepEqual(steps.map(s => s.rv), [4, 5]);
    assert.deepEqual(steps[0].input.facilities.Farmland, [{ count: 3, level: 3 }]);
    assert.deepEqual(steps[1].input.facilities.Mine, [{ count: 2, level: 2 }]);
    assert.deepEqual(steps[1].input.modules, { kitchen_module: 4 });
    assert.deepEqual(steps[0].input.level_up.cost, [['coins', 2900], ['wood_block', 100], ['mineral_sand', 120]]);
    // The rest of the input is kept, but nothing else is chased, as the Level up strategy sends it.
    assert.deepEqual(steps[0].input.priorities, []);
    assert.equal(steps[0].input.aniimo, 'best');
    assert.deepEqual(steps[0].input.exclude, ['rose_shortbread']);
    assert.match(steps[0].note, /upgrade coins not counted/);
    // The base is never changed.
    assert.deepEqual(base.priorities, ['coins', 'aniimo_exp']);
    assert.deepEqual(base.level_up.cost, [['coins', 1]]);
});

test('test_rv_steps_in_advanced_mode_keep_the_facilities', () => {
    const steps = rvSteps(base, { from: 3, to: 4, config, simple: false, countUpgrades: true });
    assert.equal(steps.length, 1);
    assert.deepEqual(steps[0].input.facilities, base.facilities);
    assert.deepEqual(steps[0].input.modules, base.modules);
    assert.deepEqual(steps[0].input.level_up.cost[0], ['coins', 2900]);
    assert.match(steps[0].note, /upgrades are not assumed/);
});

test('test_stock_counts_toward_the_first_step_only', () => {
    const steps = rvSteps(base, { from: 3, to: 5, config, simple: true });
    // Zero amounts are dropped.
    assert.deepEqual(steps[0].input.level_up.stock, [['coins', 500], ['wood_block', 100]]);
    assert.deepEqual(steps[1].input.level_up.stock, []);
    assert.equal(steps[0].ready, false);
    const rich = { ...base, level_up: { stock: [['coins', 3000], ['wood_block', 100], ['mineral_sand', 200]] } };
    assert.equal(rvSteps(rich, { from: 3, to: 4, config })[0].ready, true);
    assert.equal(covers([['coins', 5]], [['coins', 2], ['coins', 3]]), true);
    assert.deepEqual(rvSteps({ facilities: {} }, { from: 3, to: 4, config })[0].input.level_up.stock, []);
});

test('test_count_upgrades_adds_levels_unlocked_at_the_previous_rv', () => {
    // RV 4 is planned at RV 3, which unlocks Farmland Lv 3 (700 each, 3 of them) and Mine Lv 1 (free).
    const [four] = rvSteps(base, { from: 3, to: 4, config, simple: true, countUpgrades: true });
    assert.deepEqual(four.input.level_up.cost[0], ['coins', 2900 + 3 * 700]);
    assert.match(four.note, /includes 2,100 coins of upgrades unlocked at RV 3/);
    // RV 5 is planned at RV 4: Mine Lv 2 has no listed cost; the Heat Furnace has no levels.
    const [five] = rvSteps(base, { from: 4, to: 5, config, simple: true, countUpgrades: true });
    assert.deepEqual(five.input.level_up.cost[0], ['coins', 7300]);
    assert.match(five.note, /upgrade cost unknown for Mine Lv 2/);
    // The page's upgradeCost is used when there is one.
    const priced = { ...config, upgradeCost: (f, from, to) => (f === 'Mine' ? 1000 * (to - from) : null) };
    assert.deepEqual(upgradeCoinsAt(priced, 4, config.simpleSetup(4).facilities), { coins: 2000, unknown: [] });
    assert.deepEqual(upgradeCoinsAt(config, 2, { Farmland: [{ count: 2, level: 2 }, { count: 1, level: 1 }] }), { coins: 180, unknown: [] });
});

test('test_missing_cost_table_is_skipped_with_a_note', () => {
    const steps = rvSteps(base, { from: 5, to: 9, config, simple: true });
    // RV 9 is past MAX_HOME_LEVEL, so the list stops at 8.
    assert.deepEqual(steps.map(s => [s.rv, s.input === null]), [[6, true], [7, false], [8, true]]);
    assert.equal(steps[0].note, 'no cost table for RV 6');
    // The stock goes to the first step that has a cost.
    assert.deepEqual(steps[1].input.level_up.stock, [['coins', 500], ['wood_block', 100]]);
    assert.deepEqual(rvSteps(base, { from: 5, to: 5, config }), []);
});

test('test_item_goal_input', () => {
    const input = itemGoalInput(base, 'jam', 40, 5);
    assert.deepEqual(input.level_up, { cost: [['jam', 40]], stock: [['jam', 5]] });
    assert.deepEqual(input.priorities, []);
    assert.deepEqual(input.facilities, base.facilities);
    assert.deepEqual(itemGoalInput(base, 'jam', 40, 0).level_up.stock, []);
    assert.deepEqual(base.level_up.cost, [['coins', 1]]);
});

const plan = {
    success: true,
    rate_per_second: 2,
    income_streams: [
        { item_name: 'jam', units_per_second: 0.01, lead_time_seconds: 100 },
        { item_name: 'jam__by1', units_per_second: 0.01, lead_time_seconds: 300 },
        { item_name: 'wheat', units_per_second: 0.5, lead_time_seconds: 0 },
    ],
    coin_items: [
        { facility: 'Farmland', item_name: 'wheat', facility_count: 6, status: 'producing' },
        { facility: 'Jam Press', item_name: 'jam__by1', facility_count: 1, status: 'producing' },
        { facility: 'Jam Press', item_name: 'jam', facility_count: 1, status: 'producing' },
        { facility: 'Well', item_name: null, facility_count: 1, status: 'idle' },
    ],
    level_up: {
        seconds: 5000,
        requirements: [
            { name: 'coins', need: 100, have: 0, per_second: 2, seconds: 50 },
            { name: 'jam', need: 40, have: 0, per_second: 0.02, seconds: 2000 },
        ],
    },
};

test('test_at_current_plan_counts_each_stream_from_its_lead', () => {
    // 0.01/s from 100 s, another 0.01/s from 300 s: 2 by 300 s, then 0.02/s for the other 3.
    assert.deepEqual(atCurrentPlan(plan, 'jam', 6, 1), { seconds: 450, perSecond: 0.02, lead: 100 });
    assert.deepEqual(atCurrentPlan(plan, 'jam', 1.5), { seconds: 250, perSecond: 0.02, lead: 100 });
    assert.equal(atCurrentPlan(plan, 'jam', 5, 9).seconds, 0);
    assert.deepEqual(atCurrentPlan(plan, 'rose', 5), { seconds: null, perSecond: 0, lead: null });
    assert.deepEqual(atCurrentPlan(null, 'rose', 5), { seconds: null, perSecond: 0, lead: null });
});

test('test_summarize_step_finds_the_slowest_requirement', () => {
    const step = summarizeStep(plan, ['jam']);
    assert.equal(step.seconds, 5000);
    assert.deepEqual(step.slowest, { name: 'jam', seconds: 2000 });
    // Roster copies merge into one row; the focus item goes first.
    assert.deepEqual(step.rows, [
        { facility: 'Jam Press', item: 'jam', count: 2 },
        { facility: 'Farmland', item: 'wheat', count: 6 },
    ]);
    const never = { ...plan, level_up: { seconds: 9, requirements: [{ name: 'jam', seconds: 3 }, { name: 'rose', seconds: null }] } };
    assert.deepEqual(summarizeStep(never).slowest, { name: 'rose', seconds: null });
    assert.deepEqual(summarizeStep({ success: true }), { seconds: null, slowest: null, rows: [] });
});

test('test_step_outcome', () => {
    assert.equal(stepOutcome(plan).status, 'ok');
    assert.deepEqual(stepOutcome({ success: false, error: 'nope' }), { status: 'failed', error: 'nope' });
    assert.deepEqual(stepOutcome({ ...plan, level_up: null, level_up_note: 'unreachable' }), { status: 'unreachable' });
    assert.deepEqual(stepOutcome({ ...plan, level_up: null, fallback_reason: 'x' }), { status: 'rejected', reason: 'x' });
});

test('test_format_days', () => {
    assert.equal(formatDays(null), 'never');
    assert.equal(formatDays(Infinity), 'never');
    assert.equal(formatDays(0), 'ready now');
    assert.equal(formatDays(1800), 'under an hour');
    assert.equal(formatDays(3600), 'about 1 hour');
    assert.equal(formatDays(7 * 3600), 'about 7 hours');
    assert.equal(formatDays(86400), 'about 1 day');
    assert.equal(formatDays(86400 * 2.54), 'about 2.5 days');
    assert.equal(formatDays(86400 * 12.6), 'about 13 days');
});

test('test_goal_items_and_saved_goal', () => {
    const recipes = [
        { name: 'wheat' }, { name: 'quick_wheat' }, { name: 'quick_rose' }, { name: 'rough_lumber', byproduct_item: null },
        { name: 'rock', byproduct_item: 'mineral_sand' }, { name: 'wheat' }, null,
    ];
    assert.deepEqual(goalItems(recipes).map(o => o.name), ['mineral_sand', 'quick_rose', 'rock', 'rough_lumber', 'wheat']);
    assert.deepEqual(goalItems(null), []);
    assert.deepEqual(readGoal('{"kind":"item","rv":7,"from":5,"item":"jam","amount":40,"have":-1,"countUpgrades":true}'),
        { kind: 'item', rv: 7, from: 5, item: 'jam', amount: 40, have: null, countUpgrades: true });
    assert.deepEqual(readGoal('{bad'), { kind: 'rv', rv: null, from: null, item: null, amount: null, have: null, countUpgrades: false });
    assert.deepEqual(readGoal(null).kind, 'rv');
});

test('test_start_level_follows_the_shared_rv_rule', () => {
    // 3 Farmland at level 3 need RV 3 (simpleSetup(3) allows 3 at level 3); 1 Mine at level 2 needs RV 4.
    const owned = { facilities: { Farmland: [{ count: 3, level: 3 }], Mine: [{ count: 0, level: 1 }] }, modules: { kitchen_module: 2 } };
    assert.equal(homeLevelCovering(owned, config), 3);
    assert.equal(homeLevelCovering({ ...owned, facilities: { ...owned.facilities, Mine: [{ count: 1, level: 2 }] } }, config), 4);
    // Without simpleSetup it is worked out from unlocks and counts.
    const bare = { MAX_HOME_LEVEL: 8, FACILITIES: [{ name: 'Farmland', unlocks: { 1: 1, 2: 4 }, counts: [2, 2, 3, 4] }] };
    assert.equal(homeLevelCovering({ facilities: { Farmland: [{ count: 3, level: 2 }] } }, bare), 4);
    assert.equal(homeLevelCovering({ facilities: { Farmland: [{ count: 9, level: 1 }] } }, bare), 8);
    // Advanced mode: the saved RV input when it covers what is owned (20 is past this config's top, 8),
    // else the lowest RV that does (playerHomeLevel in web/plan-summary.js).
    assert.equal(startLevel(owned, { config, simple: false, homeLevel: 5, context: { levelUp: false, target: 6 } }), 5);
    assert.equal(startLevel(owned, { config, simple: false, homeLevel: 20, context: { levelUp: false, target: 6 } }), 8);
    assert.equal(startLevel(owned, { config, simple: false, homeLevel: 2, context: { levelUp: false, target: 6 } }), 3);
    assert.equal(startLevel(owned, { config, simple: false, context: { levelUp: false, target: 6 } }), 3);
    // A level-up plan starts one below its target, but never below what the facilities need.
    assert.equal(startLevel(owned, { config, simple: false, homeLevel: 20, context: { levelUp: true, target: 7 } }), 6);
    assert.equal(startLevel(owned, { config, simple: false, homeLevel: 1, context: { levelUp: true, target: 2 } }), 3);
    // Simple mode: the plan's target less one, else the RV input.
    assert.equal(startLevel(owned, { config, simple: true, homeLevel: 5, context: { levelUp: false, target: 6 } }), 5);
    assert.equal(startLevel(owned, { config, simple: true, homeLevel: 4, context: null }), 4);
    assert.equal(startLevel(undefined, { config, simple: false }), 1);
});

test('test_goal_inputs_drop_lesser_aniipod_tiers_the_player_did_not_skip', () => {
    const tiers = ['aniipod', 'aniipod_pro', 'aniipod_mega'];
    const priority = { ...base, exclude: ['rose_shortbread', 'aniipod', 'aniipod_pro'] };
    assert.deepEqual(goalBase(priority, { tiers, skipped: ['aniipod'] }).exclude, ['rose_shortbread', 'aniipod']);
    assert.deepEqual(goalBase(priority, { tiers }).exclude, ['rose_shortbread']);
    assert.deepEqual(goalBase(priority).exclude, priority.exclude);
    assert.deepEqual(priority.exclude, ['rose_shortbread', 'aniipod', 'aniipod_pro']);
    const [step] = rvSteps(priority, { from: 3, to: 4, config: { ...config, ANIIPOD_TIERS: tiers }, skipped: ['aniipod_pro'] });
    assert.deepEqual(step.input.exclude, ['rose_shortbread', 'aniipod_pro']);
    assert.deepEqual(itemGoalInput(priority, 'jam', 4, 0, { tiers, skipped: [] }).exclude, ['rose_shortbread']);
});

test('shouldStop: a run stops when no plan is left or the inputs were solved again', () => {
    const previous = { tab: 'best', setup: 'best:x', setupHash: 'h1' };
    assert.equal(shouldStop(true, previous, null), true);
    assert.equal(shouldStop(true, previous, { tab: 'best', setup: 'best:x', setupHash: 'h2' }), true);
    assert.equal(shouldStop(true, previous, { tab: 'best', setup: 'best:x', setupHash: 'h1' }), false);
    // Another Aniimo setup on the same inputs is not a new solve of the inputs, so this card leaves it be.
    assert.equal(shouldStop(true, previous, { tab: 'minimum', setup: 'minimum', setupHash: 'h1' }), false);
    // Nothing running, nothing to stop; no plan to compare with, nothing to decide on.
    assert.equal(shouldStop(false, previous, null), false);
    assert.equal(shouldStop(false, previous, { setupHash: 'h2' }), false);
    assert.equal(shouldStop(true, null, { setupHash: 'h2' }), false);
});

test('test_unmakeable_names_what_the_setup_cannot_make_and_who_would', () => {
    const recipes = [
        { name: 'oak', facility: 'Woodland', facility_level: 1, byproduct_item: 'wood_block' },
        { name: 'rough_lumber', facility: 'Woodworking Bench', facility_level: 1, raw_materials: ['wood_block'] },
        { name: 'standard_planks', facility: 'Woodworking Bench', facility_level: 2, raw_materials: ['rough_lumber'] },
        { name: 'rock', facility: 'Mine', facility_level: 2, byproduct_item: 'mineral_sand' },
        { name: 'rock', facility: 'Quarry', facility_level: 3, byproduct_item: 'mineral_sand' },
        { name: 'coarse_sifted_ore', facility: 'Chimney Kiln', facility_level: 1, raw_materials: ['mineral_sand'],
          module_requirement: ['crafting_module', 2] },
        { name: 'wheat', facility: 'Farmland', facility_level: 1 },
        { name: 'quick_wheat', facility: 'Farmland', facility_level: 2 },
        { name: 'moon_wheat', facility: 'Farmland', facility_level: 1, season: true },
    ];
    const input = {
        facilities: {
            'Woodworking Bench': [{ count: 1, level: 1 }], Woodland: [{ count: 0, level: 1 }], Mine: [{ count: 1, level: 1 }],
            'Chimney Kiln': [{ count: 1, level: 1 }], Farmland: [{ count: 2, level: 1 }],
        },
        modules: { crafting_module: 1 },
    };
    // Coins are left out; wheat is made; the bench runs but nothing owned makes its Wood Blocks.
    assert.deepEqual(unmakeable(['coins', 'wheat', 'rough_lumber'], recipes, input), [
        { item: 'rough_lumber', needs: [{ item: 'wood_block', makers: [{ facility: 'Woodland', level: 1, module: null }] }] },
    ]);
    // A level too low, then the lowest level for each facility that would make it.
    assert.deepEqual(unmakeable(['standard_planks', 'mineral_sand'], recipes, input), [
        { item: 'standard_planks', needs: [{ item: 'standard_planks', makers: [{ facility: 'Woodworking Bench', level: 2, module: null }] }] },
        { item: 'mineral_sand', needs: [{ item: 'mineral_sand', makers: [
            { facility: 'Mine', level: 2, module: null }, { facility: 'Quarry', level: 3, module: null },
        ] }] },
    ]);
    // A module too low counts too, once the sand is there.
    const mined = { ...input, facilities: { ...input.facilities, Mine: [{ count: 1, level: 2 }] } };
    assert.deepEqual(unmakeable(['coarse_sifted_ore'], recipes, mined)[0].needs[0].makers,
        [{ facility: 'Chimney Kiln', level: 1, module: ['crafting_module', 2] }]);
    assert.deepEqual(unmakeable(['coarse_sifted_ore'], recipes, { ...mined, modules: { crafting_module: 2 } }), []);
    // Skipped recipes, season recipes outside the season, and an item nothing makes.
    assert.equal(unmakeable(['wheat'], recipes, { ...input, exclude: ['wheat'] }).length, 1);
    assert.equal(unmakeable(['moon_wheat'], recipes, input).length, 1);
    assert.deepEqual(unmakeable(['moon_wheat'], recipes, { ...input, season: true }), []);
    assert.deepEqual(unmakeable(['gold'], recipes, input), [{ item: 'gold', needs: [{ item: 'gold', makers: [] }] }]);
    assert.deepEqual(unmakeable(['wheat'], null, input), [{ item: 'wheat', needs: [{ item: 'wheat', makers: [] }] }]);
});
