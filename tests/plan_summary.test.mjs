import assert from 'node:assert/strict';
import test from 'node:test';

import { diffPlans, stripVariant, summarizePlan } from '../web/plan-summary.js';

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
