import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DAILY_KEY, allDone, clock, dailyItems, dayKey, doneCount, groupItems, prune, readState, snapshotNote, tickAll, toggle, untickDay, writeState,
} from '../web/daily.js';
import { planRows } from '../web/reminders.js';

// Local times throughout: the card works in the player's own day.
const at = (h, m = 0, day = 15) => new Date(2026, 9, day, h, m).getTime();
const T0 = at(8);

const plan = {
    success: true,
    coin_items: [
        { item_name: 'rice', facility: 'Farmland', facility_count: 9, status: 'producing', is_grower: true, cycle_time: 7200, busy_units: 9 },
        { item_name: 'rock', facility: 'Mine', facility_count: 2, status: 'producing', is_grower: true, cycle_time: 600, busy_units: 1.5 },
        { item_name: 'milled_rice', facility: 'Carousel Mill', facility_count: 1, status: 'producing', is_grower: false, cycle_time: 600, busy_units: 1 },
        { item_name: null, facility: 'Well', facility_count: 1, status: 'idle', is_grower: true, cycle_time: null },
    ],
    income_streams: [{ item_name: 'milled_rice', lead_time_seconds: 2000 }],
    level_up: { seconds: 25200, requirements: [
        { name: 'rice', need: 40, have: 10, per_second: 0.01, seconds: 3000 },
        { name: 'rock', need: 10, have: 10, per_second: 0.01, seconds: 0 },
        { name: 'coins', need: 5000, have: 1200, per_second: 1, seconds: 3800 },
    ] },
};
const context = { levelUp: true, target: 6, ready: false, unavailable: null };
const recipes = [
    { name: 'rice', facility: 'Farmland', yield_amount: 18, facility_level: 3 },
    { name: 'rock', facility: 'Mine', yield_amount: 6, facility_level: 1 },
    { name: 'milled_rice', facility: 'Carousel Mill', yield_amount: 1, facility_level: 2 },
];
const facilities = { Farmland: [{ count: 9, level: 7 }], Mine: [{ count: 2, level: 3 }], 'Carousel Mill': [{ count: 1, level: 4 }] };
const caps = { Farmland: [null, 10, 15, 20, 25, 30, 35], Mine: [200, 200, 200, 200, 200, 200], 'Carousel Mill': [20, 20, 20, 20, 20, 20] };
const timersFor = (p, startedAt = T0) => ({
    startedAt: new Date(startedAt).toISOString(), planHash: 'h', rows: planRows(p, { recipes, facilities }),
    levelUpSeconds: 25200, levelUpTarget: 6, sent: [], sentTopic: null,
});
const lines = (items, group) => items.filter(i => i.group === group).map(i => (i.at === null ? '--' : clock(i.at)) + ' ' + i.title);

test('test_day_key_is_local_time', () => {
    assert.equal(dayKey(new Date(2026, 9, 15, 23, 59, 59)), '2026-10-15');
    assert.equal(dayKey(new Date(2026, 9, 16, 0, 0, 0)), '2026-10-16');
    assert.equal(dayKey(new Date('2026-01-05T00:30:00')), '2026-01-05', 'a time with no zone is local');
    assert.equal(dayKey(at(12)), '2026-10-15');
    assert.equal(dayKey(NaN), null);
    assert.equal(clock(at(7, 5)), '07:05');
});

test('test_items_group_into_collect_water_replant_level', () => {
    const items = dailyItems({ timers: timersFor(plan), plan, context, now: at(9), caps });
    assert.deepEqual(groupItems(items).map(g => g.group), ['Collect', 'Water', 'Level']);
    assert.deepEqual(lines(items, 'Water'), ['08:40 Water Rice on Farmland', '09:20 Water Rice on Farmland']);
    const collect = lines(items, 'Collect');
    assert.equal(collect.length, 15);
    assert.deepEqual(collect.slice(0, 3), ['08:10 Collect Rock from Mine', '08:43 Collect Milled Rice from Carousel Mill', '10:00 Harvest Rice from Farmland']);
    assert.deepEqual(lines(items, 'Collect').filter(l => l.includes('Rock')), ['08:10 Collect Rock from Mine', '13:30 Collect Rock from Mine', '19:00 Collect Rock from Mine']);
    assert.equal(items.find(i => i.title.startsWith('Collect Milled Rice')).approximate, true, 'a processor waiting on ingredients is approximate');
    // Level shortfalls only: rock is fully stocked, and the level-up time (15:00) is still ahead.
    assert.deepEqual(lines(items, 'Level'), ['-- Get 30 more Rice for RV 6 (10 of 40 in stock)', '-- Get 3,800 more Home Coins for RV 6 (1,200 of 5,000 in stock)']);
    assert.ok(items.every(i => i.at === null || (i.at >= at(0) && i.at < at(24))), 'only today');
    assert.deepEqual(items.map(i => i.id), dailyItems({ timers: timersFor(plan), plan, context, now: at(9), caps }).map(i => i.id), 'ids are stable');
    assert.ok(items.find(i => i.group === 'Collect').id.startsWith('collect:Mine|rock:'));
    // The item formatter comes from the page.
    assert.ok(dailyItems({ timers: timersFor(plan), plan, now: at(9), caps, name: s => s.toUpperCase() }).some(i => i.title === 'Collect ROCK from Mine'));
});

test('test_overdue_means_time_passed_and_not_ticked', () => {
    const now = at(11);
    const items = dailyItems({ timers: timersFor(plan), plan, context, now, caps });
    const overdue = items.filter(i => i.overdue);
    assert.ok(overdue.length > 0 && overdue.every(i => i.at <= now));
    assert.ok(items.filter(i => i.at > now).every(i => !i.overdue), 'later today is not overdue');
    assert.ok(items.filter(i => i.at === null).every(i => !i.overdue), 'lines with no time are never overdue');
    const first = overdue[0];
    const after = dailyItems({ timers: timersFor(plan), plan, context, now, caps, ticked: [first.id] });
    assert.equal(after.find(i => i.id === first.id).overdue, false, 'ticking clears it');
    assert.equal(after.filter(i => i.overdue).length, overdue.length - 1);
});

test('test_level_up_now_appears_once_its_time_has_passed', () => {
    assert.ok(!dailyItems({ timers: timersFor(plan), plan, context, now: at(14, 59), caps }).some(i => i.id.startsWith('levelup:')));
    const items = dailyItems({ timers: timersFor(plan), plan, context, now: at(16), caps });
    const level = items.filter(i => i.group === 'Level');
    assert.equal(level[0].title, 'Level up to RV 6 now', 'before the shortfalls');
    assert.equal(level[0].id, 'levelup:6');
    assert.equal(clock(level[0].at), '15:00');
    assert.equal(level[0].overdue, true);
    assert.equal(level.length, 3);
    // A level-up the plan cannot make gives no shortfall lines.
    assert.equal(dailyItems({ timers: timersFor(plan), plan, context: { ...context, unavailable: 'No.' }, now: at(9), caps }).filter(i => i.group === 'Level').length, 0);
});

test('test_replant_only_when_plots_do_not_resow', () => {
    const on = dailyItems({ timers: timersFor(plan), plan, context, now: at(9), caps });
    assert.equal(on.filter(i => i.group === 'Replant').length, 0);
    const off = dailyItems({ timers: timersFor(plan), settings: { assumptions: { plotsResow: false } }, plan, context, now: at(9), caps });
    assert.deepEqual(lines(off, 'Replant'), ['10:00 Replant Rice on Farmland']);
    assert.deepEqual(lines(off, 'Collect').filter(l => l.includes('Rice from Farmland')), ['10:00 Harvest Rice from Farmland'], 'a crop that is not re-sown is harvested once');
});

test('test_timers_older_than_today_still_fill_today', () => {
    const old = timersFor(plan, at(8, 0, 3));   // set up 12 days ago: well past buildEvents' default of 6 per row
    const items = dailyItems({ timers: old, plan, context, now: at(9), caps });
    assert.deepEqual(lines(items, 'Collect').filter(l => l.includes('Harvest Rice')).map(l => l.slice(0, 5)),
        ['00:00', '02:00', '04:00', '06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00']);
    assert.ok(items.some(i => i.id === 'levelup:6'), 'the level-up time passed days ago');
});

test('test_a_fast_row_is_thinned_to_a_readable_list', () => {
    const fast = { ...plan, coin_items: [{ ...plan.coin_items[0], cycle_time: 1800 }], level_up: null };
    const items = dailyItems({ timers: timersFor(fast), plan: fast, now: at(7, 30), caps }).filter(i => i.group === 'Collect');
    assert.ok(items.length > 6 && items.length <= 12, `${items.length} lines`);
    assert.equal(clock(items[0].at), '08:30');
    const gaps = items.slice(1).map((it, i) => it.at - items[i].at);
    assert.ok(gaps.every(g => g === gaps[0]), 'evenly spaced');
});

test('test_a_fast_row_on_week_old_timers_still_has_lines_today', () => {
    // A 20 minute fill-up, set up 8 days ago: 576 events before today, more than a fixed limit of 500 allows.
    const quick = { ...plan, coin_items: [{ ...plan.coin_items[0], cycle_time: 1200 }], level_up: null };
    const items = dailyItems({ timers: timersFor(quick, at(8, 0, 7)), plan: quick, now: at(9), caps }).filter(i => i.group === 'Collect');
    assert.equal(items.length, 12, 'today has 72 fill-ups, thinned to 12');
    assert.equal(clock(items[0].at), '00:00');
    assert.ok(items.every((it, i) => i === 0 || it.at - items[i - 1].at === 2 * 3600 * 1000), 'every two hours');
});

test('test_without_timers_each_producing_row_is_one_collect_line', () => {
    const items = dailyItems({ timers: null, plan, context, now: at(9), caps });
    assert.deepEqual(lines(items, 'Collect'), ['-- Collect Rice from Farmland', '-- Collect Rock from Mine', '-- Collect Milled Rice from Carousel Mill']);
    assert.ok(items.every(i => i.at === null && !i.overdue));
    assert.equal(items.filter(i => i.group === 'Level').length, 2, 'level shortfalls come from the plan alone');
    assert.deepEqual(dailyItems({ timers: null, plan: null, now: at(9) }), []);
    assert.deepEqual(dailyItems({}), []);
});

test('test_toggle_prune_and_all_done', () => {
    const day = '2026-10-15';
    let state = readState(null);
    assert.deepEqual(state, { version: 1, days: {} });
    state = toggle(state, day, 'a');
    state = toggle(state, day, 'b');
    assert.deepEqual(state.days[day].ticked, ['a', 'b']);
    state = toggle(state, day, 'a');
    assert.deepEqual(state.days[day].ticked, ['b']);
    assert.deepEqual(toggle(state, day, 'b', true).days[day].ticked, ['b'], 'an explicit value sets, it does not flip');
    assert.deepEqual(toggle(state, '2026-10-16', 'z').days[day].ticked, ['b'], 'another day does not touch this one');
    assert.equal(allDone(state, day, ['a', 'b']), false);
    assert.equal(doneCount(state, day, ['a', 'b', 'gone']), 1);
    assert.equal(allDone(state, day, []), false, 'nothing to do is not done');
    state = tickAll(state, day, ['a', 'b', 'c'], '2026-10-15T14:05:00.000Z');
    assert.equal(allDone(state, day, ['a', 'b', 'c']), true);
    assert.equal(state.days[day].doneAt, '2026-10-15T14:05:00.000Z');
    assert.deepEqual(untickDay(state, day).days, {});
    const many = Array.from({ length: 20 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`).reduce((s, d) => toggle(s, d, 'x'), readState(null));
    const kept = Object.keys(prune(many).days);
    assert.equal(kept.length, 14);
    assert.ok(kept.includes('2026-09-20') && !kept.includes('2026-09-06'), 'the newest 14 stay');
    assert.equal(Object.keys(prune(many, 3).days).length, 3);
    assert.equal(snapshotNote(day, 7, 9), 'Daily checklist 2026-10-15: 7 of 9 done');
});

test('test_state_round_trips_and_bad_storage_never_throws', () => {
    const state = tickAll(readState(null), '2026-10-15', ['a|b:1', 'a|b:1', 'c'], '2026-10-15T14:05:00.000Z');
    const back = readState(writeState(state));
    assert.deepEqual(back, { version: 1, days: { '2026-10-15': { ticked: ['a|b:1', 'c'], doneAt: '2026-10-15T14:05:00.000Z' } } });
    assert.equal(DAILY_KEY, 'aniimax-daily-v1');
    for (const bad of ['{not json', 'null', '"x"', '{"version":2,"days":{}}', '{"version":1,"days":"no"}', undefined, 7]) {
        assert.deepEqual(readState(bad), { version: 1, days: {} }, String(bad));
    }
    const messy = readState('{"version":1,"days":{"today":{"ticked":["a"]},"2026-10-15":{"ticked":["a",5,null],"doneAt":3},"2026-10-14":7}}');
    assert.deepEqual(messy.days, { '2026-10-15': { ticked: ['a'], doneAt: null } });
});
