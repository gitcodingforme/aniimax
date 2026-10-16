import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEvents, calendarLinks, googleCalendarUrl, outlookCalendarUrl, planRows } from '../web/reminders.js';

const T0 = Date.parse('2026-10-14T20:00:00Z');
const water = { at: T0 + 600 * 1000, kind: 'water', key: 'Farmland|rice', approximate: false, title: 'Water Rice', body: 'Rice on 9× Farmland: watering 1 of 2.' };
const mill = { at: T0 + 2200 * 1000, kind: 'done', key: 'Carousel Mill|milled_rice', approximate: true, title: 'Milled Rice batch done', body: 'Milled Rice on 1× Carousel Mill: first batch.' };

test('test_google_link_has_the_template_shape_and_utc_times', () => {
    const url = googleCalendarUrl(water);
    assert.ok(url.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE&text='));
    const params = new URL(url).searchParams;
    assert.deepEqual([...params.keys()], ['action', 'text', 'dates', 'details']);
    assert.equal(params.get('action'), 'TEMPLATE');
    // 20:00:00Z plus 600 s is 20:10:00Z; the default stay is five minutes.
    assert.equal(params.get('dates'), '20261014T201000Z/20261014T201500Z');
    assert.match(params.get('dates'), /^\d{8}T\d{6}Z\/\d{8}T\d{6}Z$/);
    assert.equal(params.get('text'), 'Water Rice');
    assert.equal(params.get('details'), water.body);
});

test('test_google_link_encodes_ampersands_spaces_and_line_breaks', () => {
    const tricky = { at: T0, kind: 'collect', key: 'k', approximate: false, title: 'Collect Rice & Wheat', body: 'Line one\nA&B=C #1 100% 50/50?' };
    const url = googleCalendarUrl(tricky);
    assert.ok(url.includes('&text=Collect%20Rice%20%26%20Wheat&'), url);
    assert.ok(url.includes('&details=Line%20one%0AA%26B%3DC%20%231%20100%25%2050%2F50%3F'), url);
    assert.ok(!/\s/.test(url), 'no raw whitespace');
    // Exactly the four parameters: an unencoded & in the text would have split one into two.
    assert.equal(url.split('&').length, 4);
    const params = new URL(url).searchParams;
    assert.equal(params.get('text'), tricky.title);
    assert.equal(params.get('details'), tricky.body);
});

test('test_approximate_events_say_so_in_the_details', () => {
    const exact = new URL(googleCalendarUrl(water)).searchParams.get('details');
    assert.ok(!exact.includes('approximate'));
    const rough = new URL(googleCalendarUrl(mill)).searchParams.get('details');
    assert.equal(rough, `${mill.body} (approximate)`);
    assert.ok(rough.endsWith('(approximate)'));
    assert.ok(googleCalendarUrl(mill).includes('%20(approximate)'));
    // An event with no body still says it.
    assert.equal(new URL(googleCalendarUrl({ ...mill, body: undefined })).searchParams.get('details'), ' (approximate)');
    // A real approximate event from the planner (a processor waiting on its ingredients).
    const plan = {
        coin_items: [{ item_name: 'milled_rice', facility: 'Carousel Mill', facility_count: 1, status: 'producing', is_grower: false, cycle_time: 200 }],
        income_streams: [{ item_name: 'milled_rice', lead_time_seconds: 2000 }],
    };
    const [first] = buildEvents(planRows(plan), { startedAt: T0 });
    assert.equal(first.approximate, true);
    // Its body already says "approximate", so the suffix is not added a second time.
    const details = new URL(googleCalendarUrl(first)).searchParams.get('details');
    assert.equal(details, first.body);
    assert.equal(details.match(/approximate/gi).length, 1);
    // Any case counts as already saying it; an exact event never gets the suffix.
    assert.equal(new URL(googleCalendarUrl({ ...mill, body: 'Roughly done. Approximate moment.' })).searchParams.get('details'), 'Roughly done. Approximate moment.');
    assert.equal(new URL(googleCalendarUrl({ ...water, body: 'The moment is approximate.' })).searchParams.get('details'), 'The moment is approximate.');
});

test('test_duration_sets_the_end_time', () => {
    const dates = (event, options) => new URL(googleCalendarUrl(event, options)).searchParams.get('dates');
    assert.equal(dates(water), '20261014T201000Z/20261014T201500Z');
    assert.equal(dates(water, { durationMinutes: 30 }), '20261014T201000Z/20261014T204000Z');
    assert.equal(dates(water, { durationMinutes: 90 }), '20261014T201000Z/20261014T214000Z');
    assert.equal(dates(water, { durationMinutes: 1.5 }), '20261014T201000Z/20261014T201130Z');
    // Crossing midnight UTC carries the date.
    const late = { ...water, at: Date.parse('2026-10-14T23:58:00Z') };
    assert.equal(dates(late), '20261014T235800Z/20261015T000300Z');
    // Nonsense durations fall back to the default five minutes.
    for (const bad of [0, -10, NaN, 'long']) assert.equal(dates(water, { durationMinutes: bad }), '20261014T201000Z/20261014T201500Z');
    // The start accepts a date string too, as buildEvents does.
    assert.equal(dates({ ...water, at: '2026-10-14T20:10:00Z' }), '20261014T201000Z/20261014T201500Z');
});

test('test_location_is_left_out_unless_given', () => {
    assert.ok(!googleCalendarUrl(water).includes('location'));
    assert.ok(!googleCalendarUrl(water, { location: '' }).includes('location'));
    assert.ok(!googleCalendarUrl(water, { durationMinutes: 10 }).includes('location'));
    const url = googleCalendarUrl(water, { location: 'Homeland, Farmland #3' });
    assert.ok(url.endsWith('&location=Homeland%2C%20Farmland%20%233'), url);
    assert.equal(new URL(url).searchParams.get('location'), 'Homeland, Farmland #3');
});

test('test_an_event_without_a_time_cannot_become_a_link', () => {
    assert.throws(() => googleCalendarUrl({ title: 'x', body: 'y' }), /needs the time/);
    assert.throws(() => googleCalendarUrl({ at: 'never', title: 'x', body: 'y' }), /needs the time/);
    assert.throws(() => outlookCalendarUrl({ title: 'x', body: 'y' }), /needs the time/);
    // In a list, the bad event is skipped and the rest keep their links.
    const links = calendarLinks([water, { title: 'no time' }, null, { at: 'never' }, mill]);
    assert.deepEqual(links.map(l => l.event), [water, mill]);
    assert.equal(links[1].google, googleCalendarUrl(mill));
});

test('test_calendar_links_pairs_each_event_with_its_google_link', () => {
    const events = [water, mill];
    const links = calendarLinks(events);
    assert.equal(links.length, 2);
    assert.deepEqual(links.map(l => Object.keys(l)), [['event', 'google'], ['event', 'google']]);
    assert.equal(links[0].event, water, 'the event itself, not a copy');
    assert.equal(links[1].event, mill);
    assert.equal(links[0].google, googleCalendarUrl(water));
    assert.equal(links[1].google, googleCalendarUrl(mill));
    // Options pass through to every link.
    const options = { durationMinutes: 15, location: 'Home' };
    const custom = calendarLinks(events, options);
    assert.equal(custom[0].google, googleCalendarUrl(water, options));
    assert.ok(custom.every(l => l.google.includes('&location=Home')));
    assert.deepEqual(calendarLinks([]), []);
    assert.deepEqual(calendarLinks(undefined), []);
    assert.deepEqual(calendarLinks(null), []);
});

test('test_outlook_link_has_the_compose_shape_with_iso_times', () => {
    const url = outlookCalendarUrl(mill);
    assert.ok(url.startsWith('https://outlook.live.com/calendar/0/deeplink/compose?subject='));
    const params = new URL(url).searchParams;
    assert.equal(params.get('subject'), mill.title);
    assert.equal(params.get('startdt'), '2026-10-14T20:36:40Z');
    assert.equal(params.get('enddt'), '2026-10-14T20:41:40Z');
    assert.equal(params.get('body'), `${mill.body} (approximate)`);
    assert.equal(params.get('path'), '/calendar/action/compose');
    assert.equal(params.get('rru'), 'addevent');
    assert.equal(params.get('location'), null);
    assert.ok(!/\s/.test(url), 'no raw whitespace');
    // Same encoding rules, duration and location as the Google link.
    const tricky = { at: T0, kind: 'collect', key: 'k', approximate: false, title: 'Collect Rice & Wheat', body: 'A&B' };
    const withOptions = outlookCalendarUrl(tricky, { durationMinutes: 45, location: 'Home' });
    assert.ok(withOptions.includes('subject=Collect%20Rice%20%26%20Wheat&'), withOptions);
    const p = new URL(withOptions).searchParams;
    assert.equal(p.get('startdt'), '2026-10-14T20:00:00Z');
    assert.equal(p.get('enddt'), '2026-10-14T20:45:00Z');
    assert.equal(p.get('body'), 'A&B');
    assert.equal(p.get('location'), 'Home');
});
