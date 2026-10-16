import assert from 'node:assert/strict';
import test from 'node:test';

import { makeSnapshot } from '../web/history.js';
import { gaps, gapsWithin, guesses, intervals, shareOfRate } from '../web/insight.js';
import { planRows } from '../web/reminders.js';
import { mount } from '../web/cards/insight.js';

const T0 = Date.parse('2026-10-14T08:00:00Z');
const H = 3_600_000;
const iso = hours => new Date(T0 + hours * H).toISOString();
const setup = { facilityTiers: { Farmland: [{ count: 4, level: 1 }] }, 'home-level': '5', 'aniimo-best': true };

function snap(hours, coins, perHour = 1000, extra = {}) {
    return makeSnapshot({
        setup: { ...setup, ...extra }, actual: coins === null ? {} : { rv: 5, coins }, now: iso(hours),
        predicted: perHour === null ? null : { coinsPerHour: perHour, strategy: 'priorities', levelUp: null, proven: true, fallback: null },
    });
}
const pt = (hours, coins) => ({ t: T0 + hours * H, coins });

test('test_intervals_use_rising_watcher_stretches_and_note_spending', () => {
    const snapshots = [snap(0, 1000), snap(4, 900), snap(10, 3900, null)];
    // 500 coins an hour for three hours, with a drop (spending) between hour 2 and hour 3.
    const series = [pt(0, 1000), pt(1, 1500), pt(2, 2000), pt(3, 400), pt(4, 900)];
    const list = intervals(snapshots, series);
    assert.equal(list.length, 2);
    assert.deepEqual([list[0].from, list[0].to, list[0].hours, list[0].source, list[0].spent], [iso(0), iso(4), 4, 'watcher', true]);
    assert.equal(list[0].predictedPerHour, 1000);
    assert.equal(list[0].actualPerHour, 500);
    assert.equal(list[0].share, 0.5);
    // The second stretch has no watcher readings of its own, so the two snapshots' balances are used.
    assert.deepEqual([list[1].source, list[1].spent, list[1].hours, list[1].actualPerHour, list[1].share], ['snapshots', false, 6, 500, 0.5]);
});

test('test_intervals_fall_back_to_the_snapshots_balances', () => {
    const rose = intervals([snap(0, 100), snap(2, 2100)], []);
    assert.deepEqual(rose.map(r => [r.source, r.actualPerHour, r.share, r.spent]), [['snapshots', 1000, 1, false]]);
    // A balance that dropped: coins were spent, so the pace cannot be told.
    const dropped = intervals([snap(0, 5000), snap(2, 300)], []);
    assert.deepEqual(dropped.map(r => [r.actualPerHour, r.share, r.spent]), [[null, null, true]]);
    // No coins on either side and no watcher: nothing to compare. No prediction: no row.
    assert.deepEqual(intervals([snap(0, null), snap(2, null)], []), []);
    assert.deepEqual(intervals([snap(0, 100, null), snap(2, 900)], []), []);
    // A watcher with under half an hour of rising readings falls back too.
    const thin = intervals([snap(0, 100), snap(2, 2100)], [pt(1, 500), pt(1.25, 600)]);
    assert.equal(thin[0].source, 'snapshots');
});

test('test_short_intervals_are_skipped', () => {
    assert.deepEqual(intervals([snap(0, 100), snap(1 / 3, 900)], []), []);
    assert.equal(intervals([snap(0, 100), snap(0.5, 900)], []).length, 1);
    assert.deepEqual(intervals([], []), []);
    assert.deepEqual(intervals(null, null), []);
});

test('test_gaps_are_stretches_without_readings', () => {
    const series = [pt(0, 1), pt(1 / 6, 2), pt(2 / 3, 3), pt(5 / 6, 4), pt(2, 5)];
    assert.deepEqual(gaps(series).map(g => g.minutes), [30, 70]);
    assert.deepEqual(gaps(series, 60).map(g => [g.from, g.to, g.minutes]), [[T0 + 5 / 6 * H, T0 + 2 * H, 70]]);
    assert.deepEqual(gaps([pt(0, 1)]), []);
    assert.deepEqual(gaps(null), []);
    // Cut to an interval: only the part inside the window counts.
    assert.deepEqual(gapsWithin(gaps(series), T0 + H, T0 + 3 * H).map(g => g.minutes), [60]);
    assert.deepEqual(gapsWithin(gaps(series), T0 + 3 * H, T0 + 4 * H), []);
});

// A crop row (Wheat, 40% of the income) and a processor (Flour, 60%) whose first batch waits 1500 s.
const result = {
    success: true,
    rate_per_second: 1, // 3600 coins an hour
    coin_items: [
        { item_name: 'wheat', facility: 'Farmland', facility_count: 4, status: 'producing', is_grower: true, cycle_time: 1200, busy_units: 4 },
        { item_name: 'flour', facility: 'Carousel Mill', facility_count: 1, status: 'producing', is_grower: false, cycle_time: 300, busy_units: 1 },
    ],
    income_streams: [
        { item_name: 'wheat', facility: 'Farmland', rate_per_second: 0.4, lead_time_seconds: 0 },
        { item_name: 'flour', facility: 'Carousel Mill', rate_per_second: 0.6, lead_time_seconds: 1500 },
    ],
};
const recipes = [
    { name: 'wheat', facility: 'Farmland', yieldAmount: 8, facilityLevel: 1 },
    { name: 'flour', facility: 'Carousel Mill', yieldAmount: 1, facilityLevel: 1 },
];
const facilities = { Farmland: [{ count: 4, level: 1 }], 'Carousel Mill': [{ count: 1, level: 1 }] };
const caps = { Farmland: [40], 'Carousel Mill': [50] }; // wheat fills in 5 x 1200 s, flour in 50 x 300 s
const rows = planRows(result, { recipes, facilities });
const topic = { plan: result, setupHash: 'aaaa', tab: 'custom' };
const longGap = [{ from: T0, to: T0 + 10 * H, minutes: 600 }];
const base = { plan: topic, rows, caps, gaps: longGap, setup: { 'aniimo-best': true }, shortfallPerHour: 5000, snapshotHash: 'aaaa', hours: 12 };
const byCause = (list, cause) => list.filter(g => g.cause === cause);

test('test_share_of_rate_uses_income_streams_or_prorates', () => {
    const shares = shareOfRate(rows, topic);
    assert.ok(Math.abs(shares.get('Farmland|wheat') - 0.4) < 1e-9);
    assert.ok(Math.abs(shares.get('Carousel Mill|flour') - 0.6) < 1e-9);
    // An ingredient with no stream of its own counts for nothing.
    assert.equal(shareOfRate(rows, { plan: { ...result, income_streams: [result.income_streams[1]] } }).get('Farmland|wheat'), 0);
    // Without streams: by batches finished per second (both rows finish 1 per 300 s here).
    const prorated = shareOfRate(rows, { plan: { ...result, income_streams: [] } });
    assert.ok(Math.abs(prorated.get('Farmland|wheat') - 0.5) < 1e-9);
    assert.equal(shareOfRate([], topic).size, 0);
});

test('test_each_guess_type_is_sized_from_the_plan_and_sorted', () => {
    const list = guesses(base);
    assert.deepEqual(list.map(g => [g.cause, g.coinsPerHour, g.confidence]), [
        ['output-capped', 1050, 'high'],   // flour: 0.6 x 3600 x (36000 - 15000) s / 3600 / 12 h
        ['output-capped', 1000, 'high'],   // wheat: 0.4 x 3600 x (36000 - 6000) s / 3600 / 12 h
        ['watering', 360, 'medium'],       // 25% of the crops' 1440 an hour
        ['lead-time', 75, 'medium'],       // flour's 1500 s delay, 2160 an hour, over 12 h
        ['best-team', null, 'medium'],
        ['unsold', null, 'low'],
    ]);
    assert.match(list[0].text, /Flour/);
    assert.match(list[1].text, /Wheat/);
    assert.match(list[4].text, /best possible Aniimo/);
    assert.match(list[5].text, /only count when sold/);
});

test('test_guesses_never_exceed_the_shortfall', () => {
    const list = guesses({ ...base, shortfallPerHour: 500 });
    assert.deepEqual(list.slice(0, 4).map(g => g.coinsPerHour), [500, 500, 360, 75]);
    // A gap shorter than the fill time loses nothing; with no gap there is no capped guess, and the watering guess is only low confidence.
    assert.deepEqual(byCause(guesses({ ...base, gaps: [{ from: 0, to: 1, minutes: 60 }] }), 'output-capped'), []);
    const noGap = guesses({ ...base, gaps: [] });
    assert.deepEqual(byCause(noGap, 'output-capped'), []);
    assert.equal(byCause(noGap, 'watering')[0].confidence, 'low');
});

test('test_row_level_guesses_need_the_same_setup_hash', () => {
    const other = guesses({ ...base, snapshotHash: 'bbbb' });
    assert.deepEqual(other.map(g => g.cause), ['best-team', 'unsold']);
    assert.deepEqual(guesses({ ...base, snapshotHash: null }).map(g => g.cause), ['best-team', 'unsold']);
    assert.deepEqual(guesses({ ...base, plan: null, rows: [] }).map(g => g.cause), ['best-team', 'unsold']);
    // The best-team guess comes from the snapshot's setup, or from the plan's tab when it is the same setup.
    assert.deepEqual(guesses({ ...base, rows: [], setup: { 'aniimo-best': false } }).map(g => g.cause), ['unsold']);
    assert.deepEqual(guesses({ ...base, rows: [], setup: {}, plan: { ...topic, tab: 'best' } }).map(g => g.cause), ['best-team', 'unsold']);
    assert.deepEqual(guesses({ ...base, rows: [], setup: {}, plan: { ...topic, tab: 'best' }, snapshotHash: 'bbbb' }).map(g => g.cause), ['unsold']);
});

test('test_the_card_shows_the_table_and_guesses', () => {
    const nodes = {};
    const el = {
        set innerHTML(html) { this.html = html; },
        querySelector(selector) { return (nodes[selector] ||= { innerHTML: '', textContent: '' }); },
    };
    const history = [snap(0, 1000), snap(4, 900), snap(10, 3900, null)];
    const ctx = {
        config: { OUTPUT_CAPS: caps },
        format: { escape: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'), number: n => String(n) },
        addStylesheet: href => { ctx.sheets.push(href); },
        sheets: [],
        on: (topic, fn) => { fn(); return () => {}; },
        last: () => ({ plan: result, input: { facilities }, setupHash: history[0].setupHash, tab: 'custom' }),
        getHistory: () => history,
        getCoinSeries: () => [],
        getRecipes: () => recipes,
    };
    mount(el, ctx);
    assert.deepEqual(ctx.sheets, ['css/insight.css']);
    assert.match(el.html, /Why am I behind\?/);
    assert.match(el.html, /Guesses, not measurements/);
    assert.match(nodes['#insight-table'].innerHTML, /50%/);
    assert.match(nodes['#insight-table'].innerHTML, /delta-down/);
    assert.match(nodes['#insight-guesses'].innerHTML, /only count when sold/);
    // Row levels come from the plan's own input (Simple mode hides the saved Advanced tiers).
    assert.match(nodes['#insight-guesses'].innerHTML, /watering|ask for water/);
    // Too little to compare: the empty state.
    ctx.getHistory = () => [];
    mount(el, ctx);
    assert.match(nodes['#insight-status'].textContent, /Save two snapshots/);
});
