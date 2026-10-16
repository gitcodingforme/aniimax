import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULTS, adaptPlan, aimInput, cappedRows, fillSeconds, firstCollectBy, levelUpLosses, longRecipes, readSettings, rowRates,
    unknownCapRows, windowCoins, windowSecondsFor, writeSettings,
} from '../web/session.js';
import { planRows } from '../web/reminders.js';
import { stripVariant } from '../web/plan-summary.js';

// Shaped like find_plan's answer (JsProductionPlan in src/wasm.rs), cut down to what matters here.
const plan = {
    success: true,
    rate_per_second: 1,
    coin_items: [
        { item_name: 'rice', facility: 'Farmland', facility_count: 9, status: 'producing', is_grower: true, cycle_time: 1800 },
        { item_name: 'rock', facility: 'Mine', facility_count: 2, status: 'producing', is_grower: true, cycle_time: 600 },
        { item_name: 'milled_rice', facility: 'Carousel Mill', facility_count: 1, status: 'producing', is_grower: false, cycle_time: 200 },
        { item_name: 'rose__uncovered__by2', facility: 'Farmland', facility_count: 1, status: 'producing', is_grower: true, cycle_time: 7200 },
        { item_name: 'rose__by1', facility: 'Farmland', facility_count: 2, status: 'producing', is_grower: true, cycle_time: 5400 },
        { item_name: null, facility: 'Well', facility_count: 1, status: 'idle', is_grower: true, cycle_time: null },
    ],
    income_streams: [
        { item_name: 'milled_rice', facility: 'Carousel Mill', rate_per_second: 0.5, lead_time_seconds: 2000 },
        { item_name: 'rock', facility: 'Mine', rate_per_second: 0.25, lead_time_seconds: 0 },
        { item_name: 'rose', facility: 'Farmland', rate_per_second: 0.25, lead_time_seconds: 0 },
    ],
};
// The roses' variant names find no recipe, so their batch size (and fill time) is unknown.
const recipes = [
    { name: 'rice', facility: 'Farmland', yield_amount: 18, facility_level: 1 },
    { name: 'rock', facility: 'Mine', yield_amount: 6, facility_level: 1 },
    { name: 'milled_rice', facility: 'Carousel Mill', yield_amount: 1, facility_level: 2 },
    { name: 'rose', facility: 'Farmland', yield_amount: 2, facility_level: 1 },
];
const facilities = { Farmland: [{ count: 12, level: 7 }], Mine: [{ count: 2, level: 3 }], 'Carousel Mill': [{ count: 1, level: 4 }] };
const caps = { Farmland: [null, 10, 15, 20, 25, 30, 35], Mine: [200, 200, 200, 200, 200, 200], 'Carousel Mill': [20, 20, 20, 20, 20, 20] };
const rows = planRows(plan, { recipes, facilities });
const HOUR = 3600;

// A planner stand-in: the plan's rows minus every excluded recipe, plus `extra[name]` rows that
// show up once `name` is excluded. Records each input it was asked.
function fakePlanner(extra = {}) {
    const calls = [];
    const findPlan = async (input, { signal } = {}) => {
        calls.push(input);
        if (signal?.aborted) throw new Error('cancelled');
        const out = new Set(input.exclude);
        const pool = [...plan.coin_items, ...Object.entries(extra).filter(([name]) => out.has(name)).flatMap(([, list]) => list)];
        const coin_items = pool.filter(s => !s.item_name || !out.has(stripVariant(s.item_name)));
        return { ...plan, coin_items };
    };
    return { findPlan, calls };
}
const step = (item_name, cycle_time, facility = 'Farmland') => ({ item_name, facility, facility_count: 1, status: 'producing', is_grower: true, cycle_time });

test('test_long_recipes_strip_variants_and_dedupe', () => {
    assert.deepEqual(longRecipes(plan, 40 * 60), ['rose']);
    assert.deepEqual(longRecipes(plan, 100), ['rice', 'rock', 'milled_rice', 'rose']);
    assert.deepEqual(longRecipes(plan, 1800), ['rose'], 'a batch exactly as long as the window fits');
    assert.deepEqual(longRecipes(plan, 8 * HOUR), []);
    assert.deepEqual(longRecipes(null, 60), []);
});

test('test_fill_seconds_with_and_without_a_cap', () => {
    const [rice, rock, mill, roseA] = rows;
    // Farmland 7 holds 35 rice, one harvest of 18: full after the first batch.
    assert.equal(fillSeconds(rice, caps), 1800);
    // Mine 3: 200 rock at 6 a batch is 33 batches of 600 s.
    assert.equal(fillSeconds(rock, caps), 33 * 600);
    // Processor: the same moment as the reminders' collect event (2000 s lead, then 20 batches).
    assert.equal(fillSeconds(mill, caps), 2000 + 20 * 200);
    assert.equal(fillSeconds(roseA, caps), null, 'no batch size known');
    assert.equal(fillSeconds({ ...rice, level: 1 }, caps), null, 'no cap known at level 1');
    assert.equal(fillSeconds(rock, null), null, 'no caps table');
    assert.equal(fillSeconds({ ...rock, cycleSeconds: 0 }, caps), null);
});

test('test_capped_rows_are_those_full_before_the_window_ends', () => {
    assert.deepEqual(cappedRows(rows, caps, HOUR).map(r => [r.item, r.fillSeconds]), [['rice', 1800]]);
    assert.deepEqual(cappedRows(rows, caps, 8 * HOUR).map(r => [r.key, r.fillSeconds]), [
        ['Farmland|rice', 1800], ['Carousel Mill|milled_rice', 6000], ['Mine|rock', 19800],
    ]);
    assert.deepEqual(cappedRows(rows, caps, 1800), [], 'full exactly at the end still counts as fitting');
    assert.deepEqual(unknownCapRows(rows, caps).map(r => r.item), ['rose__uncovered__by2', 'rose__by1']);
    assert.equal(unknownCapRows(rows, null).length, rows.length);
});

test('test_first_collect_by_is_the_earliest_fill', () => {
    assert.deepEqual(firstCollectBy(rows, caps), { key: 'Farmland|rice', item: 'rice', facility: 'Farmland', fillSeconds: 1800 });
    assert.equal(firstCollectBy(rows.slice(1), caps).item, 'milled_rice');
    assert.equal(firstCollectBy(rows, null), null);
    assert.equal(firstCollectBy([], caps), null);
});

test('test_window_coins_are_capped_by_fill_times_and_the_window', () => {
    // Shares from income_streams: mill 0.5, rock 0.25, roses 0.25 (split 1:2 by facility count), rice feeds the mill.
    const { perRow, unmatched, prorated } = rowRates(plan, rows);
    assert.deepEqual(perRow.map(n => Math.round(n * 1200) / 1200), [0, 0.25, 0.5, 0.25 / 3, 0.5 / 3]);
    assert.equal(unmatched, 0);
    assert.equal(prorated, false);
    // Inside every fill time the estimate is the plain rate times the window.
    assert.ok(Math.abs(windowCoins(plan, rows, caps, HOUR) - HOUR) < 1e-6);
    // Overnight: the mill stops at 6000 s and the mine at 19800 s; the roses (cap unknown) run all night.
    const night = windowCoins(plan, rows, caps, 8 * HOUR);
    assert.ok(Math.abs(night - (0.5 * 6000 + 0.25 * 19800 + 0.25 * 8 * HOUR)) < 1e-6, String(night));
    assert.ok(night <= plan.rate_per_second * 8 * HOUR);
    // Without income_streams the rate is split evenly by row.
    const bare = { ...plan, income_streams: undefined };
    assert.equal(rowRates(bare, rows).prorated, true);
    assert.ok(Math.abs(windowCoins(bare, rows, caps, 8 * HOUR) - 0.2 * (1800 + 19800 + 6000 + 2 * 8 * HOUR)) < 1e-6);
    // A product no row makes is not capped.
    const byproduct = { ...plan, income_streams: [{ item_name: 'pollen', facility: 'Farmland', rate_per_second: 2 }] };
    assert.equal(windowCoins(byproduct, rows, caps, 8 * HOUR), 8 * HOUR);
    assert.equal(windowCoins({ success: false }, rows, caps, HOUR), null);
    assert.equal(windowCoins(plan, rows, caps, 0), null);
});

test('test_adapt_plan_session_converges_and_keeps_the_input', async () => {
    const { findPlan, calls } = fakePlanner({ rose: [step('tulip', 3000)], tulip: [step('wheat', 600)] });
    const base = { exclude: ['jam'], priorities: [] };
    const result = await adaptPlan({ base, plan, mode: 'session', windowSeconds: 40 * 60, findPlan, recipes, facilities, caps });
    assert.deepEqual(result.excluded, ['rose', 'tulip']);
    assert.equal(result.rounds, 2);
    assert.equal(result.complete, true);
    assert.deepEqual(result.remaining, []);
    assert.deepEqual(calls.map(c => c.exclude), [['jam', 'rose'], ['jam', 'rose', 'tulip']]);
    assert.deepEqual(base.exclude, ['jam'], 'the input is not changed');
    assert.ok(result.plan.coin_items.some(s => s.item_name === 'wheat'));
    // Nothing to leave out: the plan comes back as it is, unsolved.
    const fits = await adaptPlan({ base, plan, mode: 'session', windowSeconds: 3 * HOUR, findPlan, recipes, facilities, caps });
    assert.equal(fits.plan, plan);
    assert.equal(fits.rounds, 0);
    assert.equal(calls.length, 2);
});

test('test_adapt_plan_respects_max_rounds', async () => {
    const { findPlan, calls } = fakePlanner({ rose: [step('tulip', 3000)], tulip: [step('lily', 3600)] });
    const result = await adaptPlan({ base: { exclude: [] }, plan, mode: 'session', windowSeconds: 40 * 60, findPlan, maxRounds: 1 });
    assert.equal(calls.length, 1);
    assert.equal(result.rounds, 1);
    assert.equal(result.complete, false);
    assert.deepEqual(result.remaining, ['tulip']);
    assert.deepEqual(result.excluded, ['rose']);
});

test('test_adapt_plan_overnight_drops_rows_that_fill_and_lists_unknown_caps', async () => {
    const { findPlan } = fakePlanner();
    const seen = [];
    const result = await adaptPlan({
        base: { exclude: [] }, plan, mode: 'overnight', windowSeconds: 8 * HOUR, findPlan, recipes, facilities, caps,
        onRound: (n, excluded) => seen.push([n, excluded.length]),
    });
    assert.deepEqual(result.excluded, ['rice', 'milled_rice', 'rock']);
    assert.equal(result.complete, true);
    assert.deepEqual(result.unknown.map(r => r.item), ['rose__uncovered__by2', 'rose__by1'], 'unknown caps count as never filling');
    assert.deepEqual(seen, [[1, 3]]);
});

test('test_adapt_plan_returns_null_when_everything_is_left_out', async () => {
    const { findPlan, calls } = fakePlanner();
    const all = await adaptPlan({ base: { exclude: [] }, plan, mode: 'session', windowSeconds: 100, findPlan, recipes, facilities, caps });
    assert.equal(all.plan, null);
    assert.equal(all.complete, false);
    assert.deepEqual(all.excluded, ['rice', 'rock', 'milled_rice', 'rose']);
    assert.equal(calls.length, 0, 'not solved when every recipe would be excluded');
    // Without a recipe list the planner is asked, and an empty answer is no plan either.
    const empty = await adaptPlan({ base: { exclude: [] }, plan, mode: 'session', windowSeconds: 100, findPlan });
    assert.equal(empty.plan, null);
    assert.equal(empty.rounds, 1);
    assert.match(empty.error, /Nothing is left/);
});

test('test_adapt_plan_solves_the_base_first_without_a_plan', async () => {
    const { findPlan, calls } = fakePlanner();
    const base = aimInput({ exclude: [], priorities: ['aniimo_exp'], level_up: { cost: [['coins', 5]] } }, 'coins');
    const result = await adaptPlan({ base, mode: 'session', windowSeconds: 40 * 60, findPlan });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].priorities, ['coins']);
    assert.equal(calls[0].level_up, null);
    assert.equal(result.rounds, 1);
    assert.deepEqual(result.excluded, ['rose']);
    const failing = await adaptPlan({ base, mode: 'session', windowSeconds: 60, findPlan: async () => ({ success: false, error: 'boom' }) });
    assert.deepEqual([failing.plan, failing.error], [null, 'boom']);
});

test('test_adapt_plan_honours_an_aborted_signal', async () => {
    const { findPlan, calls } = fakePlanner();
    const early = new AbortController();
    early.abort();
    await assert.rejects(adaptPlan({ base: { exclude: [] }, plan, mode: 'session', windowSeconds: 60, findPlan, signal: early.signal }), /cancelled/);
    assert.equal(calls.length, 0);
    // Stopped while a solve runs: the answer that comes back anyway is not used.
    const late = new AbortController();
    const slow = async (input) => {
        late.abort();
        return findPlan(input);
    };
    await assert.rejects(adaptPlan({ base: { exclude: [] }, plan, mode: 'session', windowSeconds: 40 * 60, findPlan: slow, signal: late.signal }), /cancelled/);
    await assert.rejects(adaptPlan({ base: { exclude: [] }, plan, mode: 'later', windowSeconds: 60, findPlan }), /unknown session mode/);
    await assert.rejects(adaptPlan({ base: { exclude: [] }, plan, mode: 'session', windowSeconds: 0, findPlan }), /positive/);
});

test('test_settings_aim_and_level_up_losses', () => {
    assert.deepEqual(readSettings(null), { ...DEFAULTS });
    assert.deepEqual(readSettings('not json'), { ...DEFAULTS });
    assert.deepEqual(readSettings('{"mode":"overnight","minutes":5000,"hours":7.3}'), { mode: 'overnight', minutes: 720, hours: 7.5 });
    assert.equal(writeSettings({ mode: 'session', minutes: '25', hours: -1 }), '{"mode":"session","minutes":25,"hours":8}');
    assert.equal(windowSecondsFor({ mode: 'session', minutes: 40 }), 2400);
    assert.equal(windowSecondsFor({ mode: 'overnight', hours: 8 }), 8 * HOUR);
    const input = { exclude: ['jam'], priorities: ['aniipods'], level_up: { cost: [] } };
    assert.equal(aimInput(input, 'strategy'), input);
    assert.deepEqual(aimInput(input, 'coins'), { exclude: ['jam'], priorities: ['coins'], level_up: null });
    const levelUp = { level_up: { requirements: [{ name: 'coins' }, { name: 'rough_lumber' }, { name: 'mineral_sand' }] } };
    const chain = [{ name: 'rough_lumber', ingredients: ['wood_block'] }, { name: 'wood_block', ingredients: [] }];
    assert.deepEqual(levelUpLosses(levelUp, ['wood_block__by1', 'rice'], chain), ['wood_block']);
    assert.deepEqual(levelUpLosses(levelUp, ['mineral_sand']), ['mineral_sand']);
    assert.deepEqual(levelUpLosses({ level_up: null }, ['rice']), []);
});

test('test_coins_only_drops_lesser_aniipod_tiers_the_player_did_not_skip', () => {
    const tiers = ['aniipod', 'aniipod_pro', 'aniipod_mega'];
    const input = { exclude: ['jam', 'aniipod', 'aniipod_pro'], priorities: ['aniipods', 'coins'], level_up: null };
    assert.deepEqual(aimInput(input, 'coins', { aniipodTiers: tiers, skipped: ['jam', 'aniipod_pro'] }).exclude, ['jam', 'aniipod_pro']);
    assert.deepEqual(aimInput(input, 'coins', { aniipodTiers: tiers }).exclude, ['jam']);
    assert.deepEqual(input.exclude, ['jam', 'aniipod', 'aniipod_pro'], 'the input is not changed');
    assert.equal(aimInput(input, 'strategy', { aniipodTiers: tiers }), input, 'my strategy keeps them out');
});

test('test_rows_that_do_not_repeat_stop_after_one_batch', async () => {
    const [rice, rock, mill, roseA, roseB] = rows;
    const off = { processorsRepeat: false, plotsResow: false };
    assert.equal(fillSeconds(mill, caps, off), 2200, 'the first batch, after its ingredients arrive');
    assert.equal(fillSeconds(roseA, caps, off), 7200, 'a crop not re-sown is done after one batch, cap known or not');
    assert.equal(fillSeconds(rice, caps, off), 1800);
    assert.equal(fillSeconds(rock, caps, off), 19800, 'gatherers always repeat');
    assert.equal(fillSeconds(mill, caps, null), 6000, 'no settings means the defaults');
    assert.deepEqual(cappedRows(rows, caps, 8 * HOUR, off).map(r => [r.item, r.fillSeconds]), [
        ['rice', 1800], ['milled_rice', 2200], ['rose__by1', 5400], ['rose__uncovered__by2', 7200], ['rock', 19800],
    ]);
    assert.deepEqual(unknownCapRows(rows, caps, off), []);
    assert.equal(firstCollectBy([mill, roseB], caps, off).fillSeconds, 2200);
    const night = windowCoins(plan, rows, caps, 8 * HOUR, off);
    assert.ok(Math.abs(night - (0.5 * 2200 + 0.25 * 19800 + (0.25 / 3) * 7200 + (0.5 / 3) * 5400)) < 1e-6, String(night));
    // Overnight with nothing repeating, every row stops before morning: nothing fits.
    const { findPlan, calls } = fakePlanner();
    const result = await adaptPlan({
        base: { exclude: [] }, plan, mode: 'overnight', windowSeconds: 8 * HOUR, findPlan, recipes, facilities, caps, assumptions: off,
    });
    assert.equal(result.plan, null);
    assert.deepEqual(result.excluded, ['rice', 'milled_rice', 'rose', 'rock']);
    assert.equal(calls.length, 0);
});
