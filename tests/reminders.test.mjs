import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_ASSUMPTIONS, NTFY_DAILY_LIMIT, WATERING_POINTS, batchesUntilFull, buildEvents, cancelNtfy, formatCountdown, icsCalendar,
    isValidTopic, ntfyRequests, outputCap, planRows, rowLevel, sendNtfy, suggestTopic, upcoming, wateringFractions,
} from '../web/reminders.js';

const plan = {
    success: true,
    coin_items: [
        { item_name: 'rice', facility: 'Farmland', facility_count: 9, status: 'producing', is_grower: true, cycle_time: 1800, busy_units: 9 },
        { item_name: 'rock', facility: 'Mine', facility_count: 2, status: 'producing', is_grower: true, cycle_time: 600, busy_units: 1.5 },
        { item_name: 'milled_rice', facility: 'Carousel Mill', facility_count: 1, status: 'producing', is_grower: false, cycle_time: 200, busy_units: 1 },
        { item_name: null, facility: 'Well', facility_count: 1, status: 'idle', is_grower: true, cycle_time: null },
    ],
    income_streams: [{ item_name: 'milled_rice', lead_time_seconds: 2000 }, { item_name: 'rock', lead_time_seconds: 600 }],
    level_up: { seconds: 48780 },
};
const T0 = Date.parse('2026-10-14T20:00:00Z');

test('test_plan_rows_classify_producing_rows', () => {
    const rows = planRows(plan);
    assert.deepEqual(rows.map(r => [r.key, r.kind, r.cycleSeconds, r.leadSeconds, r.busy]), [
        ['Farmland|rice', 'crop', 1800, 1800, 9],
        ['Mine|rock', 'gatherer', 600, 600, 1.5],
        ['Carousel Mill|milled_rice', 'processor', 200, 2200, 1],
    ]);
    assert.deepEqual(planRows(null), []);
});

test('test_events_follow_the_cycle_with_watering_lead_time_and_level_up', () => {
    const events = buildEvents(planRows(plan), { startedAt: T0, levelUpSeconds: 48780, levelUpTarget: 6 });
    const rice = events.filter(e => e.key === 'Farmland|rice');
    assert.deepEqual(rice.slice(0, 3).map(e => [e.kind, (e.at - T0) / 1000, e.approximate]), [['water', 600, true], ['water', 1200, true], ['done', 1800, false]]);
    assert.equal(rice[2].title, 'Harvest Rice');
    const mill = events.filter(e => e.key === 'Carousel Mill|milled_rice');
    assert.equal((mill[0].at - T0) / 1000, 2200);
    assert.equal(mill[0].approximate, true);
    assert.match(mill[0].body, /ingredients/);
    const levelUp = events.find(e => e.kind === 'levelup');
    assert.equal((levelUp.at - T0) / 1000, 48780);
    assert.equal(levelUp.title, 'RV 6 should be affordable');
    // Capped: each row has at most maxPerRow events besides watering, spaced evenly over the day.
    for (const key of ['Farmland|rice', 'Mine|rock', 'Carousel Mill|milled_rice']) {
        const n = events.filter(e => e.key === key && e.kind !== 'water').length;
        assert.ok(n >= 1 && n <= 6, `${key}: ${n}`);
    }
    const rock = events.filter(e => e.key === 'Mine|rock');
    assert.equal(rock[0].kind, 'done');
    assert.equal(rock[1].kind, 'checkin');
    assert.match(rock[1].body, /batch \d+ should be done/);
    assert.ok(events.every((e, i) => i === 0 || e.at >= events[i - 1].at));
    // Many short rows share the daily budget instead of each taking six.
    const busy = Array.from({ length: 12 }, (_, i) => ({ key: `r${i}`, facility: 'Mine', item: 'rock', kind: 'gatherer', cycleSeconds: 60, count: 1, leadSeconds: 60 }));
    const crowded = buildEvents(busy, { startedAt: T0 });
    assert.ok(crowded.length <= 30, `${crowded.length} events`);
    assert.ok(crowded.length >= 12);
    assert.equal(buildEvents(busy, { startedAt: T0, maxPerRow: 3 }).length, 36);
    assert.ok(events.every(e => e.at <= T0 + 86400 * 1000 || e.kind === 'levelup'));
});

test('test_assumption_switches_and_row_settings_change_the_events', () => {
    const rows = planRows(plan);
    const off = { ...DEFAULT_ASSUMPTIONS, processorsRepeat: false, plotsResow: false, wateringPrompts: false };
    const events = buildEvents(rows, { startedAt: T0, assumptions: off });
    assert.equal(events.filter(e => e.kind === 'water').length, 0);
    assert.equal(events.filter(e => e.key === 'Farmland|rice').length, 1);
    assert.equal(events.filter(e => e.key === 'Carousel Mill|milled_rice').length, 1);
    assert.ok(events.filter(e => e.key === 'Mine|rock').length > 1);
    const custom = rows.map(r => r.key === 'Mine|rock' ? { ...r, on: false } : r.key === 'Farmland|rice' ? { ...r, startedAt: '2026-10-14T20:10:00Z' } : r);
    const adjusted = buildEvents(custom, { startedAt: T0, assumptions: off });
    assert.equal(adjusted.filter(e => e.key === 'Mine|rock').length, 0);
    assert.equal((adjusted.find(e => e.key === 'Farmland|rice').at - T0) / 1000, 600 + 1800);
    assert.throws(() => buildEvents(rows, { startedAt: 'never' }), /time the plan was set up/);
    assert.deepEqual(upcoming(events, T0 + 100 * 3600 * 1000), []);
    assert.equal(upcoming(events, T0).length, events.length);
    assert.equal(formatCountdown(3 * 3600 * 1000 + 5 * 60 * 1000), 'in 3h 05m');
    assert.equal(formatCountdown(90 * 1000), 'in 1m');
    assert.equal(formatCountdown(-5), 'now');
});

test('test_calendar_file_is_valid_ics', () => {
    const events = [
        { at: T0 + 600 * 1000, kind: 'water', key: 'k', title: 'Water Rice', body: 'Rice on 9× Farmland: watering 1 of 2; with a comma, and a semicolon.' },
        { at: T0 + 48780 * 1000, kind: 'levelup', key: 'level-up', title: 'RV 6 should be affordable', body: 'x'.repeat(120) },
    ];
    const ics = icsCalendar(events, { now: T0 });
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
    assert.equal((ics.match(/BEGIN:VALARM/g) || []).length, 2);
    assert.match(ics, /DTSTART:20261014T201000Z/);
    const unfolded = ics.replace(/\r\n /g, '');
    assert.match(unfolded, /DESCRIPTION:Rice on 9× Farmland: watering 1 of 2\\; with a comma\\, and a semicolon\./);
    assert.ok(ics.split('\r\n').every(line => line.length <= 75), 'lines folded to 75 chars');
    assert.match(ics, /\r\n x+\r\n/);
    assert.match(ics, /UID:aniimax-20261014T200000Z-1@aniimax\.local/);
});

test('test_ntfy_requests_respect_the_delay_window_and_daily_cap', () => {
    const now = T0;
    const events = [
        { at: now + 5 * 1000, kind: 'done', key: 'a', title: 'too soon', body: '' },
        { at: now + 600 * 1000, kind: 'water', key: 'b', title: 'Water Rice', body: 'Rice on 9× Farmland' },
        { at: now + 4 * 86400 * 1000, kind: 'levelup', key: 'c', title: 'too far', body: '' },
    ];
    const { requests, skipped } = ntfyRequests(events, 'aniimax-abc_123', { now });
    assert.deepEqual(skipped, { tooSoon: 1, tooFar: 1, overLimit: 0 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://ntfy.sh/aniimax-abc_123');
    assert.deepEqual(requests[0].headers, { 'X-Delay': String(Math.round((now + 600 * 1000) / 1000)), 'X-Title': 'Water Rice', 'X-Tags': 'droplet' });
    assert.equal(requests[0].body, 'Rice on 9× Farmland');
    const many = Array.from({ length: NTFY_DAILY_LIMIT + 20 }, (_, i) => ({ at: now + (60 + i) * 1000, kind: 'checkin', key: 'k', title: 't', body: 'b' }));
    const capped = ntfyRequests(many, 'topic', { now });
    assert.equal(capped.requests.length, NTFY_DAILY_LIMIT);
    assert.equal(capped.skipped.overLimit, 20);
    assert.throws(() => ntfyRequests(events, 'bad topic!', { now }), /topic must be/);
    assert.equal(isValidTopic('aniimax-x'), true);
    assert.equal(isValidTopic('has space'), false);
    assert.equal(isValidTopic('x'.repeat(65)), false);
    assert.match(suggestTopic(() => 0.5), /^aniimax-[a-z2-9]{20}$/);
    assert.notEqual(suggestTopic(), suggestTopic());
});

test('test_send_and_cancel_report_what_happened', async () => {
    const calls = [];
    let n = 0;
    const fetchOk = async (url, init) => { calls.push([url, init.method, init.headers?.['X-Delay']]); return { ok: true, json: async () => ({ id: `msg${++n}` }) }; };
    const requests = ntfyRequests([
        { at: T0 + 600 * 1000, kind: 'done', key: 'a', title: 'A', body: 'a' },
        { at: T0 + 700 * 1000, kind: 'done', key: 'b', title: 'B', body: 'b' },
    ], 'topic', { now: T0 }).requests;
    const sent = await sendNtfy(requests, fetchOk);
    assert.deepEqual(sent.map(s => [s.id, s.title]), [['msg1', 'A'], ['msg2', 'B']]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][1], 'POST');
    const fetchFail = async () => ({ ok: false, status: 429 });
    await assert.rejects(sendNtfy(requests, fetchFail), /429 after 0 of 2/);
    await assert.rejects(sendNtfy(requests, async () => { throw new Error('offline'); }), /could not reach ntfy.sh after 0 of 2/);
    const deleted = [];
    const fetchDelete = async (url, init) => { deleted.push([url, init.method]); return { ok: !url.endsWith('msg2') }; };
    assert.deepEqual(await cancelNtfy(sent, 'topic', fetchDelete), { ok: 1, failed: 1 });
    assert.deepEqual(deleted, [['https://ntfy.sh/topic/msg1', 'DELETE'], ['https://ntfy.sh/topic/msg2', 'DELETE']]);
    assert.deepEqual(await cancelNtfy([{ id: '' }], 'topic', fetchDelete), { ok: 0, failed: 1 });
    await assert.rejects(cancelNtfy(sent, 'bad topic', fetchDelete), /no valid ntfy topic/);
});


// --- output caps: "collect before the store is full" ----------------------------------------

const recipes = [
    { name: 'rice', facility: 'Farmland', yield_amount: 18, facility_level: 3 },
    { name: 'rock', facility: 'Mine', yieldAmount: 6, facilityLevel: 1 },
    { name: 'milled_rice', facility: 'Carousel Mill', yield_amount: 1, facility_level: 2 },
];
const facilities = { Farmland: [{ count: 9, level: 7 }], Mine: [{ count: 2, level: 3 }], 'Carousel Mill': [{ count: 1, level: 4 }] };
const caps = { Farmland: [null, 10, 15, 20, 25, 30, 35], Mine: [200, 200, 200, 200, 200, 200], 'Carousel Mill': [20, 20, 20, 20, 20, 20] };

test('test_output_cap_looks_up_the_level_and_falls_back_sensibly', () => {
    assert.equal(outputCap(caps, 'Farmland', 7), 35);
    assert.equal(outputCap(caps, 'Farmland', 2), 10);
    assert.equal(outputCap(caps, 'Farmland', 1), null, 'unknown at level 1');
    assert.equal(outputCap(caps, 'Farmland', 9), 35, 'past the end keeps the last entry');
    assert.equal(outputCap(caps, 'Carousel Mill', null), 20, 'no level, but every level agrees');
    assert.equal(outputCap(caps, 'Farmland', null), null, 'no level and the levels differ');
    assert.equal(outputCap(caps, 'Starfall Hammock', 1), null, 'no entry');
    assert.equal(outputCap(null, 'Mine', 1), null);
    assert.equal(batchesUntilFull(20, 1), 20);
    assert.equal(batchesUntilFull(200, 6), 33, 'whole batches only');
    assert.equal(batchesUntilFull(35, 18), 1);
    assert.equal(batchesUntilFull(10, 18), 1, 'a batch bigger than the store still needs collecting');
    assert.equal(batchesUntilFull(null, 6), null);
    assert.equal(batchesUntilFull(20, null), null);
    assert.equal(rowLevel([{ count: 2, level: 2 }, { count: 1, level: 5 }], 3), 5, 'lowest tier that can make the item');
    assert.equal(rowLevel([{ count: 2, level: 2 }, { count: 1, level: 5 }], 1), 2);
    assert.equal(rowLevel([{ count: 0, level: 6 }, { count: 1, level: 2 }], 4), 2, 'nothing able: lowest owned');
    assert.equal(rowLevel([{ count: 0, level: 6 }], 1), null);
    assert.equal(rowLevel(undefined, 1), null);
});

test('test_plan_rows_carry_yield_and_level_when_given_recipes_and_setup', () => {
    const rows = planRows(plan, { recipes, facilities });
    assert.deepEqual(rows.map(r => [r.key, r.yieldPerBatch, r.level]), [
        ['Farmland|rice', 18, 7], ['Mine|rock', 6, 3], ['Carousel Mill|milled_rice', 1, 4],
    ]);
    const bare = planRows(plan);
    assert.deepEqual(bare.map(r => [r.yieldPerBatch, r.level]), [[null, null], [null, null], [null, null]]);
    // An uncovered-crop row still finds its recipe; an unknown item gets no yield.
    const odd = planRows({ coin_items: [
        { item_name: 'rice__uncovered', facility: 'Farmland', facility_count: 1, status: 'producing', is_grower: true, cycle_time: 3000 },
        { item_name: 'mystery', facility: 'Mine', facility_count: 1, status: 'producing', is_grower: true, cycle_time: 600 },
    ] }, { recipes, facilities });
    assert.deepEqual(odd.map(r => [r.yieldPerBatch, r.level]), [[18, 7], [null, 3]]);
});

test('test_collect_events_come_when_the_store_is_full', () => {
    const rows = planRows(plan, { recipes, facilities });
    const events = buildEvents(rows, { startedAt: T0, caps });
    // Mine: 200 rock at 6 a batch = 33 batches of 600 s; first batch done, then collect at batch 33.
    const rock = events.filter(e => e.key === 'Mine|rock');
    assert.deepEqual(rock.slice(0, 2).map(e => [e.kind, (e.at - T0) / 1000, e.title]), [['done', 600, 'Rock batch done'], ['collect', 33 * 600, 'Collect Rock']]);
    assert.match(rock[1].body, /Mine at level 3 holds 200 Rock \(33 batches of 6\), then stops/);
    assert.match(rock[1].body, /fan wiki/);
    // Repeats every 33 batches within the day, under the per-row budget.
    assert.equal((rock[2].at - T0) / 1000, 66 * 600);
    assert.match(rock[2].body, /Fill-up 2 since setup/);
    assert.ok(rock.every(e => e.kind !== 'checkin'), 'no batch check-ins when the cap is known');
    assert.ok(rock.filter(e => e.kind === 'collect').length <= 6);
    // Processor: 20 batches of 200 s after a 2000 s lead; the first batch is approximate, so is the collect.
    const mill = events.filter(e => e.key === 'Carousel Mill|milled_rice');
    assert.deepEqual(mill.slice(0, 2).map(e => [e.kind, (e.at - T0) / 1000, e.approximate]), [['done', 2200, true], ['collect', 2200 + 19 * 200, true]]);
    assert.match(mill[1].body, /Carousel Mill at level 4 holds 20 batches/);
    // Farmland at level 7 holds 35 rice, one harvest of 18: the collect replaces the "done" event.
    const rice = events.filter(e => e.key === 'Farmland|rice');
    assert.deepEqual(rice.slice(0, 3).map(e => [e.kind, (e.at - T0) / 1000]), [['water', 600], ['water', 1200], ['collect', 1800]]);
    assert.ok(!rice.some(e => e.kind === 'done'));
    assert.match(rice[2].body, /holds 35 Rice \(1 batch of 18\)/);
    // The collect event is the main one even past the horizon.
    const slow = buildEvents([{ ...rows[1], cycleSeconds: 3600 }], { startedAt: T0, caps });
    assert.equal(slow.filter(e => e.kind === 'collect').length, 1);
    assert.equal((slow.find(e => e.kind === 'collect').at - T0) / 1000, 33 * 3600);
    // "First batch" off: only the collect events remain (plus watering).
    const noFirst = buildEvents(rows, { startedAt: T0, caps, assumptions: { ...DEFAULT_ASSUMPTIONS, firstBatch: false } });
    assert.equal(noFirst.filter(e => e.kind === 'done').length, 0);
    assert.equal(noFirst.filter(e => e.key === 'Mine|rock')[0].kind, 'collect');
    // Processors that do not repeat get only their first batch.
    const once = buildEvents(rows, { startedAt: T0, caps, assumptions: { ...DEFAULT_ASSUMPTIONS, processorsRepeat: false } });
    assert.deepEqual(once.filter(e => e.key === 'Carousel Mill|milled_rice').map(e => e.kind), ['done']);
    // ntfy tags the collect events.
    const { requests } = ntfyRequests(rock.slice(1, 2), 'topic', { now: T0 });
    assert.equal(requests[0].headers['X-Tags'], 'package');
});

test('test_rows_without_a_cap_fall_back_to_batch_check_ins', () => {
    const rows = planRows(plan, { recipes, facilities: { ...facilities, Farmland: [{ count: 9, level: 1 }] } });
    const events = buildEvents(rows, { startedAt: T0, caps: { ...caps, Mine: undefined } });
    const rock = events.filter(e => e.key === 'Mine|rock');
    assert.equal(rock[0].kind, 'done');
    assert.equal(rock[1].kind, 'checkin');
    assert.match(rock[1].body, /No output cap is known for this Mine at level 3/);
    const rice = events.filter(e => e.key === 'Farmland|rice');
    assert.deepEqual(rice.slice(0, 3).map(e => e.kind), ['water', 'water', 'done'], 'level 1 Farmland has no known cap');
    assert.equal(rice[3].kind, 'checkin');
    // No recipe list at all: the yield is unknown, so every row falls back.
    assert.ok(buildEvents(planRows(plan), { startedAt: T0, caps }).every(e => e.kind !== 'collect'));
    // No caps table at all behaves the same.
    assert.ok(buildEvents(rows, { startedAt: T0 }).every(e => e.kind !== 'collect'));
});

test('test_second_watering_point_is_a_setting', () => {
    assert.deepEqual(wateringFractions(DEFAULT_ASSUMPTIONS), [1 / 3, 2 / 3]);
    assert.deepEqual(wateringFractions({ secondWatering: 'three-quarters' }), [1 / 3, 3 / 4]);
    assert.deepEqual(wateringFractions({ secondWatering: 'nonsense' }), [1 / 3, 2 / 3]);
    assert.deepEqual(Object.keys(WATERING_POINTS), ['two-thirds', 'three-quarters']);
    const rows = planRows(plan);
    const later = buildEvents(rows, { startedAt: T0, assumptions: { ...DEFAULT_ASSUMPTIONS, secondWatering: 'three-quarters' } });
    const water = later.filter(e => e.kind === 'water');
    assert.deepEqual(water.map(e => (e.at - T0) / 1000), [600, 1350]);
    assert.match(water[1].body, /at 75% of the grow time/);
    assert.match(buildEvents(rows, { startedAt: T0 }).filter(e => e.kind === 'water')[1].body, /at 67% of the grow time/);
});
