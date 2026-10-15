import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MAX_SNAPSHOTS, addSnapshots, diffSetups, formatSeconds, historyFile, historyFilename, makeSnapshot,
    coinChartSvg, coinSeries, compactNumber, niceTicks, paceRows, parseHistoryFile, predictedCoinLine, predictionFrom, rvChartSvg, rvSeries, setupHash,
} from '../web/history.js';

const setup = {
    facilityTiers: { Farmland: [{ count: 4, level: 2 }], Mine: [{ count: 1, level: 1 }] },
    levelUpStock: { wood_block: 40 },
    skippedRecipes: ['quick_potato'],
    unlockedSpecial: [],
    priorities: [{ target: 'coins', on: true }, { target: 'aniimo_exp', on: false }],
    aniimoLevels: { Earth: 2 },
    roster: [],
    'home-level': '5',
    'mode-simple': false,
    'mode-advanced': true,
    'strategy-level-up': true,
    'strategy-priorities': false,
    'level-up-target': '6',
    'ecological-module-level': '1',
    'kitchen-module-level': '1',
    'resource-detector-level': '0',
    'crafting-module-level': '0',
    'aniimo-best': true,
    'season-on': false,
    'rate-unit': 'hour',
};

const plan = {
    success: true, rate_per_second: 3.977, proven_optimal: true, fallback_reason: null,
    level_up: { seconds: 48780, requirements: [{ name: 'rough_lumber', need: 1100, have: 0, per_second: 0.012 }] },
};

function snap(id, rv, extra = {}) {
    return makeSnapshot({ setup: { ...setup, 'home-level': String(rv) }, actual: { rv, coins: 100 }, now: id, ...extra });
}

test('test_setup_hash_ignores_key_order_and_sees_changes', () => {
    const reordered = Object.fromEntries(Object.entries(setup).reverse());
    assert.equal(setupHash(setup), setupHash(reordered));
    assert.match(setupHash(setup), /^[0-9a-f]{8}$/);
    assert.notEqual(setupHash(setup), setupHash({ ...setup, 'home-level': '6' }));
    assert.equal(setupHash(setup), setupHash({ ...setup, 'rate-unit': 'minute', 'target-amount': '99' }));
});

test('test_prediction_keeps_the_numbers_that_matter', () => {
    const predicted = predictionFrom(plan, { levelUp: true, target: '6' });
    assert.deepEqual(predicted, {
        coinsPerHour: 14317, strategy: 'level_up', proven: true, fallback: null,
        levelUp: { target: 6, seconds: 48780, requirements: [{ name: 'rough_lumber', need: 1100, have: 0, perSecond: 0.012 }] },
    });
    assert.equal(predictionFrom({ ...plan, level_up: null, proven_optimal: false, fallback_reason: 'timeout' }, { levelUp: false }).levelUp, null);
    assert.equal(predictionFrom({ ...plan, fallback_reason: 'timeout' }, {}).fallback, 'timeout');
    assert.equal(predictionFrom(null, {}), null);
    assert.equal(predictionFrom({ success: false }, {}), null);
});

test('test_snapshots_are_dated_sorted_deduplicated_and_capped', () => {
    const s = snap('2026-10-14T19:00:00Z', 5, { note: 'first', predicted: predictionFrom(plan, { levelUp: true, target: 6 }), site: { appVersion: '0.17.1' } });
    assert.equal(s.id, '2026-10-14T19:00:00.000Z');
    assert.equal(s.setupHash, setupHash(s.setup));
    assert.deepEqual(s.actual, { rv: 5, coins: 100 });
    assert.equal(s.site.appVersion, '0.17.1');
    assert.throws(() => makeSnapshot({ setup: {} }), /needs the current setup/);
    assert.deepEqual(makeSnapshot({ setup, actual: { rv: 0, coins: -1 } }).actual, {});

    let list = addSnapshots([], [snap('2026-10-15T00:00:00Z', 6), s]);
    assert.deepEqual(list.map(x => x.actual.rv), [5, 6]);
    list = addSnapshots(list, { ...s, note: 'replaced' });
    assert.equal(list.length, 2);
    assert.equal(list[0].note, 'replaced');
    list = addSnapshots(list, [{ id: 'garbage' }, null, { id: '2026-10-16T00:00:00Z' }]);
    assert.equal(list.length, 2);
    const many = Array.from({ length: MAX_SNAPSHOTS + 5 }, (_, i) => snap(new Date(Date.UTC(2026, 0, 1) + i * 3600_000), 5));
    const capped = addSnapshots([], many);
    assert.equal(capped.length, MAX_SNAPSHOTS);
    assert.equal(capped[0].id, many[5].id);
});

test('test_rv_series_and_pace_pair_predictions_with_the_next_level', () => {
    const predicted = predictionFrom(plan, { levelUp: true, target: 6 });
    const list = addSnapshots([], [
        snap('2026-10-14T00:00:00Z', 5, { predicted }),
        snap('2026-10-14T12:00:00Z', 5),
        snap('2026-10-15T03:00:00Z', 6, { predicted: { ...predicted, levelUp: { ...predicted.levelUp, target: 7, seconds: 7200 } } }),
        makeSnapshot({ setup, now: '2026-10-15T04:00:00Z' }),
    ]);
    assert.deepEqual(rvSeries(list).map(p => p.rv), [5, 5, 6]);
    const rows = paceRows(list);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].target, 6);
    assert.equal(rows[0].actualSeconds, 27 * 3600);
    assert.equal(rows[0].reachedAt, '2026-10-15T03:00:00.000Z');
    assert.ok(Math.abs(rows[0].ratio - 27 * 3600 / 48780) < 1e-9);
    assert.equal(rows[1].target, 7);
    assert.equal(rows[1].actualSeconds, null);
    assert.equal(rows[1].ratio, null);
});

test('test_diff_describes_changes_in_plain_words', () => {
    const after = {
        ...setup,
        'home-level': '6',
        facilityTiers: { Farmland: [{ count: 4, level: 2 }, { count: 2, level: 3 }], Well: [{ count: 1, level: 1 }] },
        levelUpStock: { wood_block: 10, rough_lumber: 5 },
        skippedRecipes: [],
        unlockedSpecial: ['star_cookie'],
        'kitchen-module-level': '2',
        'strategy-level-up': false,
        'strategy-priorities': true,
        priorities: [{ target: 'aniimo_exp', on: true }, { target: 'coins', on: true }],
        roster: [{ name: 'Spark', count: 2, abilities: { Fire: 3 }, personalities: ['Playful'] }],
        'aniimo-best': false,
        'aniimo-custom': true,
    };
    const changes = diffSetups(setup, after);
    const byWhat = Object.fromEntries(changes.map(c => [c.what, `${c.before} -> ${c.after}`]));
    assert.equal(byWhat['RV level'], '5 -> 6');
    assert.equal(byWhat['Strategy'], 'level up to RV 6 -> priorities');
    assert.equal(byWhat['Priorities'], 'Coins -> Aniimo Exp > Coins');
    assert.equal(byWhat['Farmland'], '4×Lv.2 -> 4×Lv.2 + 2×Lv.3');
    assert.equal(byWhat['Mine'], '1×Lv.1 -> none');
    assert.equal(byWhat['Well'], 'none -> 1×Lv.1');
    assert.equal(byWhat['Kitchen Module'], '1 -> 2');
    assert.equal(byWhat['Aniimo'], 'best Aniimo -> custom roster');
    assert.equal(byWhat['Roster: Spark'], 'absent -> 2× Fire 3 (Playful)');
    assert.equal(byWhat['Stock: Wood Block'], '40 -> 10');
    assert.equal(byWhat['Stock: Rough Lumber'], '0 -> 5');
    assert.equal(byWhat['Skipped recipes'], ' -> removed Quick Potato');
    assert.equal(byWhat['Unlocked special recipes'], ' -> added Star Cookie');
    assert.equal(changes.length, 13, changes.map(c => c.what).join(', '));
    assert.deepEqual(diffSetups(setup, { ...setup, 'rate-unit': 'minute' }), []);
});

test('test_chart_and_formatting', () => {
    const svg = rvChartSvg([{ t: Date.parse('2026-10-14T00:00:00Z'), rv: 5 }, { t: Date.parse('2026-10-16T00:00:00Z'), rv: 6 }]);
    assert.match(svg, /^<svg viewBox="0 0 600 160"/);
    assert.equal((svg.match(/<circle/g) || []).length, 2);
    assert.match(svg, /2026-10-14/);
    assert.match(svg, /2026-10-16/);
    assert.equal(rvChartSvg([]), '');
    assert.equal(formatSeconds(48780), '13h 33m');
    assert.equal(formatSeconds(90 * 3600), '3d 18h');
    assert.equal(formatSeconds(125), '2m');
    assert.equal(formatSeconds(NaN), '?');
});

test('test_backup_file_round_trips_and_rejects_other_files', () => {
    const list = addSnapshots([], [snap('2026-10-14T00:00:00Z', 5), snap('2026-10-15T00:00:00Z', 6)]);
    const file = historyFile(list, { appVersion: '0.17.1' }, '2026-10-16T00:00:00Z');
    assert.equal(file.format, 'aniimax-history');
    assert.equal(file.savedAt, '2026-10-16T00:00:00.000Z');
    assert.deepEqual(parseHistoryFile(JSON.stringify(file)), list);
    const merged = addSnapshots([snap('2026-10-14T12:00:00Z', 5)], parseHistoryFile(JSON.stringify(file)));
    assert.equal(merged.length, 3);
    assert.throws(() => parseHistoryFile('{nope'), /not valid JSON/);
    assert.throws(() => parseHistoryFile('[]'), /not an Aniimax history/);
    assert.throws(() => parseHistoryFile(JSON.stringify({ format: 'aniimax-profile', version: 1 })), /not an Aniimax history/);
    assert.throws(() => parseHistoryFile(JSON.stringify({ format: 'aniimax-history', version: 9, snapshots: [] })), /version 9/);
    assert.throws(() => parseHistoryFile(JSON.stringify({ format: 'aniimax-history', version: 1 })), /no snapshots/);
    assert.throws(() => parseHistoryFile(JSON.stringify({ format: 'aniimax-history', version: 1, snapshots: [{ id: 'x' }] })), /none of the snapshots/);
    assert.deepEqual(parseHistoryFile(JSON.stringify({ format: 'aniimax-history', version: 1, snapshots: [] })), []);
    assert.equal(historyFilename(new Date(2026, 9, 14, 9, 5)), 'aniimax-2026-10-14_0905.history.json');
});

// --- Home Coins over time ---

test('coinSeries sorts by time, keeps the later of equal times and drops bad entries', () => {
    const series = coinSeries([
        { t: '2026-10-15T12:00:00Z', coins: 300 },
        { t: '2026-10-15T10:00:00Z', coins: 100 },
        { t: '2026-10-15T10:00:00Z', coins: 150 },
        { t: 'yesterday', coins: 5 },
        { t: '2026-10-15T11:00:00Z', coins: -4 },
        { t: '2026-10-15T11:30:00Z', coins: '200' },
        { t: '2026-10-15T11:45:00Z', coins: 2.5 },
        null,
        { coins: 9 },
    ]);
    assert.deepEqual(series, [
        { t: Date.parse('2026-10-15T10:00:00Z'), coins: 150 },
        { t: Date.parse('2026-10-15T12:00:00Z'), coins: 300 },
    ]);
    assert.deepEqual(coinSeries(undefined), []);
    assert.deepEqual(coinSeries({ points: [] }), []);
});

test('predictedCoinLine anchors the latest prediction at its coins or the nearest logged point', () => {
    const series = coinSeries([
        { t: '2026-10-15T09:00:00Z', coins: 1000 },
        { t: '2026-10-15T11:00:00Z', coins: 5000 },
    ]);
    const snap = (id, predicted, actual = {}) => ({ id, predicted, actual });
    assert.equal(predictedCoinLine([], series), null);
    assert.equal(predictedCoinLine([snap('2026-10-15T10:00:00.000Z', null)], series), null);
    const old = snap('2026-10-14T10:00:00.000Z', { coinsPerHour: 99 }, { coins: 7 });
    const latest = snap('2026-10-15T10:00:00.000Z', { coinsPerHour: 2000 });
    // the latest snapshot has no coins: anchor at the last point before it (the balance as last seen)
    assert.deepEqual(predictedCoinLine([old, latest], series), { from: Date.parse('2026-10-15T09:00:00Z'), coins: 1000, perHour: 2000 });
    // nothing logged before it: the first point after it
    assert.deepEqual(predictedCoinLine([old, latest], series.slice(1)), { from: Date.parse('2026-10-15T11:00:00Z'), coins: 5000, perHour: 2000 });
    // with coins recorded, anchor at the snapshot itself
    const withCoins = snap('2026-10-15T10:00:00.000Z', { coinsPerHour: 2000 }, { coins: 3000 });
    assert.deepEqual(predictedCoinLine([old, withCoins], series), { from: Date.parse('2026-10-15T10:00:00.000Z'), coins: 3000, perHour: 2000 });
    // nothing logged at all and no coins on it: no anchor
    assert.equal(predictedCoinLine([latest], []), null);
});

test('compactNumber and niceTicks give short labels and round ticks', () => {
    assert.equal(compactNumber(220000), '220k');
    assert.equal(compactNumber(1250000), '1.25M');
    assert.equal(compactNumber(950), '950');
    assert.equal(compactNumber(0), '0');
    const ticks = niceTicks(182204, 220724);
    assert.ok(ticks.length >= 3 && ticks.length <= 5, ticks.join());
    assert.ok(ticks[0] <= 182204 && ticks[ticks.length - 1] >= 220724);
    assert.ok(ticks.every(v => v % 5000 === 0), ticks.join());
    assert.ok(niceTicks(5, 5).length >= 2, 'a flat series still gets an axis');
});

test('coinChartSvg draws the dashed prediction only when a line is given', () => {
    const series = coinSeries([
        { t: '2026-10-15T09:00:00Z', coins: 182204 },
        { t: '2026-10-15T11:00:00Z', coins: 220724 },
    ]);
    assert.equal(coinChartSvg([], null), '');
    const plain = coinChartSvg(series, null);
    assert.match(plain, /^<svg viewBox="0 0 600 160"/);
    assert.match(plain, /class="history-chart-svg"/);
    assert.ok(!plain.includes('stroke-dasharray'), 'no dashed line without a prediction');
    assert.ok(!plain.includes('Plan predicted'), 'a single series needs no legend');
    assert.match(plain, /220k/);
    assert.equal((plain.match(/<circle[^>]*r="4"/g) || []).length, 2);
    const withLine = coinChartSvg(series, { from: series[0].t, coins: 182204, perHour: 20000 });
    assert.equal((withLine.match(/<path[^>]*stroke-dasharray/g) || []).length, 1);
    assert.match(withLine, /Plan predicted/);
    assert.match(withLine, /Actual/);
    const many = coinSeries(Array.from({ length: 100 }, (_, i) => ({ t: new Date(Date.UTC(2026, 9, 15, 0, i)).toISOString(), coins: 1000 + i * 10 })));
    assert.equal((coinChartSvg(many, null).match(/<circle[^>]*r="4"/g) || []).length, 1, 'many points: only the latest gets a dot');
});

test('test_coin_chart_shows_the_plan_line_for_a_snapshot_after_the_last_point_and_a_flat_series', () => {
    const t = Date.parse('2026-10-15T10:00:00Z');
    const series = [{ t: t - 3_600_000, coins: 100_000 }, { t, coins: 120_000 }];
    // A snapshot taken five minutes after the watcher's last reading still gets a visible dashed line.
    const svg = coinChartSvg(series, { from: t + 300_000, coins: 121_000, perHour: 30_000 });
    const dashed = svg.match(/<path d="M([\d.]+),[\d.]+ L([\d.]+),[\d.]+"[^>]*stroke-dasharray/);
    assert.ok(dashed, 'a dashed path is drawn');
    assert.ok(Number(dashed[2]) - Number(dashed[1]) > 100, `the dashed line spans the chart, got ${dashed[0]}`);
    // One point, or all points equal, still gets distinct axis labels and no negative axis.
    const flat = coinChartSvg([{ t, coins: 182_204 }], null);
    const labels = [...flat.matchAll(/font-size="10"[^>]*>([^<]+)<\/text>/g)].map(m => m[1]).filter(l => /k|M|^\d+$/.test(l));
    assert.equal(new Set(labels).size, labels.length, `axis labels are distinct: ${labels}`);
    const zero = coinChartSvg([{ t, coins: 0 }], null);
    assert.ok(!/>-\d/.test(zero), 'no negative tick');
});
