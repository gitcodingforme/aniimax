// Batch-done reminders: timers built from the plan's batch times once the player says "I just set
// everything up per the plan", delivered in the tab, as scheduled ntfy.sh pushes, or as a calendar
// file. Pure functions only (no DOM, no storage); tested in tests/reminders.test.mjs. app.js wires
// buttons, storage and the browser APIs.
//
// The app cannot see the game, so every event assumes the player did exactly what the plan says
// at the moment they pressed the button. Game facts not yet verified are `assumptions` switches.
import { FOOD_NOTE, feedEvent, foodHours, workingAniimo } from './food.js?v=fork-m10-1';

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
// Where in a crop's timer the two watering prompts come. The engine's own model is two thirds
// and one third of the time left (src/models.rs); upstream issue 14 reports "once at 33% on the
// timer and once on 75%". A setting picks one until it is checked in game.
export const WATERING_POINTS = Object.freeze({
    'two-thirds': [1 / 3, 2 / 3],
    'three-quarters': [1 / 3, 3 / 4],
});
export const WATERING_FRACTIONS = WATERING_POINTS['two-thirds'];

export const DEFAULT_ASSUMPTIONS = Object.freeze({
    processorsRepeat: true,        // a processor keeps working by itself until its output store is full (fan wikis, not verified)
    plotsResow: true,              // a staffed plot is re-sown after harvest until its store is full (fan wikis, not verified)
    wateringPrompts: true,         // crops ask for water twice as they grow (approximate moments)
    secondWatering: 'two-thirds',  // a key of WATERING_POINTS
    firstBatch: true,              // also say when the first batch is done, not only when to collect
    workersFed: true,              // the workers are kept fed, so no food cost is in the plan (the note below says so when it is off)
    foodEnergy: null,              // food energy in the bowl when the plan was set up; a positive number adds a "refill the food bowl" reminder
});

// One line for the Reminders card when the player says their workers are not kept fed: the plan
// still assumes they are and subtracts no food cost. '' when `workersFed` is on. Takes the
// reminder settings (`{ assumptions }`) or the assumptions themselves.
export function foodNote(settings) {
    const assumptions = settings && typeof settings === 'object' && settings.assumptions && typeof settings.assumptions === 'object' ? settings.assumptions : settings;
    return assumptions && typeof assumptions === 'object' && assumptions.workersFed === false ? FOOD_NOTE : '';
}

export function wateringFractions(assumptions = DEFAULT_ASSUMPTIONS) {
    return WATERING_POINTS[assumptions?.secondWatering] || WATERING_FRACTIONS;
}

export function pretty(name) {
    return String(name ?? '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function toMs(value) {
    if (typeof value === 'number') return value;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : NaN;
}

// --- rows from the plan ------------------------------------------------------------------

// One row per producing facility row of the plan: what runs where, how long a batch takes, and,
// when `recipes` (the recipe list from get_all_items, or app.js's recipeIndex) and `facilities`
// (the setup sent to the solver, `{ name: [{count, level}] }`) are given, how much a batch makes
// and which facility level makes it. Both are needed to know when the output store fills up.
//
// Two times per row: `cycleSeconds` is how long one batch takes with every ingredient on hand
// ("a batch takes X"), and `effectiveCycleSeconds` is the real time between finished batches on
// each unit under the plan. A processor waits for what its suppliers make, so a 9-second recipe
// fed 12 items an hour finishes one batch every 5 minutes, and its store fills that slowly. It
// comes from the plan's output rate (see processorInterval), is never less than cycleSeconds, and
// equals it for crops and gatherers, which work at their own pace.
export function planRows(plan, { recipes = null, facilities = null } = {}) {
    const streams = plan?.income_streams || [];
    const steps = (plan?.coin_items || [])
        .filter(s => s && s.status === 'producing' && s.item_name && s.cycle_time > 0 && s.facility_count > 0);
    const rows = steps
        .map(s => {
            const kind = s.facility === 'Farmland' || s.facility === 'Woodland' ? 'crop' : s.is_grower ? 'gatherer' : 'processor';
            const stream = streams.find(p => p.item_name === s.item_name);
            const recipe = findRecipe(recipes, s.item_name, s.facility);
            const minLevel = recipe ? (recipe.facilityLevel ?? recipe.facility_level ?? 1) : 1;
            return {
                key: `${s.facility}|${s.item_name}`,
                facility: s.facility,
                item: s.item_name,
                kind,
                cycleSeconds: s.cycle_time,
                // Seconds between finished batches on each unit; set below for processors.
                effectiveCycleSeconds: s.cycle_time,
                count: s.facility_count,
                busy: Number.isFinite(s.busy_units) ? s.busy_units : s.facility_count,
                // Seconds until this processor's first batch can be done: the engine's lead time is the
                // wait before its first input exists (0 when nothing blocks it), then one batch.
                leadSeconds: kind === 'processor' && stream && stream.lead_time_seconds > 0 ? stream.lead_time_seconds + s.cycle_time : s.cycle_time,
                // Items one batch makes (a processor makes one). Null without a recipe list.
                yieldPerBatch: recipe ? Math.max(1, Number(recipe.yieldAmount ?? recipe.yield_amount) || 1) : null,
                // The facility level this row runs at, from the setup. Null when the setup is not given.
                level: facilities ? rowLevel(facilities[s.facility], minLevel) : null,
                on: true,
                startedAt: null,
            };
        });
    const sold = soldRates(plan, rows);
    rows.forEach((row, i) => {
        if (row.kind === 'processor') row.effectiveCycleSeconds = processorInterval(row, steps[i].busy_units, sold[i]);
    });
    return rows;
}

// An item's name without the plan's variant suffixes (as plan-summary.js's stripVariant).
function baseItem(name) {
    return typeof name === 'string' ? name.replace(/__by\d+$/, '').replace(/__uncovered$/, '') : name;
}

// Units a second the plan sells of each row's item, in `rows` order: income_streams'
// units_per_second, plus byproduct_rates (`[name, per second, lead]`) of the same name. A stream
// several rows make is split between them by facility count, the rows at the stream's own facility
// first (as session.js's rowRates splits the coins).
function soldRates(plan, rows) {
    const out = rows.map(() => 0);
    const sources = [];
    for (const s of Array.isArray(plan?.income_streams) ? plan.income_streams : []) {
        if (s && Number(s.units_per_second) > 0) sources.push({ item: baseItem(s.item_name), facility: s.facility, perSecond: Number(s.units_per_second) });
    }
    for (const b of Array.isArray(plan?.byproduct_rates) ? plan.byproduct_rates : []) {
        if (Array.isArray(b) && Number(b[1]) > 0) sources.push({ item: baseItem(b[0]), facility: null, perSecond: Number(b[1]) });
    }
    const all = rows.map((_, i) => i);
    for (const source of sources) {
        let makers = all.filter(i => baseItem(rows[i].item) === source.item && rows[i].facility === source.facility);
        if (makers.length === 0) makers = all.filter(i => baseItem(rows[i].item) === source.item);
        const weight = i => (rows[i].count > 0 ? rows[i].count : 1);
        const weights = makers.reduce((sum, i) => sum + weight(i), 0);
        for (const i of makers) out[i] += source.perSecond * weight(i) / weights;
    }
    return out;
}

// Seconds between finished batches on each unit of a processor row. First choice is the plan's
// busy_units (how many of its units are busy on average): it is per row and counts what the row
// makes for other recipes too. Else what the plan sells of its item, `count × yield / units per
// second` (one batch per unit per interval). Else the batch time. Never less than the batch time.
function processorInterval(row, busyUnits, soldPerSecond) {
    const busy = Number(busyUnits);
    let interval = row.cycleSeconds;
    if (Number.isFinite(busy) && busy > 0) interval = row.cycleSeconds * row.count / busy;
    else if (soldPerSecond > 0) interval = row.count * (row.yieldPerBatch || 1) / soldPerSecond;
    return Math.max(row.cycleSeconds, interval);
}

// Seconds between finished batches for a row: its effectiveCycleSeconds, never less than its batch
// time, and the batch time for rows saved before the field existed.
export function effectiveCycle(row) {
    const cycle = Number(row?.cycleSeconds);
    const effective = Number(row?.effectiveCycleSeconds);
    return Number.isFinite(effective) && effective > cycle ? effective : cycle;
}

// A duration for a reminder's text: "45s", "10m", "1h 40m".
function spanText(seconds) {
    const total = Math.round(seconds);
    if (total < 60) return `${total}s`;
    const h = Math.floor(total / 3600), m = Math.round((total % 3600) / 60);
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function findRecipe(recipes, item, facility) {
    if (!Array.isArray(recipes)) return null;
    const base = String(item).replace(/__uncovered$/, '');
    return recipes.find(r => r.name === base && r.facility === facility) || recipes.find(r => r.name === base) || null;
}

// The facility level a plan row runs at: the lowest owned tier that can make the item (the
// smallest store, so the earliest honest reminder). Falls back to the lowest owned tier at all,
// and to null when nothing is owned or the tiers are unknown.
export function rowLevel(tiers, minLevel = 1) {
    const owned = (Array.isArray(tiers) ? tiers : []).filter(t => t && t.count > 0 && Number.isInteger(t.level) && t.level >= 1);
    const able = owned.filter(t => t.level >= minLevel);
    const pick = able.length > 0 ? able : owned;
    return pick.length > 0 ? Math.min(...pick.map(t => t.level)) : null;
}

// --- output caps ------------------------------------------------------------------

// How much a facility holds before it stops: `caps` is OUTPUT_CAPS from facility-config.js (with
// overrides applied), one entry per facility level. Past the end of the list the last entry
// holds, as for facility counts. With no level, the cap is known only when every level agrees.
// Null means "no cap known", and the reminders fall back to batch check-ins.
export function outputCap(caps, facility, level) {
    const list = caps?.[facility];
    if (!Array.isArray(list) || list.length === 0) return null;
    let cap;
    if (Number.isInteger(level) && level >= 1) {
        cap = list[Math.min(level, list.length) - 1];
    } else {
        cap = list.every(n => n === list[0]) ? list[0] : null;
    }
    return Number.isInteger(cap) && cap > 0 ? cap : null;
}

// Batches the store takes before it is full: whole batches only, and at least one (a batch
// bigger than the store still has to be collected after it).
export function batchesUntilFull(cap, yieldPerBatch) {
    if (!(cap > 0) || !(yieldPerBatch > 0)) return null;
    return Math.max(1, Math.floor(cap / yieldPerBatch));
}

// --- events ------------------------------------------------------------------

// Every reminder for the next `horizonSeconds` after `startedAt`, sorted by time. The main event
// of a repeating row is "collect before the store is full": the row's cap (from `caps`, by its
// level) divided by what a batch makes, times the time between finished batches (effectiveCycle,
// which for a processor short of ingredients is longer than its batch time). Batch k is done
// `wait + k × interval` after setup, `wait` being a processor's wait for its first ingredients;
// session.js's fillSeconds uses the same moment. Optionally the first batch gets its
// own event, and crops their watering prompts. A row with no known cap falls back to the old
// "check in every K cycles", so each row stays under `maxPerRow`, which by default shares
// DEFAULT_DAILY_BUDGET between the rows that are on (at least 1 each).
//
// Two single events come after the rows, outside the per-row limit and kept even past the horizon:
// the level-up, and (when the food energy is a positive number) one "refill the food bowl" at setup
// plus the hours that much food lasts for the working Aniimo (food.js). Two options, both meant to be
// saved with the timers at setup so a later change to the settings cannot move a running reminder:
// `foodEnergy`, the food energy in the bowl when the timers started, and `workers`, the number of
// working Aniimo (food.js's workingAniimo, with the roster). Without `foodEnergy` (null or
// undefined) it is read from `assumptions.foodEnergy`; without `workers` the Aniimo are counted from
// `rows`.
export function buildEvents(rows, {
    startedAt, horizonSeconds = DEFAULT_HORIZON_S, maxPerRow = null,
    assumptions = DEFAULT_ASSUMPTIONS, levelUpSeconds = null, levelUpTarget = null, caps = null, workers = null, foodEnergy = null,
} = {}) {
    const t0 = toMs(startedAt);
    if (!Number.isFinite(t0)) throw new Error('reminders need the time the plan was set up');
    const horizonEnd = t0 + horizonSeconds * 1000;
    const active = (rows || []).filter(r => r.on !== false && r.cycleSeconds > 0).length;
    const perRow = maxPerRow || Math.min(DEFAULT_MAX_PER_ROW, Math.max(1, Math.floor(DEFAULT_DAILY_BUDGET / Math.max(1, active))));
    const fractions = wateringFractions(assumptions);
    const firstBatch = assumptions.firstBatch !== false;
    const events = [];
    for (const row of rows || []) {
        if (row.on === false || !(row.cycleSeconds > 0)) continue;
        const start = row.startedAt ? toMs(row.startedAt) : t0;
        if (!Number.isFinite(start)) continue;
        const cycle = row.cycleSeconds * 1000;      // one batch (a crop's grow time, for watering)
        const interval = effectiveCycle(row) * 1000; // between finished batches
        const item = pretty(row.item);
        const where = `${item} on ${row.count}× ${row.facility}`;
        const repeats = row.kind === 'crop' ? !!assumptions.plotsResow : row.kind === 'processor' ? !!assumptions.processorsRepeat : true;
        if (row.kind === 'crop' && assumptions.wateringPrompts) {
            fractions.forEach((fraction, i) => events.push({
                at: start + cycle * fraction, kind: 'water', key: row.key, approximate: true,
                title: `Water ${item}`,
                body: `${where}: watering ${i + 1} of 2, at ${Math.round(fraction * 100)}% of the grow time. The moment is approximate until checked in game.`,
            }));
        }
        const leadBound = row.kind === 'processor' && row.leadSeconds > row.cycleSeconds;
        const wait = leadBound ? (row.leadSeconds - row.cycleSeconds) * 1000 : 0;
        const first = start + wait + interval;
        const doneTitle = row.kind === 'crop' ? `Harvest ${item}` : `${item} batch done`;
        const firstBody = leadBound
            ? `${where}: first batch, counting the time its ingredients take to arrive (approximate).`
            : `${where}: first batch since you set up.`;
        const cap = repeats ? outputCap(caps, row.facility, row.level) : null;
        const batches = batchesUntilFull(cap, row.yieldPerBatch);
        if (batches) {
            // The store is full `batches` batches after setup; collecting then restarts the count.
            const span = batches * interval;
            const fullAt = first + (batches - 1) * interval;
            const store = row.kind === 'processor' ? `${cap} batches` : `${cap} ${item} (${batches} ${batches === 1 ? 'batch' : 'batches'} of ${row.yieldPerBatch})`;
            const level = row.level ? ` at level ${row.level}` : '';
            const pace = interval > cycle * 1.05
                ? ` A batch takes ${spanText(row.cycleSeconds)}, but its ingredients arrive for about one every ${spanText(interval / 1000)}${row.count > 1 ? ' on each' : ''}.`
                : '';
            if (firstBatch && batches > 1) {
                events.push({ at: first, kind: 'done', key: row.key, approximate: leadBound, title: doneTitle, body: firstBody });
            }
            let n = 0;
            for (let at = fullAt; n < perRow && (n === 0 || at < horizonEnd); at += span, n++) {
                events.push({
                    at, kind: 'collect', key: row.key, approximate: leadBound,
                    title: `Collect ${item}`,
                    body: `${where}: the ${row.facility}${level} holds ${store}, then stops until collected.`
                        + (n > 0 ? ` Fill-up ${n + 1} since setup, if each earlier one was collected on time.` : '')
                        + pace
                        + ' Cap from a fan wiki, not checked in game.',
                });
            }
            continue;
        }
        if (firstBatch) events.push({ at: first, kind: 'done', key: row.key, approximate: leadBound, title: doneTitle, body: firstBody });
        if (!repeats || first >= horizonEnd) continue;
        // No cap known for this facility at this level: check in every K cycles instead.
        const occurrences = Math.floor((horizonEnd - first) / interval) + 1;
        const every = Math.max(1, Math.ceil(occurrences / perRow));
        for (let n = every; n < occurrences; n += every) {
            events.push({
                at: first + n * interval, kind: 'checkin', key: row.key, approximate: false,
                title: `Check ${row.facility}: ${item}`,
                body: `${where}: batch ${n + 1} should be done, if every one before it was collected on time. No output cap is known for this ${row.facility}${row.level ? ` at level ${row.level}` : ''}, so this is a check-in, not a "full" moment.`,
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
    // The timers' own value wins; the live setting is only for timers that carry none. A number input's value may arrive as text.
    const savedEnergy = foodEnergy ?? assumptions?.foodEnergy;
    const energy = typeof savedEnergy === 'string' && savedEnergy.trim() ? Number(savedEnergy) : savedEnergy;
    if (typeof energy === 'number' && energy > 0) {
        const crew = Number.isFinite(workers) && workers > 0 ? workers : workingAniimo(rows);
        const feed = feedEvent(t0, foodHours(energy, crew));
        if (feed) events.push(feed);
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

const NTFY_TAGS = { water: 'droplet', done: 'white_check_mark', collect: 'package', checkin: 'eyes', levelup: 'tada', feed: 'fork_and_knife' };

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

// --- calendar links (Google, Outlook on the web) ------------------------------------------------

export const GOOGLE_CALENDAR_URL = 'https://calendar.google.com/calendar/render';
export const OUTLOOK_CALENDAR_URL = 'https://outlook.live.com/calendar/0/deeplink/compose';
export const DEFAULT_EVENT_MINUTES = 5;

// The start and end of an event in ms. An event with no usable time cannot become a link.
function calendarSpan(event, durationMinutes) {
    const start = toMs(event?.at);
    if (!Number.isFinite(start)) throw new Error('a calendar link needs the time of the reminder');
    const minutes = Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : DEFAULT_EVENT_MINUTES;
    return { start, end: start + minutes * 60 * 1000 };
}

// The event text for a calendar entry: approximate moments say so, because the entry is a fixed
// time and the game's real moment can differ. A body that already says so is left as it is.
function calendarDetails(event) {
    const body = String(event?.body ?? '');
    return event?.approximate && !/approximate/i.test(body) ? `${body} (approximate)` : body;
}

// An "add to Google Calendar" link: one click opens a pre-filled event for the signed-in account.
// Times are UTC (YYYYMMDDTHHMMSSZ) so the link is the same in every time zone.
export function googleCalendarUrl(event, { durationMinutes = DEFAULT_EVENT_MINUTES, location = '' } = {}) {
    const { start, end } = calendarSpan(event, durationMinutes);
    let url = `${GOOGLE_CALENDAR_URL}?action=TEMPLATE`
        + `&text=${encodeURIComponent(String(event.title ?? ''))}`
        + `&dates=${icsStamp(start)}/${icsStamp(end)}`
        + `&details=${encodeURIComponent(calendarDetails(event))}`;
    if (location) url += `&location=${encodeURIComponent(String(location))}`;
    return url;
}

// The same for Outlook on the web (outlook.live.com), which takes ISO times. `path` and `rru` are
// the two extra parameters its compose page expects from a link.
export function outlookCalendarUrl(event, { durationMinutes = DEFAULT_EVENT_MINUTES, location = '' } = {}) {
    const { start, end } = calendarSpan(event, durationMinutes);
    const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    let url = `${OUTLOOK_CALENDAR_URL}?subject=${encodeURIComponent(String(event.title ?? ''))}`
        + `&startdt=${encodeURIComponent(iso(start))}`
        + `&enddt=${encodeURIComponent(iso(end))}`
        + `&body=${encodeURIComponent(calendarDetails(event))}`;
    if (location) url += `&location=${encodeURIComponent(String(location))}`;
    return url + `&path=${encodeURIComponent('/calendar/action/compose')}&rru=addevent`;
}

// One entry per event for the reminders list: the event and its Google link. An event that
// cannot become a link (no usable time) is skipped, so one bad event does not hide the rest.
export function calendarLinks(events, options) {
    const links = [];
    for (const event of events || []) {
        try {
            links.push({ event, google: googleCalendarUrl(event, options) });
        } catch (_) {
            // skipped
        }
    }
    return links;
}
