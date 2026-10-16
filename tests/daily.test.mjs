import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DAILY_KEY, GROUPS, STALE_TIMERS_NOTE, allDone, clock, dailyItems, dayKey, doneCount, groupItems, prune, readState, snapshotNote, staleTimersNote,
    tickAll, timeLabel, toggle, untickDay, writeState,
} from '../web/daily.js';
import { planRows } from '../web/reminders.js';
import { fakeContainer, fakeDocument, installGlobals, memoryStorage } from './helpers/fake-dom.mjs';

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
    // A first batch is "ready" (once per row); "Collect" is only for when the store is full.
    assert.deepEqual(collect.slice(0, 3), ['08:10 Ready: first Rock batch at Mine', '08:43 Ready: first Milled Rice batch at Carousel Mill', '10:00 Harvest Rice from Farmland']);
    assert.deepEqual(collect.filter(l => l.includes('Rock')), ['08:10 Ready: first Rock batch at Mine', '13:30 Collect Rock from Mine', '19:00 Collect Rock from Mine']);
    assert.equal(collect.filter(l => l.includes('Ready')).length, 2, 'one per row, and the rice store holds one harvest so it has none');
    assert.equal(items.find(i => i.title.startsWith('Collect Milled Rice')).approximate, true, 'a processor waiting on ingredients is approximate');
    // Level shortfalls only: rock is fully stocked, and the level-up time (15:00) is still ahead.
    assert.deepEqual(lines(items, 'Level'), ['-- Get 30 more Rice for RV 6 (10 of 40 in stock)', '-- Get 3,800 more Home Coins for RV 6 (1,200 of 5,000 in stock)']);
    assert.ok(items.every(i => i.at === null || (i.at >= at(0) && i.at < at(24))), 'only today');
    assert.deepEqual(items.map(i => i.id), dailyItems({ timers: timersFor(plan), plan, context, now: at(9), caps }).map(i => i.id), 'ids are stable');
    assert.ok(items.find(i => i.group === 'Collect').id.startsWith('ready:Mine|rock:'));
    assert.ok(items.some(i => i.id.startsWith('collect:Mine|rock:')));
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
    // Rice takes 2 hours and was set up at 08:00: it is ready at 10:00 and, replanted on time, every 2 hours after.
    assert.deepEqual(lines(off, 'Replant').slice(0, 2), ['10:00 Replant Rice on Farmland', '12:00 Harvest, then replant Rice on Farmland']);
    assert.deepEqual(lines(off, 'Collect').filter(l => l.includes('Farmland')), ['10:00 Ready to harvest: Rice on Farmland'], 'the first batch is "ready" once; later harvests are replant lines');
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

test('test_unknown_store_size_gives_ready_and_check_lines_not_collect', () => {
    const items = dailyItems({ timers: timersFor(plan), plan, now: at(9), caps: null });
    const collect = lines(items, 'Collect');
    assert.ok(collect.every(l => !/ Collect /.test(l)), 'no store is known to be full');
    assert.equal(collect.filter(l => l.includes('Ready')).length, 3, 'one ready line per row');
    assert.ok(collect.some(l => l === '12:00 Check Rice at Farmland') && collect.some(l => l.includes('Check Rock at Mine')));
    assert.equal(new Set(items.map(i => i.id)).size, items.length);
});

test('test_the_list_runs_past_midnight_when_it_is_late', () => {
    const late = timersFor(plan, at(23, 35));
    const night = dailyItems({ timers: late, plan, context, now: at(23, 40), caps });
    const end = at(23, 40) + 12 * 3600 * 1000;
    assert.ok(night.some(i => i.at >= at(24)), 'items after midnight');
    assert.ok(night.every(i => i.at === null || i.at < end), 'but only 12 hours ahead');
    assert.ok(night.some(i => i.at !== null && i.at > at(23, 40) + 10 * 3600 * 1000), 'the late morning is in');
    // Early in the day the list still stops at midnight.
    const morning = dailyItems({ timers: timersFor(plan), plan, context, now: at(8, 30), caps });
    assert.ok(morning.every(i => i.at === null || i.at < at(24)));
});

test('test_time_labels_match_the_reminders_card_format', () => {
    const plain = s => s.replace(/[  ]/g, ' ');
    assert.equal(plain(timeLabel(at(23, 35), at(23, 40), 'en-US')), '11:35 PM');
    assert.equal(plain(timeLabel(at(24, 10), at(23, 40), 'en-US')), 'Tomorrow 12:10 AM');
    assert.equal(plain(timeLabel(at(1, 0, 14), at(9), 'en-US')), 'Yesterday 1:00 AM');
    assert.equal(plain(timeLabel(at(8, 0, 20), at(9), 'en-US')), 'Oct 20 8:00 AM');
    assert.equal(timeLabel(at(9), at(9)), new Date(at(9)).toLocaleTimeString(undefined, { timeStyle: 'short' }), 'the browser locale by default');
    assert.equal(timeLabel(NaN, at(9)), '');
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

// --- a replant line for every harvest when plots are not re-sown --------------------------------

const noResow = { assumptions: { plotsResow: false } };
const replants = (items, from = 0) => items.filter(i => i.group === 'Replant').slice(from);

test('test_every_harvest_in_the_list_gets_a_replant_line_when_plots_are_not_resown', () => {
    const items = dailyItems({ timers: timersFor(plan), settings: noResow, plan, context, now: at(9), caps });
    const list = replants(items);
    assert.deepEqual(lines(items, 'Replant'), [
        '10:00 Replant Rice on Farmland',
        ...['12:00', '14:00', '16:00', '18:00', '20:00', '22:00'].map(t => `${t} Harvest, then replant Rice on Farmland`),
    ]);
    assert.deepEqual(list.map(i => i.approximate), [false, true, true, true, true, true, true], 'the first is the plan\'s own time, later ones assume each replant was on time');
    assert.equal(new Set(items.map(i => i.id)).size, items.length, 'ids are unique');
    assert.ok(list.every(i => i.id.startsWith('replant:Farmland|rice:')));
    assert.equal(list[0].id, replants(dailyItems({ timers: timersFor(plan), settings: noResow, plan, context, now: at(9), caps }))[0].id, 'and stable');
    // Only crops, and only plots that are on; gatherers and processors repeat by themselves.
    assert.ok(list.every(i => i.title.includes('Rice')));
    const off = timersFor(plan);
    off.rows = off.rows.map(r => (r.key === 'Farmland|rice' ? { ...r, on: false } : r));
    assert.equal(replants(dailyItems({ timers: off, settings: noResow, plan, context, now: at(9), caps })).length, 0);
    // Re-sowing on: none, as before.
    assert.equal(replants(dailyItems({ timers: timersFor(plan), plan, context, now: at(9), caps })).length, 0);
});

test('test_replant_lines_turn_overdue_and_clear_when_ticked', () => {
    const now = at(15);
    const items = dailyItems({ timers: timersFor(plan), settings: noResow, plan, context, now, caps });
    const list = replants(items);
    assert.equal(list.length, 9, 'from the start of today to 12 hours past now (03:00): the harvests already past and the ones ahead');
    assert.equal(clock(list[0].at), '10:00');
    assert.equal(clock(list.at(-1).at), '02:00');
    assert.deepEqual(list.filter(i => i.overdue).map(i => clock(i.at)), ['10:00', '12:00', '14:00']);
    const ticked = dailyItems({ timers: timersFor(plan), settings: noResow, plan, context, now, caps, ticked: [list[1].id] });
    assert.deepEqual(replants(ticked).filter(i => i.overdue).map(i => clock(i.at)), ['10:00', '14:00']);
});

test('test_replant_lines_follow_old_late_and_first_batch_off_timers', () => {
    // Set up 12 days ago: today's harvests still land on the 2 hour grid from the old start.
    const old = dailyItems({ timers: timersFor(plan, at(8, 0, 3)), settings: noResow, plan, context, now: at(9), caps });
    assert.deepEqual(lines(old, 'Replant').map(l => l.slice(0, 5)), ['00:00', '02:00', '04:00', '06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00']);
    assert.ok(replants(old).every(i => i.title.startsWith('Harvest, then replant')), 'none of them is the first harvest');
    // Late in the day the list reaches 12 hours past now, across midnight.
    const night = dailyItems({ timers: timersFor(plan, at(23, 35)), settings: noResow, plan, context, now: at(23, 40), caps });
    assert.deepEqual(lines(night, 'Replant').map(l => l.slice(0, 5)), ['01:35', '03:35', '05:35', '07:35', '09:35', '11:35']);
    assert.equal(replants(night)[0].title, 'Replant Rice on Farmland', 'the first harvest since setup is the plain replant');
    // Turning the first-batch reminder off does not hide the replants.
    const quiet = dailyItems({ timers: timersFor(plan), settings: { assumptions: { plotsResow: false, firstBatch: false } }, plan, context, now: at(9), caps });
    assert.equal(replants(quiet).length, 7);
    // A row with its own start time counts from there.
    const shifted = timersFor(plan);
    shifted.rows = shifted.rows.map(r => (r.key === 'Farmland|rice' ? { ...r, startedAt: new Date(at(8, 30)).toISOString() } : r));
    assert.equal(lines(dailyItems({ timers: shifted, settings: noResow, plan, context, now: at(9), caps }), 'Replant')[0], '10:30 Replant Rice on Farmland');
});

test('test_a_very_fast_crop_has_its_replants_thinned_evenly', () => {
    const fast = { ...plan, coin_items: [{ ...plan.coin_items[0], cycle_time: 300 }], level_up: null };
    const list = replants(dailyItems({ timers: timersFor(fast), settings: noResow, plan: fast, now: at(9), caps }));
    assert.ok(list.length > 12 && list.length <= 24, `${list.length} lines`);
    assert.equal(clock(list[0].at), '08:05', 'the first harvest is kept');
    const gaps = list.slice(1).map((it, i) => it.at - list[i].at);
    assert.ok(gaps.every(g => g === gaps[0]), 'evenly spaced');
});

// --- the food line ----------------------------------------------------------------------------

const withFood = (energy, extra = {}) => ({ assumptions: { foodEnergy: energy, ...extra } });

test('test_a_refill_food_line_appears_when_the_feed_reminder_falls_today', () => {
    // 9 plots + 2 mines + 1 busy mill unit = 12 working Aniimo; 12,000 energy lasts 100 minutes from 08:00.
    const items = dailyItems({ timers: timersFor(plan), settings: withFood(12000), plan, context, now: at(9), caps });
    assert.deepEqual(lines(items, 'Food'), ['09:40 Refill food']);
    const food = items.find(i => i.group === 'Food');
    assert.equal(food.approximate, true, 'an estimate from fan data');
    assert.equal(food.overdue, false);
    assert.ok(food.id.startsWith('feed:'));
    assert.deepEqual(groupItems(items).map(g => g.group), ['Collect', 'Water', 'Food', 'Level'], 'its own group, before Level');
    assert.deepEqual([...GROUPS], ['Collect', 'Water', 'Replant', 'Food', 'Level']);
    // With replants on the list too the order holds.
    const both = dailyItems({ timers: timersFor(plan), settings: withFood(12000, { plotsResow: false }), plan, context, now: at(9), caps });
    assert.deepEqual(groupItems(both).map(g => g.group), ['Collect', 'Water', 'Replant', 'Food', 'Level']);
    // Overdue once it has passed, until ticked.
    const later = dailyItems({ timers: timersFor(plan), settings: withFood(12000), plan, context, now: at(10), caps });
    assert.equal(later.find(i => i.group === 'Food').overdue, true);
    const ticked = dailyItems({ timers: timersFor(plan), settings: withFood(12000), plan, context, now: at(10), caps, ticked: [food.id] });
    assert.equal(ticked.find(i => i.group === 'Food').overdue, false);
    // The worker count saved with the timers (the roster caps it) is used.
    const capped = dailyItems({ timers: { ...timersFor(plan), workers: 6 }, settings: withFood(12000), plan, context, now: at(9), caps });
    assert.deepEqual(lines(capped, 'Food'), ['11:20 Refill food']);
    assert.equal(new Set(items.map(i => i.id)).size, items.length);
});

test('test_no_food_line_without_energy_or_when_the_reminder_is_not_today', () => {
    const none = group => dailyItems(group).filter(i => i.group === 'Food').length;
    const base = { timers: timersFor(plan), plan, context, now: at(9), caps };
    assert.equal(none({ ...base }), 0, 'no settings');
    assert.equal(none({ ...base, settings: withFood(null) }), 0);
    assert.equal(none({ ...base, settings: withFood(0) }), 0);
    assert.equal(none({ ...base, settings: { assumptions: { workersFed: false } } }), 0, 'the switch alone adds no line');
    assert.equal(none({ ...base, settings: withFood(600000) }), 0, 'a bowl that lasts 83 hours is not due today');
    assert.equal(none({ ...base, timers: timersFor(plan, at(8, 0, 3)), settings: withFood(12000) }), 0, 'old timers: it was due days ago');
    assert.equal(none({ ...base, timers: null, settings: withFood(12000) }), 0, 'no timers, no times');
    // Tomorrow morning is on the list when it is late in the day: 23:35 + 100 minutes = 01:15.
    const night = dailyItems({ timers: timersFor(plan, at(23, 35)), settings: withFood(12000), plan, context, now: at(23, 40), caps });
    assert.deepEqual(lines(night, 'Food'), ['01:15 Refill food']);
});

// --- timers from an older plan ----------------------------------------------------------------

test('test_timers_from_another_plan_get_a_warning', () => {
    assert.match(STALE_TIMERS_NOTE, /^These timers come from an older plan/);
    assert.equal(staleTimersNote({ planHash: 'a' }, { setupHash: 'b' }), STALE_TIMERS_NOTE);
    assert.equal(staleTimersNote({ planHash: 'a' }, { setupHash: 'a' }), '', 'the same plan');
    assert.equal(staleTimersNote(null, { setupHash: 'b' }), '', 'no timers');
    assert.equal(staleTimersNote({ planHash: 'a' }, null), '', 'no plan on screen to compare with');
    assert.equal(staleTimersNote({ planHash: 'a' }, undefined), '');
    assert.equal(staleTimersNote({ planHash: null }, { setupHash: 'b' }), '', 'timers with no recorded plan');
    assert.equal(staleTimersNote({ rows: [] }, { setupHash: 'b' }), '');
    assert.equal(staleTimersNote({ planHash: 'a' }, { setupHash: '' }), '');
    assert.equal(staleTimersNote({ planHash: 'a' }, { setupHash: 7 }), '');
});

// --- the card ---------------------------------------------------------------------------------

const cardFormat = {
    duration: seconds => `${Math.round(seconds / 60)}m`,
    item: name => String(name).split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
    escape: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
};

async function mountDaily(t, { timers, topic = null, settings = { assumptions: {} } }) {
    // The card sets an interval to turn lines overdue; the mock keeps it from holding the process.
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: at(9) });
    t.after(installGlobals({ localStorage: memoryStorage(), document: fakeDocument() }));
    const { mount } = await import('../web/cards/daily.js');
    const el = fakeContainer('section');
    const ctx = {
        addStylesheet() {},
        format: cardFormat,
        last: name => (name === 'plan' ? topic : undefined),
        getTimers: () => timers,
        getReminderSettings: () => settings,
        config: { OUTPUT_CAPS: caps },
        on: (_name, fn) => fn(),   // the bus replays the last value at once
        saveSnapshot: () => null,
    };
    await mount(el, ctx);
    return el;
}

test('test_the_card_warns_when_the_timers_are_from_an_older_plan', async t => {
    const stale = await mountDaily(t, { timers: timersFor(plan), topic: { plan, context, setupHash: 'newer' } });
    const warning = stale.found.get('#daily-stale');
    assert.match(warning.textContent, /^These timers come from an older plan/);
    assert.equal(warning.hidden, false);
});

test('test_the_card_shows_no_warning_for_current_timers_and_draws_the_food_and_replant_lines', async t => {
    const settings = { assumptions: { plotsResow: false, foodEnergy: 12000 } };
    const el = await mountDaily(t, { timers: timersFor(plan), topic: { plan, context, setupHash: 'h' }, settings });
    const warning = el.found.get('#daily-stale');
    assert.equal(warning.textContent, '');
    assert.equal(warning.hidden, true);
    const html = el.found.get('#daily-groups').innerHTML;
    assert.match(html, /<h3 class="daily-group">Food<\/h3>/);
    assert.match(html, /Refill food/);
    assert.match(html, /~[^<]*<\/span> <span class="daily-title">Refill food/, 'marked approximate');
    assert.equal((html.match(/replant Rice on Farmland/g) || []).length, 6, 'the six later harvests');
    assert.match(html, /Replant Rice on Farmland/);
});

test('test_the_card_has_no_warning_when_no_plan_is_on_screen', async t => {
    const el = await mountDaily(t, { timers: timersFor(plan), topic: null });
    assert.equal(el.found.get('#daily-stale').hidden, true, 'nothing to compare with');
});

// --- ticks must survive the list changing underneath them ---------------------------------------

test('test_the_food_line_keeps_its_id_when_the_worker_count_changes', () => {
    const timers = timersFor(plan);
    const first = dailyItems({ timers, settings: withFood(12000), plan, context, now: at(9), caps }).find(i => i.group === 'Food');
    assert.equal(first.id, `feed:${timers.startedAt}`);
    // A row switched off means fewer workers, so a later time, but it is the same line and keeps its tick.
    const fewer = { ...timers, rows: timers.rows.map(r => (r.key === 'Farmland|rice' ? { ...r, on: false } : r)) };
    const moved = dailyItems({ timers: fewer, settings: withFood(12000), plan, context, now: at(9), caps }).find(i => i.group === 'Food');
    assert.equal(moved.id, first.id);
    assert.notEqual(moved.at, first.at);
    assert.equal(clock(moved.at), '14:40', '3 workers: 400 minutes after 08:00');
});

test('test_the_energy_saved_with_the_timers_wins_over_the_live_setting', () => {
    const saved = { ...timersFor(plan), foodEnergy: 12000 };
    assert.deepEqual(lines(dailyItems({ timers: saved, settings: withFood(24000), plan, context, now: at(9), caps }), 'Food'), ['09:40 Refill food']);
    assert.deepEqual(lines(dailyItems({ timers: saved, settings: withFood(null), plan, context, now: at(9), caps }), 'Food'), ['09:40 Refill food'], 'a box emptied later does not remove it');
    assert.deepEqual(lines(dailyItems({ timers: saved, plan, context, now: at(9), caps }), 'Food'), ['09:40 Refill food'], 'and none is needed in the settings');
    // Timers that carry none use the live setting.
    assert.deepEqual(lines(dailyItems({ timers: timersFor(plan), settings: withFood(24000), plan, context, now: at(9), caps }), 'Food'), ['11:20 Refill food']);
});

test('test_replant_lines_keep_their_ids_as_the_window_moves', () => {
    const fast = { ...plan, coin_items: [{ ...plan.coin_items[0], cycle_time: 300 }], level_up: null };
    const idsAt = hour => replants(dailyItems({ timers: timersFor(fast), settings: noResow, plan: fast, now: at(hour), caps })).map(i => i.id);
    const morning = idsAt(9), afternoon = idsAt(15);
    assert.ok(afternoon.length > morning.length, 'after noon the window reaches into tomorrow');
    assert.deepEqual(afternoon.slice(0, morning.length), morning, 'the lines that were there keep their ids, so their ticks stay');
    // The thinning step depends on the crop alone: a harvest every hour for a 5 minute crop.
    const list = replants(dailyItems({ timers: timersFor(fast), settings: noResow, plan: fast, now: at(15), caps }));
    assert.ok(list.slice(1).every((it, i) => it.at - list[i].at === 3600 * 1000));
});
