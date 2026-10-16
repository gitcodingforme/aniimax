// "Is everything working?" card: the pure lines in web/health.js, then one mount of
// web/cards/health.js in Node with a fake container, a fake ctx (the shape in
// tests/cards_mount.test.mjs) and fetch/navigator stubs.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    HEALTH_KEY, agoText, backupLine, buildLine, byteText, dayText, dismissBackup, dismissState, healthLines,
    notificationLine, offlineLine, parseHealthState, questionsLine, remindersLine, snapshotLine, storageLine, summaryText,
    watcherLine, wholeDays,
} from '../web/health.js';
import { blockedStorage, fakeContainer, installGlobals, memoryStorage } from './helpers/fake-dom.mjs';

const NOW = new Date(2026, 9, 16, 9, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString();

// --- the backup nudge -----------------------------------------------------------------------

test('test_backup_nudge_at_15_days', () => {
    const line = backupLine({ lastExport: iso(NOW - 15 * DAY) }, NOW);
    assert.equal(line.level, 'warn');
    assert.match(line.text, /15 days ago/);
    assert.match(line.hint, /browser storage can be wiped: download your profile/);
});

test('test_no_backup_nudge_at_3_days_or_14_days', () => {
    const recent = backupLine({ lastExport: iso(NOW - 3 * DAY) }, NOW);
    assert.equal(recent.level, 'ok');
    assert.match(recent.text, new RegExp(`3 days ago \\(${dayText(NOW - 3 * DAY)}\\)`));
    assert.equal(backupLine({ lastExport: iso(NOW - 14 * DAY) }, NOW).level, 'ok');
    assert.equal(backupLine({ lastExport: NOW - 2 * HOUR }, NOW).level, 'ok', 'a time in milliseconds works too');
    assert.equal(backupLine({ lastExport: iso(NOW + 5 * DAY) }, NOW).level, 'ok', 'a clock set ahead counts as just now');
});

test('test_backup_line_with_missing_or_unreadable_data', () => {
    for (const meta of [{}, { lastExport: '' }, { lastExport: 'not a date' }, { lastExport: null }]) {
        const line = backupLine(meta, NOW);
        assert.equal(line.level, 'warn', JSON.stringify(meta));
        assert.match(line.text, /not downloaded a profile backup/);
        assert.match(line.hint, /browser storage can be wiped: download your profile/);
    }
    for (const meta of [null, undefined, 'x', []]) {
        const line = backupLine(meta, NOW);
        assert.equal(line.level, 'info', 'a profile the page could not read is not a nudge');
        assert.match(line.text, /Cannot tell/);
    }
});

test('test_dismiss_for_7_days', () => {
    assert.deepEqual(dismissState(undefined, NOW), { dismissed: false, until: null });
    assert.deepEqual(dismissState({}, NOW), { dismissed: false, until: null });
    assert.deepEqual(dismissState({ backupDismissedUntil: 'soon' }, NOW), { dismissed: false, until: null });
    const state = dismissBackup({ other: 1 }, NOW);
    assert.equal(state.backupDismissedUntil, NOW + 7 * DAY);
    assert.equal(state.other, 1, 'other saved keys are kept');
    assert.equal(dismissState(state, NOW).dismissed, true);
    assert.equal(dismissState(state, NOW + 6 * DAY).dismissed, true);
    assert.equal(dismissState(state, NOW + 6 * DAY).until, NOW + 7 * DAY);
    assert.equal(dismissState(state, NOW + 7 * DAY).dismissed, false, 'the week is over');
    assert.equal(dismissState(state, NOW + 8 * DAY).dismissed, false);
    assert.deepEqual(dismissBackup(null, NOW), { backupDismissedUntil: NOW + 7 * DAY });
});

test('test_saved_health_state_is_read_safely', () => {
    assert.deepEqual(parseHealthState(null), {});
    assert.deepEqual(parseHealthState('not json'), {});
    assert.deepEqual(parseHealthState('[1,2]'), {});
    assert.deepEqual(parseHealthState('"text"'), {});
    assert.deepEqual(parseHealthState('{"backupDismissedUntil":5}'), { backupDismissedUntil: 5 });
});

// --- the other lines ------------------------------------------------------------------------

test('test_snapshot_line', () => {
    for (const history of [undefined, null, [], [{ id: 'bad' }, null]]) {
        const line = snapshotLine(history, NOW);
        assert.equal(line.level, 'info');
        assert.match(line.text, /No snapshot saved yet/);
    }
    const fresh = snapshotLine([{ id: iso(NOW - 2 * HOUR) }], NOW);
    assert.equal(fresh.level, 'ok');
    assert.match(fresh.text, /Last snapshot: 2 h ago/);
    assert.match(fresh.text, /1 saved/);
    const mixed = snapshotLine([{ id: iso(NOW - 1 * HOUR) }, { id: iso(NOW - 30 * DAY) }], NOW);
    assert.match(mixed.text, /1 h ago/, 'the newest one counts, wherever it sits in the list');
    assert.match(mixed.text, /2 saved/);
    assert.equal(snapshotLine([{ id: iso(NOW - 10 * DAY) }], NOW).level, 'info');
});

const VERSION = { appVersion: '0.1.0', commit: 'abc1234', builtAt: '2026-10-15T12:00:00Z', upstream: { commit: 'def5678', date: '2026-10-10T00:00:00Z' } };
const NEWER = [
    { path: 'data', sha: 'aaaaaaa', date: '2026-10-12T00:00:00Z' },
    { path: 'web/facility-config.js', sha: 'bbbbbbb', date: '2026-09-01T00:00:00Z' },
    { path: 'src/models.rs', sha: 'ccccccc', date: '2026-09-02T00:00:00Z' },
];

test('test_build_line', () => {
    const local = buildLine(null, null);
    assert.equal(local.level, 'info');
    assert.match(local.text, /local build/);
    assert.equal(buildLine(undefined).level, 'info');

    const unknown = buildLine(VERSION, null);
    assert.equal(unknown.level, 'info');
    assert.match(unknown.text, /Build abc1234 from 2026-10-15/);
    assert.match(unknown.text, /original at def5678 \(2026-10-10\)/);

    const failed = buildLine(VERSION, []);
    assert.equal(failed.level, 'info');
    assert.match(failed.hint, /could not reach GitHub/);

    const behind = buildLine(VERSION, NEWER);
    assert.equal(behind.level, 'warn');
    assert.match(behind.text, /Upstream changed game data on 2026-10-12 \(data\)/, 'uses the page banner wording');
    assert.match(behind.hint, /pull request/);

    const current = buildLine(VERSION, NEWER.map(r => ({ ...r, date: '2026-10-01T00:00:00Z' })));
    assert.equal(current.level, 'ok');
    assert.match(current.text, /Nothing newer upstream/);

    const undated = buildLine({ commit: 'abc1234' }, NEWER);
    assert.equal(undated.level, 'info', 'without the stamp date there is nothing to compare');
});

test('test_offline_line', () => {
    assert.equal(offlineLine({ unsupported: true }).level, 'info');
    assert.match(offlineLine({ unsupported: true }).text, /not available in this browser/);
    for (const registration of [null, undefined]) {
        const off = offlineLine(registration);
        assert.match(off.text, /Offline mode is off/);
        assert.match(off.hint, /\?sw=on/);
    }
    const on = offlineLine({ active: {} });
    assert.equal(on.level, 'ok');
    assert.match(on.hint, /\?nosw/);
    assert.match(offlineLine({ installing: {}, active: null }).text, /starting/);
});

test('test_storage_line', () => {
    for (const estimate of [null, undefined, {}, { usage: 'many' }, { usage: -1 }, 5]) assert.equal(storageLine(estimate), null);
    const ok = storageLine({ usage: 1.5 * 1024 * 1024, quota: 2 * 1024 ** 3 });
    assert.equal(ok.level, 'ok');
    assert.equal(ok.text, 'Browser storage used: 1.5 MB of 2.0 GB');
    const full = storageLine({ usage: 90, quota: 100 });
    assert.equal(full.level, 'warn');
    assert.match(full.hint, /Download your profile/);
    assert.equal(storageLine({ usage: 2048 }).text, 'Browser storage used: 2.0 KB');
    assert.equal(byteText(0), '0 B');
    assert.equal(byteText(1023), '1023 B');
    assert.equal(byteText(250 * 1024 * 1024), '250 MB');
});

test('test_watcher_line', () => {
    for (const reading of [null, undefined, 'text']) {
        const line = watcherLine(reading, NOW);
        assert.equal(line.level, 'info');
        assert.match(line.text, /runs on your PC only/);
    }
    const fresh = watcherLine({ readAt: iso(NOW - 3 * HOUR), model: 'x', screens: [] }, NOW);
    assert.equal(fresh.level, 'ok');
    assert.match(fresh.text, /Last screenshot reading: 3 h ago/);
    assert.equal(watcherLine({ readAt: iso(NOW - 5 * DAY) }, NOW).level, 'info');
    assert.match(watcherLine({}, NOW).text, /no time on it/);
});

test('test_reminders_line', () => {
    const none = remindersLine(null, NOW);
    assert.equal(none.level, 'info');
    assert.match(none.text, /No reminders are running/);
    assert.equal(remindersLine(undefined, NOW).level, 'info');
    const running = remindersLine({ startedAt: iso(NOW - HOUR), rows: [{ on: true }, { on: false }, { on: true }] }, NOW);
    assert.equal(running.level, 'ok');
    assert.equal(running.text, 'Reminders are running: 2 rows, set up 1 h ago');
    assert.equal(remindersLine({ startedAt: 'x' }, NOW).text, 'Reminders are running');
    assert.equal(remindersLine({ rows: [{ on: true }] }, NOW).text, 'Reminders are running: 1 row');
});

test('test_notification_line', () => {
    assert.equal(notificationLine('granted').level, 'ok');
    assert.equal(notificationLine('denied').level, 'warn');
    assert.match(notificationLine('denied').hint, /site settings/);
    assert.equal(notificationLine('default').level, 'info');
    assert.match(notificationLine('default').hint, /Allow browser notifications/);
    for (const permission of [undefined, null, 'unknown']) {
        assert.match(notificationLine(permission).text, /does not offer notifications/);
    }
});

test('test_questions_line', () => {
    const line = questionsLine({ questions: { total: 19, answered: 3, evidence: 4, open: 12 } });
    assert.equal(line.level, 'info');
    assert.equal(line.text, 'Game questions: 3 of 19 answered, 4 waiting for you to check, 12 still open');
    assert.match(line.hint, /one look in game/);
    assert.equal(questionsLine({ questions: { total: 19, answered: 19, evidence: 0, open: 0 } }).level, 'ok');
});

test('test_questions_line_with_missing_data', () => {
    for (const verification of [undefined, null, {}, { questions: null }, { questions: {} }, { questions: { total: 19 } },
        { questions: { total: 19, answered: -1, evidence: 0, open: 1 } }, { questions: { total: '19', answered: 1, evidence: 0, open: 1 } },
        { questions: { total: 1.5, answered: 1, evidence: 0, open: 1 } }, 'text']) {
        assert.equal(questionsLine(verification), null, JSON.stringify(verification));
    }
});

test('test_questions_line_shows_counts_only', () => {
    const line = questionsLine({
        questions: { total: 19, answered: 3, evidence: 4, open: 12, secret: 'SHOULD-NOT-APPEAR' },
        rows: [{ key: 'SECRET-ROW' }],
    });
    const everything = JSON.stringify(line);
    assert.ok(!/SHOULD-NOT-APPEAR|SECRET-ROW/.test(everything));
});

test('test_agoText_and_wholeDays', () => {
    assert.equal(agoText(NOW - 20_000, NOW), 'just now');
    assert.equal(agoText(NOW - 5 * 60_000, NOW), '5 min ago');
    assert.equal(agoText(NOW - 23 * HOUR, NOW), '23 h ago');
    assert.equal(agoText(NOW - DAY, NOW), '1 day ago');
    assert.equal(agoText(NOW - 40 * DAY, NOW), '40 days ago');
    assert.equal(agoText('nonsense', NOW), '');
    assert.equal(wholeDays(NOW - 14.9 * DAY, NOW), 14);
    assert.ok(Number.isNaN(wholeDays(undefined, NOW)));
});

// --- all the lines ----------------------------------------------------------------------------

const FULL = {
    version: VERSION,
    upstream: NEWER,
    registration: { active: {} },
    estimate: { usage: 1024, quota: 1024 * 1024 },
    history: [{ id: iso(NOW - HOUR) }],
    meta: { lastExport: iso(NOW - 20 * DAY) },
    reading: { readAt: iso(NOW - HOUR) },
    timers: { startedAt: iso(NOW - HOUR), rows: [{ on: true }] },
    permission: 'granted',
    verification: { questions: { total: 19, answered: 3, evidence: 4, open: 12 } },
    state: {},
};

test('test_all_lines_in_order_with_only_the_backup_dismissable', () => {
    const lines = healthLines(FULL, NOW);
    assert.deepEqual(lines.map(l => l.key), ['build', 'offline', 'storage', 'snapshot', 'backup', 'watcher', 'reminders', 'notifications', 'questions']);
    assert.deepEqual(lines.filter(l => l.dismissable).map(l => l.key), ['backup']);
    assert.equal(summaryText(lines), '2 things need a look.');
});

test('test_a_dismissed_nudge_becomes_a_quiet_note_until_the_week_ends', () => {
    const state = dismissBackup({}, NOW);
    const during = healthLines({ ...FULL, state }, NOW + DAY).find(l => l.key === 'backup');
    assert.equal(during.level, 'info');
    assert.equal(during.dismissable, false);
    assert.match(during.hint, new RegExp(`Reminder hidden until ${dayText(NOW + 7 * DAY)}`));
    assert.match(during.hint, /browser storage can be wiped/);
    const after = healthLines({ ...FULL, state }, NOW + 8 * DAY).find(l => l.key === 'backup');
    assert.equal(after.level, 'warn');
    assert.equal(after.dismissable, true);
    // A recent backup has nothing to dismiss.
    assert.equal(healthLines({ ...FULL, meta: { lastExport: iso(NOW - DAY) } }, NOW).find(l => l.key === 'backup').dismissable, false);
});

test('test_lines_with_no_readings_at_all', () => {
    for (const readings of [undefined, null, {}, 'x']) {
        const lines = healthLines(readings, NOW);
        assert.deepEqual(lines.map(l => l.key), ['build', 'offline', 'snapshot', 'backup', 'watcher', 'reminders', 'notifications'], 'no storage line and no questions line without data');
        for (const l of lines) {
            assert.equal(typeof l.text, 'string');
            assert.ok(l.text.length > 0 && l.hint.length > 0);
            assert.ok(['ok', 'warn', 'info'].includes(l.level));
        }
    }
    assert.equal(summaryText([]), 'Nothing needs your attention.');
    assert.equal(summaryText([{ level: 'warn' }]), '1 thing needs a look.');
    assert.equal(summaryText(null), 'Nothing needs your attention.');
});

// --- the card, mounted ------------------------------------------------------------------------

const format = {
    number: n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }),
    duration: seconds => `${Math.ceil(seconds / 60)}m`,
    item: name => String(name),
    escape: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    perHour: perSecond => String(perSecond * 3600),
};

// The ctx keys of the card contract (web/panels.js), with a small bus for the three topics.
function makeCtx() {
    const state = { history: [], timers: null };
    const listeners = new Map();
    const record = { stylesheets: [], solves: [], snapshots: [] };
    const solver = {};
    for (const kind of ['findPlan', 'rank', 'timeOver', 'timeTo']) solver[kind] = (...args) => { record.solves.push({ kind, args }); return new Promise(() => {}); };
    const ctx = {
        config: {},
        on: (topic, fn, { replay = true } = {}) => {
            if (!listeners.has(topic)) listeners.set(topic, new Set());
            listeners.get(topic).add(fn);
            if (replay && topic in state) fn(state[topic]);
            return () => listeners.get(topic).delete(fn);
        },
        last: topic => state[topic],
        getSetup: () => ({}),
        getRoster: () => [],
        getRecipes: () => [],
        getHistory: () => structuredClone(state.history),
        getCoinSeries: () => [],
        getTimers: () => structuredClone(state.timers),
        getReminderSettings: () => ({ tab: false, ntfyTopic: '', assumptions: {} }),
        isSimple: () => false,
        homeLevel: () => 5,
        items: () => Promise.resolve([]),
        saveSnapshot: (note) => { record.snapshots.push(note); return null; },
        solver,
        format,
        addStylesheet: (href) => { record.stylesheets.push(href); },
    };
    const publish = (topic, value) => {
        state[topic] = value;
        for (const fn of [...(listeners.get(topic) || [])]) fn(value);
    };
    return { ctx, state, publish, record };
}

// fetch that answers from `files` ({ './version.json': object }); anything else is a 404.
function fetchStub(files) {
    const calls = [];
    const stub = async (url, init) => {
        calls.push({ url, init });
        if (!(url in files)) return { ok: false, status: 404, json: async () => { throw new Error('no body'); } };
        return { ok: true, status: 200, json: async () => structuredClone(files[url]) };
    };
    stub.calls = calls;
    return stub;
}

async function settle() {
    for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}

const importCard = () => import(new URL('../web/cards/health.js', import.meta.url).href);
const upstreamCache = (results, checkedAt) => JSON.stringify({ checkedAt, results });

// Mounts the card with the stubs in place; returns the pieces a test needs.
async function mountCard(t, { files = {}, storage = memoryStorage(), navigator, notification = { permission: 'default' }, fetchImpl } = {}) {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const warnings = [];
    const errors = [];
    t.mock.method(console, 'warn', (...args) => { warnings.push(args); });
    t.mock.method(console, 'error', (...args) => { errors.push(args); });
    const fetchFn = fetchImpl || fetchStub(files);
    t.after(installGlobals({
        localStorage: storage,
        fetch: fetchFn,
        navigator: navigator ?? {
            serviceWorker: { getRegistration: async () => ({ active: {} }) },
            storage: { estimate: async () => ({ usage: 1.5 * 1024 * 1024, quota: 2 * 1024 ** 3 }) },
        },
        ...(notification ? { Notification: notification } : {}),
    }));
    const { ctx, state, publish, record } = makeCtx();
    const mod = await importCard();
    const el = fakeContainer('section');
    el.setAttribute('hidden', '');
    await mod.mount(el, ctx);
    await settle();
    const piece = selector => {
        const node = el.found.get(selector);
        assert.ok(node, `the card never looked up ${selector}`);
        return node;
    };
    return { el, ctx, state, publish, record, fetchFn, warnings, errors, storage, list: () => piece('#health-lines'), summary: () => piece('#health-summary'), piece };
}

const FILES = {
    './version.json': VERSION,
    './verification.json': { format: 'aniimax-verification', questions: { total: 19, answered: 3, evidence: 4, open: 12 } },
};

test('test_mount_resolves_and_draws_a_line_per_reading', async (t) => {
    const storage = memoryStorage({
        'aniimax-profile-meta-v1': JSON.stringify({ lastExport: iso(NOW - 20 * DAY) }),
        'aniimax-upstream-check-v1': upstreamCache(NEWER, NOW - HOUR),
    });
    const run = await mountCard(t, { files: FILES, storage });
    assert.deepEqual(run.record.stylesheets, ['css/health.css']);
    assert.ok(run.el.hasAttribute('hidden'), 'showing the card is up to panels.js');
    assert.match(run.el.innerHTML, /Is everything working\?/);
    assert.match(run.el.innerHTML, /id="health-refresh"/);

    const html = run.list().innerHTML;
    for (const key of ['build', 'offline', 'storage', 'snapshot', 'backup', 'watcher', 'reminders', 'notifications', 'questions']) {
        assert.match(html, new RegExp(`id="health-line-${key}"`), key);
    }
    assert.match(html, /Upstream changed game data on 2026-10-12/);
    assert.match(html, /Offline mode is on/);
    assert.match(html, /Browser storage used: 1\.5 MB of 2\.0 GB/);
    assert.match(html, /No snapshot saved yet/);
    assert.match(html, /Last profile backup: 20 days ago/);
    assert.match(html, /runs on your PC only/, 'reading.json is a 404 on the published site');
    assert.match(html, /No reminders are running/);
    assert.match(html, /Browser notifications are not allowed yet/);
    assert.match(html, /Game questions: 3 of 19 answered, 4 waiting for you to check, 12 still open/);
    assert.match(html, /health-warn/);
    assert.match(html, /id="health-dismiss"/);
    assert.equal(run.summary().textContent, '2 things need a look.');

    // Reads only: the three files, never with credentials, and nothing solved or saved.
    assert.deepEqual(run.fetchFn.calls.map(c => c.url).sort(), ['./reading.json', './verification.json', './version.json']);
    for (const call of run.fetchFn.calls) {
        assert.equal(call.init.cache, 'no-store');
        assert.equal(call.init.credentials, 'omit');
    }
    assert.deepEqual(run.record.solves, []);
    assert.deepEqual(run.record.snapshots, []);
    assert.deepEqual(run.warnings, []);
    assert.deepEqual(run.errors, []);
});

test('test_dismiss_button_writes_the_storage_key_and_hides_the_nudge', async (t) => {
    const storage = memoryStorage({ 'aniimax-profile-meta-v1': JSON.stringify({ lastExport: iso(NOW - 20 * DAY) }) });
    const run = await mountCard(t, { files: FILES, storage });
    const list = run.list();
    assert.match(list.innerHTML, /id="health-dismiss"/);
    run.piece('#health-lines').found.get('#health-dismiss').listeners.click();
    await settle();

    const saved = JSON.parse(storage.getItem(HEALTH_KEY));
    assert.equal(HEALTH_KEY, 'aniimax-health-v1');
    assert.equal(saved.backupDismissedUntil, NOW + 7 * DAY);
    assert.doesNotMatch(list.innerHTML, /id="health-dismiss"/);
    assert.match(list.innerHTML, /Reminder hidden until/);
    assert.equal(run.summary().textContent, 'Nothing needs your attention.');

    // The week passes: the nudge is back on the next redraw.
    t.mock.timers.setTime(NOW + 7 * DAY + 1000);
    run.publish('history', []);
    assert.match(list.innerHTML, /id="health-dismiss"/);
});

test('test_the_lines_follow_the_history_and_timers_topics', async (t) => {
    const run = await mountCard(t, { files: FILES });
    assert.match(run.list().innerHTML, /No snapshot saved yet/);
    run.state.history = [{ id: iso(NOW - 2 * HOUR) }];
    run.publish('history', run.state.history);
    assert.match(run.list().innerHTML, /Last snapshot: 2 h ago/);
    run.state.timers = { startedAt: iso(NOW - HOUR), rows: [{ on: true }, { on: true }] };
    run.publish('timers', run.state.timers);
    assert.match(run.list().innerHTML, /Reminders are running: 2 rows, set up 1 h ago/);
    run.state.timers = null;
    run.publish('timers', null);
    assert.match(run.list().innerHTML, /No reminders are running/);
});

test('test_check_again_reads_the_files_again', async (t) => {
    const files = { ...FILES };
    const run = await mountCard(t, { files });
    assert.match(run.list().innerHTML, /runs on your PC only/);
    assert.equal(run.fetchFn.calls.length, 3);
    files['./reading.json'] = { format: 'aniimax-screenshot-reading', readAt: iso(NOW - 3 * HOUR), screens: [] };
    run.piece('#health-refresh').listeners.click();
    await settle();
    assert.equal(run.fetchFn.calls.length, 6);
    assert.match(run.list().innerHTML, /Last screenshot reading: 3 h ago/);
    assert.equal(run.piece('#health-refresh').disabled, false, 'the button is back');
});

test('test_blocked_local_storage_does_not_throw', async (t) => {
    const run = await mountCard(t, { files: FILES, storage: blockedStorage() });
    const html = run.list().innerHTML;
    assert.match(html, /Cannot tell when you last downloaded your profile/);
    assert.doesNotMatch(html, /id="health-dismiss"/, 'nothing to dismiss when the details cannot be read');
    assert.match(html, /Game questions/);
    run.piece('#health-refresh').listeners.click();
    run.publish('history', []);
    await settle();
    assert.deepEqual(run.errors, []);
    assert.ok(run.list().innerHTML.length > 0);
});

test('test_dismiss_still_works_for_this_visit_when_saving_fails', async (t) => {
    const storage = memoryStorage({ 'aniimax-profile-meta-v1': JSON.stringify({}) });
    storage.setItem = () => { throw new Error('QuotaExceededError'); };
    const run = await mountCard(t, { files: FILES, storage });
    assert.match(run.list().innerHTML, /have not downloaded a profile backup/);
    run.list().found.get('#health-dismiss').listeners.click();
    assert.doesNotMatch(run.list().innerHTML, /id="health-dismiss"/);
    assert.match(run.list().innerHTML, /Reminder hidden until/);
    assert.deepEqual(run.errors, []);
});

test('test_missing_files_and_missing_browser_features', async (t) => {
    const failing = async () => { throw new TypeError('Failed to fetch'); };
    const run = await mountCard(t, { fetchImpl: failing, navigator: {}, notification: null });
    const html = run.list().innerHTML;
    assert.match(html, /local build/);
    assert.match(html, /Offline mode is not available in this browser/);
    assert.doesNotMatch(html, /Browser storage used/);
    assert.doesNotMatch(html, /Game questions/);
    assert.match(html, /does not offer notifications/);
    assert.match(html, /runs on your PC only/);
    assert.deepEqual(run.warnings, [], 'a missing file is normal, so it is not logged');
    assert.deepEqual(run.errors, []);
});

test('test_text_from_files_is_escaped', async (t) => {
    const hostile = { ...VERSION, commit: '<img src=x onerror=alert(1)>', upstream: { commit: '"><script>x</script>', date: VERSION.upstream.date } };
    const run = await mountCard(t, { files: { './version.json': hostile } });
    const html = run.list().innerHTML;
    assert.match(html, /id="health-line-build"/);
    assert.doesNotMatch(html, /<img|<script/);
    assert.match(html, /&lt;img/);
});
