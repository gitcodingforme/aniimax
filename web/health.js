// "Is everything working?" card: the pure part. Each function here takes one raw reading (a parsed
// JSON file, a browser answer, a saved list) and returns one plain-words line,
// { text, hint, level: 'ok' | 'warn' | 'info' }, or null when there is nothing worth saying.
// `text` says what is true, `hint` says what to do about it. Nothing here reads the page, the
// network or storage: web/cards/health.js gathers the readings and draws the lines. Tested in
// tests/health.test.mjs.
import { bannerText, newerUpstreamChanges } from './upstream-check.js?v=fork-m10-2';

export const HEALTH_KEY = 'aniimax-health-v1';
export const PROFILE_META_KEY = 'aniimax-profile-meta-v1';
export const BACKUP_NUDGE_DAYS = 14;
export const DISMISS_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const WATCHER_FRESH_MS = 2 * DAY_MS;
const SNAPSHOT_FRESH_MS = 7 * DAY_MS;
const STORAGE_FULL_SHARE = 0.8;

const line = (text, hint, level) => ({ text, hint, level });
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isInteger(value) && value >= 0;

// A time as milliseconds: a number is taken as is, a string is parsed as a date, anything else is NaN.
function toMs(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    if (typeof value === 'string' && value.trim() !== '') return Date.parse(value);
    return NaN;
}

// Whole days between `then` and `now`, never negative (a clock a little ahead counts as today).
export function wholeDays(then, now = Date.now()) {
    const t = toMs(then);
    return Number.isFinite(t) ? Math.floor(Math.max(0, now - t) / DAY_MS) : NaN;
}

// "just now", "5 min ago", "3 h ago", "1 day ago", "15 days ago". Empty text for an unreadable time.
export function agoText(then, now = Date.now()) {
    const t = toMs(then);
    if (!Number.isFinite(t)) return '';
    const minutes = Math.floor(Math.max(0, now - t) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.floor(hours / 24);
    return days === 1 ? '1 day ago' : `${days} days ago`;
}

// The date in the player's own time zone, as 2026-10-16.
export function dayText(ms) {
    const d = new Date(ms);
    const two = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

export function byteText(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = Number(bytes);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

// --- the backup nudge and its dismissal -------------------------------------------------------

const BACKUP_HINT = 'Your setup lives only in this browser, and browser storage can be wiped: download your profile (Download profile, near the top of the page) and keep the file.';

// When the profile was last downloaded, from the profile details the page keeps
// (`aniimax-profile-meta-v1`, field lastExport). Never, or more than 14 whole days ago, is 'warn';
// those are the lines the Dismiss button can hide for a week. `meta` null means the browser would
// not let the page read its saved details.
export function backupLine(meta, now = Date.now()) {
    if (!isPlainObject(meta)) {
        return line(
            'Cannot tell when you last downloaded your profile',
            'This browser would not let the page read its saved details (a private window or blocked site data). Download your profile now to be safe.',
            'info',
        );
    }
    const t = toMs(meta.lastExport);
    if (!Number.isFinite(t)) return line('You have not downloaded a profile backup yet', BACKUP_HINT, 'warn');
    const text = `Last profile backup: ${agoText(t, now)} (${dayText(t)})`;
    if (wholeDays(t, now) > BACKUP_NUDGE_DAYS) return line(text, BACKUP_HINT, 'warn');
    return line(text, 'Nothing to do. Download again after you change your setup a lot.', 'ok');
}

// What the saved health state says about the backup nudge: { dismissed, until (ms or null) }.
// `state` is the parsed `aniimax-health-v1` value, { backupDismissedUntil: ms }.
export function dismissState(state, now = Date.now()) {
    const until = toMs(isPlainObject(state) ? state.backupDismissedUntil : undefined);
    return Number.isFinite(until) ? { dismissed: until > now, until } : { dismissed: false, until: null };
}

// The state to save when the player presses "Dismiss for a week".
export function dismissBackup(state, now = Date.now()) {
    return { ...(isPlainObject(state) ? state : {}), backupDismissedUntil: now + DISMISS_DAYS * DAY_MS };
}

// The saved text as a state object; anything unreadable is an empty state.
export function parseHealthState(raw) {
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return isPlainObject(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

// --- the other lines --------------------------------------------------------------------------

// The newest snapshot in the history (a list of { id: ISO time, ... }, oldest first).
export function snapshotLine(history, now = Date.now()) {
    const times = (Array.isArray(history) ? history : [])
        .map(s => toMs(s && s.id))
        .filter(Number.isFinite);
    if (times.length === 0) {
        return line(
            'No snapshot saved yet',
            'A snapshot is a dated copy of your setup. Save one in the History card to see your progress over time.',
            'info',
        );
    }
    const latest = Math.max(...times);
    const text = `Last snapshot: ${agoText(latest, now)} (${dayText(latest)}), ${times.length} saved`;
    if (now - latest <= SNAPSHOT_FRESH_MS) return line(text, 'Nothing to do.', 'ok');
    return line(text, 'Save a new snapshot in the History card when your homeland has changed.', 'info');
}

// Which build is running and whether its game data is behind the original (ae-bii/aniimax).
// `version` is the parsed version.json (null on a local build). `upstreamResults` is the page's
// cached answer from upstream-check.js: null when none is saved, [] when the last try failed,
// else one { path, sha, date } per watched path.
export function buildLine(version, upstreamResults) {
    if (!isPlainObject(version)) {
        return line(
            'This is a local build: it has no build stamp',
            'Normal on your own PC. The published site shows which commit it was built from.',
            'info',
        );
    }
    const short = value => String(value ?? '').slice(0, 12);
    const day = value => String(value ?? '').slice(0, 10);
    const up = isPlainObject(version.upstream) ? version.upstream : {};
    const parts = [`Build ${short(version.commit) || 'unknown'}`];
    if (version.builtAt) parts[0] += ` from ${day(version.builtAt)}`;
    if (up.commit) parts.push(`game data from the original at ${short(up.commit)}${up.date ? ` (${day(up.date)})` : ''}`);
    const base = `${parts.join(', ')}.`;

    if (!Number.isFinite(Date.parse(up.date))) {
        return line(base, 'The build stamp has no date for the original, so it cannot be compared with it.', 'info');
    }
    if (upstreamResults == null) {
        return line(base, 'Whether the original has newer game data is checked from GitHub when the page opens (at most every six hours). No answer saved yet: reload the page.', 'info');
    }
    if (!Array.isArray(upstreamResults) || upstreamResults.length === 0) {
        return line(base, 'The last check could not reach GitHub (offline, or too many requests). It tries again within the hour.', 'info');
    }
    const newer = newerUpstreamChanges(version, upstreamResults);
    if (newer.length > 0) {
        return line(bannerText(version, newer), 'A sync pull request should be waiting in your fork on GitHub. Check that its tests passed, merge it, and the site updates itself.', 'warn');
    }
    return line(`${base} Nothing newer upstream.`, 'Nothing to do.', 'ok');
}

// Offline mode (the service worker). `registration` is what navigator.serviceWorker.getRegistration()
// gave: a registration, undefined/null when there is none, or { unsupported: true } when the
// browser has no service workers at all.
export function offlineLine(registration) {
    if (isPlainObject(registration) && registration.unsupported === true) {
        return line('Offline mode is not available in this browser', 'The site works as usual while you are online.', 'info');
    }
    if (!registration) {
        return line(
            'Offline mode is off',
            'The published site turns it on after your first visit. On your own PC it stays off unless you add ?sw=on to the address.',
            'info',
        );
    }
    if (registration.active) {
        return line(
            'Offline mode is on',
            'The site opens without internet. If a page looks out of date, open the site with ?nosw on the end of the address: that switches offline mode off and clears its saved copies.',
            'ok',
        );
    }
    return line('Offline mode is starting', 'Reload the page once and it will be ready.', 'info');
}

// How much this site has saved in the browser (navigator.storage.estimate(): { usage, quota }).
export function storageLine(estimate) {
    if (!isPlainObject(estimate) || estimate.usage == null) return null;
    const usage = Number(estimate.usage);
    if (!Number.isFinite(usage) || usage < 0) return null;
    const quota = Number(estimate.quota);
    const hasQuota = Number.isFinite(quota) && quota > 0;
    const text = `Browser storage used: ${byteText(usage)}${hasQuota ? ` of ${byteText(quota)}` : ''}`;
    if (hasQuota && usage / quota > STORAGE_FULL_SHARE) {
        return line(text, 'The browser is nearly out of room for this site. Download your profile and your history, then clear what you do not need.', 'warn');
    }
    return line(text, 'Counts everything this site keeps here, including the offline copies of its files. Plenty of room.', 'ok');
}

// The screenshot watcher's last reading (web/reading.json, written on the owner's PC only).
export function watcherLine(reading, now = Date.now()) {
    if (!isPlainObject(reading)) {
        return line(
            'The screenshot watcher runs on your PC only',
            'Nothing to do here. When it runs on your PC next to this site, its last reading time shows up in this line.',
            'info',
        );
    }
    const t = toMs(reading.readAt);
    if (!Number.isFinite(t)) {
        return line('A screenshot reading is there, but it has no time on it', 'Run the watcher again to get a fresh one.', 'info');
    }
    const text = `Last screenshot reading: ${agoText(t, now)} (${dayText(t)})`;
    if (now - t <= WATCHER_FRESH_MS) return line(text, 'The watcher reads screenshots of your game, never the game itself.', 'ok');
    return line(text, 'It was a while ago. Start the watcher while you play to refresh it.', 'info');
}

// Whether reminders are running. `timers` is the page's reminders object, or null.
export function remindersLine(timers, now = Date.now()) {
    if (!isPlainObject(timers)) {
        return line(
            'No reminders are running',
            'Solve a plan, set up your homeland as it says, then press "I just set everything up per the plan" in the Reminders card.',
            'info',
        );
    }
    const rows = Array.isArray(timers.rows) ? timers.rows.filter(r => r && r.on !== false) : null;
    const started = agoText(timers.startedAt, now);
    const text = `Reminders are running${rows ? `: ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}` : ''}${started ? `, set up ${started}` : ''}`;
    return line(text, 'They only know what you told them. If you set things up differently from the plan, fix the rows in the Reminders card.', 'ok');
}

// Notification permission: 'granted', 'denied', 'default', or undefined when the browser has none.
export function notificationLine(permission) {
    if (permission === 'granted') {
        return line('Browser notifications are allowed', 'Pop-ups appear while this tab, or at least the browser, stays open.', 'ok');
    }
    if (permission === 'denied') {
        return line(
            'Browser notifications are blocked',
            'Reminders will not pop up. Allow them in your browser\'s site settings, or use the calendar or phone options in the Reminders card.',
            'warn',
        );
    }
    if (permission === 'default') {
        return line('Browser notifications are not allowed yet', 'Press "Allow browser notifications" in the Reminders card if you want pop-up reminders.', 'info');
    }
    return line('This browser does not offer notifications', 'Use the calendar or phone options in the Reminders card instead.', 'info');
}

// The open game questions, from counts only: verification.questions = { total, answered, evidence, open }.
// Null when the file or the counts are missing or not whole numbers.
export function questionsLine(verification) {
    const q = isPlainObject(verification) ? verification.questions : null;
    if (!isPlainObject(q) || ![q.total, q.answered, q.evidence, q.open].every(count)) return null;
    const text = `Game questions: ${q.answered} of ${q.total} answered, ${q.evidence} waiting for you to check, ${q.open} still open`;
    if (q.total > 0 && q.answered >= q.total) return line(text, 'Nothing left to check in game.', 'ok');
    return line(text, 'Most need one look in game with the watcher running.', 'info');
}

// --- all lines at once ------------------------------------------------------------------------

// The lines in the order the card shows them, each { key, text, hint, level, dismissable }.
// `readings` holds whatever was read; any of it may be missing:
//   { version, upstream, registration, estimate, history, meta, reading, timers, permission,
//     verification, state }
// A backup nudge the player dismissed is shown as a quiet 'info' line until the dismissal ends.
export function healthLines(readings = {}, now = Date.now()) {
    const r = isPlainObject(readings) ? readings : {};
    let backup = backupLine(r.meta, now);
    const dismissed = dismissState(r.state, now);
    let dismissable = backup.level === 'warn';
    if (dismissable && dismissed.dismissed) {
        backup = line(backup.text, `Reminder hidden until ${dayText(dismissed.until)}. ${backup.hint}`, 'info');
        dismissable = false;
    }
    const entries = [
        ['build', buildLine(r.version, r.upstream)],
        ['offline', offlineLine(r.registration)],
        ['storage', storageLine(r.estimate)],
        ['snapshot', snapshotLine(r.history, now)],
        ['backup', backup],
        ['watcher', watcherLine(r.reading, now)],
        ['reminders', remindersLine(r.timers, now)],
        ['notifications', notificationLine(r.permission)],
        ['questions', questionsLine(r.verification)],
    ];
    return entries
        .filter(([, l]) => l)
        .map(([key, l]) => ({ key, ...l, dismissable: key === 'backup' && dismissable }));
}

// One sentence on top of the list.
export function summaryText(lines) {
    const warns = (Array.isArray(lines) ? lines : []).filter(l => l && l.level === 'warn').length;
    if (warns === 0) return 'Nothing needs your attention.';
    return warns === 1 ? '1 thing needs a look.' : `${warns} things need a look.`;
}
