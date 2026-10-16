import assert from 'node:assert/strict';
import test from 'node:test';

import { compareResults, compareSetups, otherFromSetup, otherFromSnapshot, otherFromText, planMoved, rosterSummary, shouldStop } from '../web/compare.js';
import { FACILITIES, MAX_HOME_LEVEL, MODULE_MAX_LEVELS, simpleSetup } from '../web/facility-config.js';
import { makeSnapshot } from '../web/history.js';
import { buildProfile } from '../web/profile.js';

const config = {
    FACILITIES, MAX_HOME_LEVEL, simpleSetup,
    modules: Object.keys(MODULE_MAX_LEVELS),
    moduleNames: { ecological_module: 'Ecological Module', kitchen_module: 'Kitchen Module', resource_detector: 'Resource Detector', crafting_module: 'Crafting Module' },
};

const mine = {
    facilityTiers: { Farmland: [{ count: 4, level: 2 }, { count: 2, level: 1 }], Mine: [{ count: 1, level: 3 }] },
    roster: [{ name: 'A', count: 2, abilities: { Earth: 4, Grass: 3 }, personalities: [] }, { name: 'B', count: 1, abilities: { Fire: 4 }, personalities: [] }],
    'mode-simple': false, 'mode-advanced': true, 'home-level': '5',
    'ecological-module-level': '1', 'kitchen-module-level': '2',
};
const friend = {
    ...mine,
    facilityTiers: { Farmland: [{ count: 8, level: 3 }], Mine: [{ count: 1, level: 3 }], Well: [{ count: 2, level: 1 }] },
    roster: [],
    'home-level': '7',
    'kitchen-module-level': '3',
};

test('test_other_from_text_reads_a_profile_a_setup_and_refuses_the_rest', () => {
    const profile = buildProfile({ setup: friend, actual: { rv: 7, coins: 10 }, savedAt: '2026-10-14T19:05:00.000Z' });
    const fromProfile = otherFromText(JSON.stringify(profile));
    assert.equal(fromProfile.source, 'profile');
    assert.deepEqual(fromProfile.setup, friend);
    assert.deepEqual(fromProfile.actual, { rv: 7, coins: 10 });
    const fromSetup = otherFromText(JSON.stringify(friend));
    assert.equal(fromSetup.source, 'setup');
    assert.deepEqual(fromSetup.actual, {});
    assert.throws(() => otherFromText('{not json'), /not valid JSON/);
    assert.throws(() => otherFromText('   '), /Load a profile, paste a setup or pick a snapshot first/);
    assert.throws(() => otherFromText('[]'), /neither an Aniimax profile nor a homeland setup/);
    assert.throws(() => otherFromText(JSON.stringify({ format: 'aniimax-profile', version: 99, setup: friend })), /version 99/);
    assert.throws(() => otherFromText(JSON.stringify({ facilityTiers: 'x' })), /neither/);
    assert.throws(() => otherFromSetup({}), /not a homeland setup/);
});

test('test_other_from_snapshot_uses_the_saved_setup', () => {
    const snapshot = makeSnapshot({ setup: friend, actual: { rv: 7 }, now: '2026-10-01T10:00:00.000Z' });
    const other = otherFromSnapshot(snapshot);
    assert.deepEqual(other.setup, friend);
    assert.deepEqual(other.actual, { rv: 7 });
    assert.equal(other.source, 'snapshot of 2026-10-01');
    assert.throws(() => otherFromSnapshot({ id: 'x' }), /not a snapshot/);
});

test('test_compare_setups_rows_modules_and_diff', () => {
    const cmp = compareSetups(mine, friend, config);
    const row = name => cmp.facilities.find(f => f.name === name);
    assert.deepEqual(row('Farmland').a, { count: 6, levels: '4×Lv.2 + 2×Lv.1', tiers: [{ count: 4, level: 2 }, { count: 2, level: 1 }] });
    assert.equal(row('Farmland').b.levels, '8×Lv.3');
    assert.equal(row('Farmland').same, false);
    assert.equal(row('Mine').same, true);
    assert.equal(row('Well').a.levels, 'none');
    assert.equal(row('Well').b.count, 2);
    assert.ok(!cmp.facilities.some(f => f.a.count === 0 && f.b.count === 0), 'facilities neither side has are left out');
    const kitchen = cmp.modules.find(m => m.id === 'kitchen_module');
    assert.deepEqual([kitchen.name, kitchen.a, kitchen.b], ['Kitchen Module', 2, 3]);
    assert.deepEqual(cmp.rv, { a: 5, b: 7 });
    assert.equal(cmp.roster.b, 'no roster');
    assert.ok(cmp.diff.some(d => d.what === 'RV level' && d.before === '5' && d.after === '7'));
    assert.ok(cmp.diff.some(d => d.what === 'Farmland'));
    assert.equal(compareSetups(mine, mine, config).diff.length, 0);
});

test('test_simple_mode_counts_as_everything_the_rv_level_allows', () => {
    const cmp = compareSetups({ facilityTiers: {}, 'mode-simple': true, 'home-level': '3' }, { facilityTiers: {}, 'mode-simple': true, 'home-level': '4' }, config);
    const expected = simpleSetup(3).facilities.Farmland;
    assert.equal(cmp.facilities.find(f => f.name === 'Farmland').a.count, expected.reduce((n, t) => n + t.count, 0));
    assert.deepEqual(cmp.rv, { a: 3, b: 4 });
});

test('test_roster_summary', () => {
    assert.equal(rosterSummary(mine.roster), '3 Aniimo: 2× Earth 4, Grass 3; 1× Fire 4');
    assert.equal(rosterSummary([]), 'no roster');
    assert.equal(rosterSummary(undefined), 'no roster');
    assert.equal(rosterSummary([{ abilities: {} }, null]), '1 Aniimo: 1× no abilities');
});

const plan = (rate, seconds, rows) => ({
    success: true, rate_per_second: rate, proven_optimal: true,
    level_up: seconds === null ? null : { seconds },
    coin_items: rows.map(([facility, item, count]) => ({ facility, item_name: item, facility_count: count, status: 'producing', cycle_time: 60 })),
});

test('test_compare_results_deltas_and_rows', () => {
    const a = plan(1, 7200, [['Farmland', 'wheat', 4], ['Mine', 'rock', 1]]);
    const b = plan(1.5, 3600, [['Farmland', 'wheat', 6], ['Well', 'water', 2]]);
    const result = compareResults(a, b);
    assert.equal(result.a.coinsPerHour, 3600);
    assert.equal(result.b.coinsPerHour, 5400);
    assert.equal(result.deltaCoinsPerHour, 1800);
    assert.equal(result.deltaLevelUpSeconds, -3600);
    assert.deepEqual(result.rows.map(r => [r.key, r.a, r.b]), [['Farmland:wheat', 4, 6], ['Mine:rock', 1, 0], ['Well:water', 0, 2]]);
    // No level-up on one side, or a failed plan: the deltas are null, not NaN.
    const none = compareResults(a, plan(2, null, []));
    assert.equal(none.deltaLevelUpSeconds, null);
    assert.equal(none.deltaCoinsPerHour, 3600);
    const failed = compareResults(a, { success: false, error: 'no' });
    assert.equal(failed.b.ok, false);
    assert.equal(failed.deltaCoinsPerHour, null);
    assert.deepEqual(failed.rows.map(r => r.b), [0, 0]);
});

test('test_should_stop_when_the_page_plan_goes_or_moves_on', () => {
    const started = { setupHash: 'aaaa', setup: 'best:Fire4' };
    assert.equal(shouldStop(false, started, null), false, 'nothing runs, nothing to stop');
    assert.equal(shouldStop(true, started, null), true, 'the plan went away');
    assert.equal(shouldStop(true, started, { setupHash: 'aaaa', setup: 'best:Fire4' }), false, 'the same plan again');
    assert.equal(shouldStop(true, started, { setupHash: 'bbbb', setup: 'best:Fire4' }), true, 'inputs changed');
    assert.equal(shouldStop(true, started, { setupHash: 'aaaa', setup: 'minimum' }), true, 'another Aniimo tab');
    assert.equal(shouldStop(true, { setupHash: 'aaaa' }, { setupHash: 'aaaa', setup: 'minimum' }), false, 'no setup string to compare');
    assert.equal(shouldStop(true, null, { setupHash: 'aaaa', setup: 'minimum' }), false);
});

test('test_plan_moved_sees_a_tab_switch_as_well_as_a_new_hash', () => {
    const shown = { setupHash: 'aaaa', setup: 'best:Fire4' };
    assert.equal(planMoved(shown, { setupHash: 'aaaa', setup: 'best:Fire4' }), false);
    assert.equal(planMoved(shown, { setupHash: 'aaaa', setup: 'roster:[]' }), true);
    assert.equal(planMoved(shown, { setupHash: 'cccc', setup: 'best:Fire4' }), true);
    assert.equal(planMoved(shown, null), false);
});
