// Batch-done reminders: timers built from the plan's batch times once the player says "I just set
// everything up per the plan", delivered in the tab, as scheduled ntfy.sh pushes, or as a calendar
// file. Pure functions only (no DOM, no storage); tested in tests/reminders.test.mjs. app.js wires
// buttons, storage and the browser APIs.
//
// The app cannot see the game, so every event assumes the player did exactly what the plan says
// at the moment they pressed the button. Game facts not yet verified are `assumptions` switches.
export const SETTINGS_KEY = 'aniimax-reminders-v1';
export const TIMERS_KEY = 'aniimax-timers-v1';
export const NTFY_SERVER = 'https://ntfy.sh';
export const NTFY_MIN_DELAY_S = 10;
export const NTFY_MAX_DELAY_S = 3 * 24 * 3600;
export const NTFY_DAILY_LIMIT = 250;
export const DEFAULT_HORIZON_S = 24 * 3600;
export const DEFAULT_MAX_PER_ROW = 6;
// About how many batch reminders a day is still useful; rows share it, so a 9-second recipe is
// not a reminder, it is noise.
export const DEFAULT_DAILY_BUDGET = 30;
export const WATERING_FRACTIONS = [1 / 3, 2 / 3];

export const DEFAULT_ASSUMPTIONS = Object.freeze({
    processorsRepeat: true, // a processor starts its next batch by itself (not verified)
    plotsResow: true,       // a staffed plot is re-sown after harvest (not verified)
    wateringPrompts: true,  // crops ask for water at about 1/3 and 2/3 of their growth (approximate)
});

export function pretty(name) {
    return String(name ?? '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function toMs(value) {
    if (typeof value === 'number') return value;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : NaN;
}

// --- rows from the plan ------------------------------------------------------------------

// One row per producing facility row of the plan: what runs where, how long a batch takes.
export function planRows(plan) {
    const streams = plan?.income_streams || [];
    return (plan?.coin_items || [])
        .filter(s => s && s.status === 'producing' && s.item_name && s.cycle_time > 0 && s.facility_count > 0)
        .map(s => {
            const kind = s.facility === 'Farmland' || s.facility === 'Woodland' ? 'crop' : s.is_grower ? 'gatherer' : 'processor';
            const stream = streams.find(p => p.item_name === s.item_name);
            return {
                key: `${s.facility}|${s.item_name}`,
                facility: s.facility,
                item: s.item_name,
                kind,
                cycleSeconds: s.cycle_time,
                count: s.facility_count,
                busy: Number.isFinite(s.busy_units) ? s.busy_units : s.facility_count,
                // Seconds until this processor's first batch can be done: the engine's lead time is the
                // wait before its first input exists (0 when nothing blocks it), then one batch.
                leadSeconds: kind === 'processor' && stream && stream.lead_time_seconds > 0 ? stream.lead_time_seconds + s.cycle_time : s.cycle_time,
                on: true,
                startedAt: null,
            };
        });
}

// --- events ------------------------------------------------------------------

// Every reminder for the next `horizonSeconds` after `startedAt`, sorted by time. Repeating rows
// get their first event, then a "check in" every K cycles so each row stays under `maxPerRow`,
// which by default shares DEFAULT_DAILY_BUDGET between the rows that are on (at least 1 each).
export function buildEvents(rows, {
    startedAt, horizonSeconds = DEFAULT_HORIZON_S, maxPerRow = null,
    assumptions = DEFAULT_ASSUMPTIONS, levelUpSeconds = null, levelUpTarget = null,
} = {}) {
    const t0 = toMs(startedAt);
    if (!Number.isFinite(t0)) throw new Error('reminders need the time the plan was set up');
    const horizonEnd = t0 + horizonSeconds * 1000;
    const active = (rows || []).filter(r => r.on !== false && r.cycleSeconds > 0).length;
    const perRow = maxPerRow || Math.min(DEFAULT_MAX_PER_ROW, Math.max(1, Math.floor(DEFAULT_DAILY_BUDGET / Math.max(1, active))));
    const events = [];
    for (const row of rows || []) {
        if (row.on === false || !(row.cycleSeconds > 0)) continue;
        const start = row.startedAt ? toMs(row.startedAt) : t0;
        if (!Number.isFinite(start)) continue;
        const cycle = row.cycleSeconds * 1000;
        const where = `${pretty(row.item)} on ${row.count}× ${row.facility}`;
        const repeats = row.kind === 'crop' ? !!assumptions.plotsResow : row.kind === 'processor' ? !!assumptions.processorsRepeat : true;
        if (row.kind === 'crop' && assumptions.wateringPrompts) {
            WATERING_FRACTIONS.forEach((fraction, i) => events.push({
                at: start + cycle * fraction, kind: 'water', key: row.key, approximate: true,
                title: `Water ${pretty(row.item)}`,
                body: `${where}: watering ${i + 1} of 2. The moment is approximate until checked in game.`,
            }));
        }
        const first = start + (row.kind === 'processor' ? row.leadSeconds : row.cycleSeconds) * 1000;
        const doneTitle = row.kind === 'crop' ? `Harvest ${pretty(row.item)}` : `${pretty(row.item)} batch done`;
        const firstBody = row.kind === 'processor' && row.leadSeconds > row.cycleSeconds
            ? `${where}: first batch, counting the time its ingredients take to arrive (approximate).`
            : `${where}: first batch since you set up.`;
        events.push({ at: first, kind: 'done', key: row.key, approximate: row.kind === 'processor' && row.leadSeconds > row.cycleSeconds, title: doneTitle, body: firstBody });
        if (!repeats || first >= horizonEnd) continue;
        const occurrences = Math.floor((horizonEnd - first) / cycle) + 1;
        const every = Math.max(1, Math.ceil(occurrences / perRow));
        for (let n = every; n < occurrences; n += every) {
            events.push({
                at: first + n * cycle, kind: 'checkin', key: row.key, approximate: false,
                title: `Check ${row.facility}: ${pretty(row.item)}`,
                body: `${where}: batch ${n + 1} should be done, if every one before it was collected on time.`,
            });
        }
    }
    if (Number.isFinite(levelUpSeconds) && levelUpSeconds > 0) {
        events.push({
            at: t0 + levelUpSeconds * 1000, kind: 'levelup', key: 'level-up', approximate: false,
            title: levelUpTarget ? `RV ${levelUpTarget} should be affordable` : 'Level-up should be affordable',
            body: 'Everything the plan needed for the level-up should be in stock, if the plan was followed exactly.',
        });
    }
    return events.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

export function upcoming(events, now = Date.now()) {
    return events.filter(e => e.at > now);
}

export function formatCountdown(ms) {
    if (!Number.isFinite(ms)) return '?';
    if (ms <= 0) return 'now';
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    if (h > 0) return `in ${h}h ${String(m).padStart(2, '0')}m`;
    if (m > 0) return `in ${m}m`;
    return `in ${s}s`;
}

// --- calendar file ------------------------------------------------------------------

function icsStamp(ms) {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsEscape(text) {
    return String(text).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// RFC 5545 folds content lines longer than 75 octets; folded continuation lines start with a space.
function icsFold(line) {
    const parts = [];
    let rest = line;
    while (rest.length > 74) {
        parts.push(rest.slice(0, 74));
        rest = rest.slice(74);
    }
    parts.push(rest);
    return parts.join('\r\n ');
}

export function icsCalendar(events, { now = Date.now(), uidBase = 'aniimax' } = {}) {
    const stamp = icsStamp(toMs(now));
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//aniimax personal fork//reminders//EN', 'CALSCALE:GREGORIAN'];
    events.forEach((e, i) => {
        lines.push(
            'BEGIN:VEVENT',
            `UID:${uidBase}-${stamp}-${i}@aniimax.local`,
            `DTSTAMP:${stamp}`,
            `DTSTART:${icsStamp(e.at)}`,
            `DTEND:${icsStamp(e.at + 5 * 60 * 1000)}`,
            `SUMMARY:${icsEscape(e.title)}`,
            `DESCRIPTION:${icsEscape(e.body)}`,
            'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(e.title)}`, 'TRIGGER:PT0S', 'END:VALARM',
            'END:VEVENT',
        );
    });
    lines.push('END:VCALENDAR');
    return lines.map(icsFold).join('\r\n') + '\r\n';
}

// --- ntfy.sh ------------------------------------------------------------------

export function isValidTopic(topic) {
    return typeof topic === 'string' && /^[-_A-Za-z0-9]{1,64}$/.test(topic);
}

// A long random topic: on ntfy.sh the topic name is the only secret.
export function suggestTopic(random = Math.random) {
    const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
    let tail = '';
    for (let i = 0; i < 20; i++) tail += alphabet[Math.floor(random() * alphabet.length)];
    return `aniimax-${tail}`;
}

const NTFY_TAGS = { water: 'droplet', done: 'white_check_mark', checkin: 'eyes', levelup: 'tada' };

// One scheduled publish per event that ntfy.sh can take: at least 10 s and at most 3 days ahead,
// and under the daily cap. Everything else is counted in `skipped` so the page can say so.
export function ntfyRequests(events, topic, { now = Date.now(), server = NTFY_SERVER, limit = NTFY_DAILY_LIMIT } = {}) {
    if (!isValidTopic(topic)) throw new Error('the ntfy topic must be 1 to 64 letters, digits, dashes or underscores');
    const skipped = { tooSoon: 0, tooFar: 0, overLimit: 0 };
    const requests = [];
    for (const e of events) {
        const delay = (e.at - now) / 1000;
        if (delay < NTFY_MIN_DELAY_S) { skipped.tooSoon++; continue; }
        if (delay > NTFY_MAX_DELAY_S) { skipped.tooFar++; continue; }
        requests.push({
            eventAt: e.at,
            url: `${server}/${topic}`,
            headers: { 'X-Delay': String(Math.round(e.at / 1000)), 'X-Title': e.title, 'X-Tags': NTFY_TAGS[e.kind] || 'bell' },
            body: e.body,
        });
    }
    if (requests.length > limit) {
        skipped.overLimit = requests.length - limit;
        requests.length = limit;
    }
    return { requests, skipped };
}

// Publishes in order; stops at the first failure and says how far it got. Returns what was sent,
// with ntfy's message ids so they can be cancelled.
export async function sendNtfy(requests, fetchImpl = globalThis.fetch) {
    const sent = [];
    for (const r of requests) {
        let response;
        try {
            response = await fetchImpl(r.url, { method: 'POST', headers: r.headers, body: r.body });
        } catch (error) {
            throw new Error(`could not reach ntfy.sh after ${sent.length} of ${requests.length} reminders (${error.message})`);
        }
        if (!response.ok) throw new Error(`ntfy.sh answered ${response.status} after ${sent.length} of ${requests.length} reminders`);
        const data = await response.json();
        sent.push({ id: String(data.id ?? ''), at: r.eventAt, title: r.headers['X-Title'] });
    }
    return sent;
}

export async function cancelNtfy(sent, topic, fetchImpl = globalThis.fetch, server = NTFY_SERVER) {
    if (!isValidTopic(topic)) throw new Error('no valid ntfy topic to cancel on');
    let ok = 0, failed = 0;
    for (const s of sent || []) {
        if (!s?.id) { failed++; continue; }
        try {
            const response = await fetchImpl(`${server}/${topic}/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
            if (response.ok) ok++; else failed++;
        } catch (_) {
            failed++;
        }
    }
    return { ok, failed };
}
