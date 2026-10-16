import assert from 'node:assert/strict';
import test from 'node:test';

import {
    FEED_TITLE, FOOD_NOTE, FOOD_RATE_PER_MINUTE, feedEvent, foodDuration, foodHours, rosterSize, workingAniimo,
} from '../web/food.js';
import { buildEvents, planRows } from '../web/reminders.js';

const T0 = Date.parse('2026-10-14T20:00:00Z');
const HOUR = 3600 * 1000;
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ''} ${actual} is not ${expected}`);

const plan = {
    success: true,
    coin_items: [
        { item_name: 'rice', facility: 'Farmland', facility_count: 9, status: 'producing', is_grower: true, cycle_time: 1800, busy_units: 9 },
        { item_name: 'rock', facility: 'Mine', facility_count: 2, status: 'producing', is_grower: true, cycle_time: 600, busy_units: 1.5 },
        { item_name: 'milled_rice', facility: 'Carousel Mill', facility_count: 3, status: 'producing', is_grower: false, cycle_time: 200, busy_units: 1 },
        { item_name: null, facility: 'Well', facility_count: 1, status: 'idle', is_grower: true, cycle_time: null },
    ],
    income_streams: [{ item_name: 'milled_rice', lead_time_seconds: 2000 }],
};

test('test_food_hours_is_energy_over_the_hourly_rate', () => {
    assert.equal(FOOD_RATE_PER_MINUTE, 10);
    // 6 working Aniimo eat 60 a minute: 12,000 lasts 200 minutes.
    near(foodHours(12000, 6) * 60, 200);
    near(foodHours(600, 1), 1, '600 an hour for one Aniimo');
    near(foodHours(9370, 1), 9370 / 600, 'one Wheatmeal for one worker is about 15.6 hours');
    near(foodHours(1200, 4), 0.5);
    near(foodHours(1200, 2, 20) * 60, 30, 'the rate can be changed once it is measured');
    near(foodHours(1200, 1.5) * 60, 80, 'a fractional worker count is not rounded');
});

test('test_food_hours_is_null_unless_energy_and_workers_are_positive_numbers', () => {
    for (const bad of [0, -5, NaN, Infinity, null, undefined, '5000', '', true, {}, []]) {
        assert.equal(foodHours(bad, 4), null, `energy ${JSON.stringify(bad)}`);
        assert.equal(foodHours(5000, bad), null, `workers ${JSON.stringify(bad)}`);
    }
    assert.equal(foodHours(5000, 4, 0), null, 'a zero rate would divide by zero');
    assert.equal(foodHours(5000, 4, -10), null);
    assert.equal(foodHours(5000, 4, NaN), null);
    assert.equal(foodHours(), null);
});

test('test_food_duration_reads_like_the_reminders', () => {
    assert.equal(foodDuration(200 / 60), '3h 20m');
    assert.equal(foodDuration(1 + 5 / 60), '1h 05m');
    assert.equal(foodDuration(0.75), '45m');
    assert.equal(foodDuration(2), '2h 00m');
    assert.equal(foodDuration(0.0001), '1m', 'never "0m"');
    assert.equal(foodDuration(0), '');
    assert.equal(foodDuration(null), '');
    assert.equal(foodDuration(NaN), '');
});

test('test_working_aniimo_counts_staffed_units_from_the_plan_rows', () => {
    // 9 plots + 2 mines (a gatherer keeps its Aniimo all day) + 1 busy mill unit out of 3.
    assert.equal(workingAniimo(planRows(plan)), 12);
    assert.equal(workingAniimo(planRows(plan), { tab: 'best' }), 12);
    assert.equal(workingAniimo([]), 0);
    assert.equal(workingAniimo(null), 0);
    assert.equal(workingAniimo(undefined, { tab: 'custom', roster: [{ count: 3 }] }), 0, 'a roster does not add workers the plan does not use');
    // A fraction of a busy processor unit still takes a whole Aniimo.
    const part = planRows({ coin_items: [{ item_name: 'milled_rice', facility: 'Carousel Mill', facility_count: 3, status: 'producing', is_grower: false, cycle_time: 200, busy_units: 0.4 }] });
    assert.equal(workingAniimo(part), 1);
    const halves = planRows({ coin_items: [
        { item_name: 'rice', facility: 'Farmland', facility_count: 2, status: 'producing', is_grower: true, cycle_time: 1800, busy_units: 2 },
        { item_name: 'milled_rice', facility: 'Carousel Mill', facility_count: 2, status: 'producing', is_grower: false, cycle_time: 200, busy_units: 0.5 },
        { item_name: 'bread', facility: 'Claw Game Cooker', facility_count: 2, status: 'producing', is_grower: false, cycle_time: 200, busy_units: 0.5 },
    ] });
    assert.equal(workingAniimo(halves), 3, '2 + 0.5 + 0.5 = 3, not 2 + 1 + 1');
});

test('test_working_aniimo_skips_rows_that_are_off_or_run_on_power', () => {
    const rows = planRows(plan);
    const off = rows.map(r => (r.key === 'Farmland|rice' ? { ...r, on: false } : r));
    assert.equal(workingAniimo(off), 3, 'rice switched off: 2 mines + 1 mill unit');
    const electric = rows.map(r => (r.key === 'Mine|rock' ? { ...r, electric: true } : r));
    assert.equal(workingAniimo(electric), 10, 'generator rows have no Aniimo');
    assert.equal(workingAniimo([{ kind: 'crop', count: 'x' }, null, 7, { kind: 'crop', count: -2 }]), 0, 'odd rows never throw');
    // Rows saved before `busy` existed still count by their facility count.
    assert.equal(workingAniimo([{ kind: 'processor', count: 2 }, { kind: 'crop', count: 4 }]), 6);
});

test('test_my_aniimo_tab_caps_the_workers_at_the_roster_size', () => {
    const rows = planRows(plan);
    const roster = [{ name: 'Mochi', count: 2 }, { name: 'Pip', count: 3 }];
    assert.equal(rosterSize(roster), 5);
    assert.equal(workingAniimo(rows, { tab: 'custom', roster }), 5, 'twelve jobs, five Aniimo');
    assert.equal(workingAniimo(rows, { setup: 'roster:[{}]', roster }), 5, 'a roster setup name counts as roster mode too');
    assert.equal(workingAniimo(rows, { tab: 'custom', roster: [{ count: 40 }] }), 12, 'a bigger roster does not raise it');
    assert.equal(workingAniimo(rows, { tab: 'best', roster }), 12, 'Best and Minimum use the plan alone');
    assert.equal(workingAniimo(rows, { tab: 'minimum', setup: 'minimum', roster }), 12);
    assert.equal(workingAniimo(rows, { tab: 'custom', roster: [] }), 12, 'no roster to cap by');
    assert.equal(workingAniimo(rows, { tab: 'custom' }), 12);
    assert.equal(rosterSize([{ name: 'Solo' }, { count: 0 }, { count: -1 }, null, 'x', { count: 2.9 }]), 3, 'a card with no count is one Aniimo');
    assert.equal(rosterSize(null), 0);
});

test('test_feed_event_has_the_shape_of_the_other_reminders', () => {
    const hours = foodHours(12000, 6);
    const event = feedEvent(T0, hours);
    assert.deepEqual({ ...event, at: undefined }, {
        at: undefined, kind: 'feed', key: 'food', approximate: true,
        title: 'Refill the food bowl',
        body: 'The bowl should be about empty (it lasts about 3h 20m from setup); estimate from fan data (10 food energy per minute per working Aniimo)',
    });
    assert.equal(FEED_TITLE, 'Refill the food bowl');
    near(event.at - T0, 200 * 60 * 1000, '200 minutes after now');
    // The same fields buildEvents gives its own events.
    const own = buildEvents(planRows(plan), { startedAt: T0, levelUpSeconds: 3600 }).find(e => e.kind === 'levelup');
    assert.deepEqual(Object.keys(event).sort(), Object.keys(own).sort());
    assert.equal(typeof event.at, 'number');
});

test('test_feed_event_takes_a_date_or_text_and_refuses_what_it_cannot_time', () => {
    assert.equal(feedEvent(new Date(T0), 1).at, T0 + HOUR);
    assert.equal(feedEvent('2026-10-14T20:00:00Z', 1).at, T0 + HOUR);
    assert.match(feedEvent(T0, 1 / 60).body, /it lasts about 1m from setup\)/);
    assert.ok(!/from now/.test(feedEvent(T0, 2).body), 'it is read when it fires, not at setup');
    for (const hours of [0, -1, NaN, Infinity, null, undefined, '2']) assert.equal(feedEvent(T0, hours), null, String(hours));
    for (const now of [NaN, 'never', null, undefined]) assert.equal(feedEvent(now, 2), null, String(now));
});

test('test_food_note_is_one_plain_sentence', () => {
    assert.match(FOOD_NOTE, /^The plan assumes your workers stay fed; no food cost is subtracted/);
    assert.ok(!FOOD_NOTE.includes('\n'));
});
