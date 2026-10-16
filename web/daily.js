// Daily checklist: what to do in one play session, from the running reminders and the plan. It is a
// different thing from the Setup checklist (checklist.js): that one resets when the plan changes,
// this one starts fresh every local day. Pure functions only (no DOM, no storage); tested in
// tests/daily.test.mjs. web/cards/daily.js draws it and keeps the ticks in localStorage under DAILY_KEY.
import { DEFAULT_ASSUMPTIONS, buildEvents, effectiveCycle, planRows, pretty } from './reminders.js?v=fork-m10-2';

export const DAILY_KEY = 'aniimax-daily-v1';
export const GROUPS = Object.freeze(['Collect', 'Water', 'Replant', 'Food', 'Level']);
const MARGIN_S = 3600;     // slack past midnight, so an event right at the end of the day is not cut off
const ROW_EVENTS_CEILING = 3000;   // most events buildEvents may make for one row (it stops at its per-row limit, counted from setup)
const MAX_ROW_ITEMS = 12;  // most collect lines one row gets in the list; a faster row is thinned evenly, not listed 48 times
const LOOKAHEAD_MS = 12 * 3600 * 1000;   // the list reaches the later of the end of today and this far past now
const MAX_REPLANT_ITEMS = 24;   // most replant lines one row gets in 24 hours; a faster crop is thinned evenly, counting from its first harvest

// The line above the list when the running timers were set up from a different plan than the one
// on screen now. Their times still count, but they may no longer match what is built.
export const STALE_TIMERS_NOTE = 'These timers come from an older plan, not the one on screen now. Press "I just set everything up per the plan" in Reminders to start timers from the current plan.';

// '' when the timers match the plan on screen (or there is nothing to compare), else STALE_TIMERS_NOTE.
// `timers.planHash` is the setupHash the reminders were started from (app.js setUpPerPlan);
// `planTopic` is the 'plan' topic's value, whose `setupHash` is the plan on screen.
export function staleTimersNote(timers, planTopic) {
    const started = timers?.planHash, current = planTopic?.setupHash;
    return typeof started === 'string' && started && typeof current === 'string' && current && started !== current ? STALE_TIMERS_NOTE : '';
}

const ms = value => (value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value));
const pad = n => String(n).padStart(2, '0');

// --- time (all local) ----------------------------------------------------------------------

// 'YYYY-MM-DD' in local time (not UTC), for a Date or a time in ms. Null for something that is not a time.
export function dayKey(date = Date.now()) {
    const d = new Date(ms(date));
    return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local 24-hour 'HH:MM' (for tests and sorting; the card shows timeLabel).
export function clock(at) {
    const d = new Date(ms(at));
    return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// A time as the Reminders card shows it: the browser's own short time ('11:35 PM'), with 'Tomorrow',
// 'Yesterday' or the date in front when it is not the same calendar day as `now`.
export function timeLabel(at, now = Date.now(), locale = undefined) {
    const d = new Date(ms(at)), n = new Date(ms(now));
    if (Number.isNaN(d.getTime()) || Number.isNaN(n.getTime())) return '';
    const time = d.toLocaleTimeString(locale, { timeStyle: 'short' });
    const days = Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())) / 86400000);
    if (days === 0) return time;
    if (days === 1) return `Tomorrow ${time}`;
    if (days === -1) return `Yesterday ${time}`;
    return `${d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} ${time}`;
}

// [start, end) of the local day that `nowMs` falls in; built from the calendar date so a 23 or 25 hour day is right.
function dayBounds(nowMs) {
    const d = new Date(nowMs);
    return [new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()];
}

// --- today's items ------------------------------------------------------------------------

// The actions from the start of today to the later of midnight and 12 hours from now, as
// [{ id, group, title, at (ms or null), overdue, approximate? }], sorted by group then time. Collect
// lines are only "the store is full" moments (and check-ins for rows with no known store size); a
// row's first batch gets one "Ready" line. `timers` is the running reminders (or null), `settings` the reminder settings, `plan` the
// find_plan result and `context` the plan topic's context. `ticked` is the ids already ticked today:
// an item is overdue when its time has passed and it is not in there. `name` turns an item name into
// text (the page's own item formatter; defaults to the reminders' one). Without timers it falls back
// to one Collect line per producing plan row, which has no time.
//
// Food: when the reminder settings carry a positive `assumptions.foodEnergy`, the "refill the food bowl" reminder
// (reminders.js) becomes one "Refill food" line, in its own Food group, if it falls in the list's window.
// `timers.workers`, the working Aniimo counted when the timers were started (food.js), is passed on to it.
// Replant: with re-sowing off, every harvest in the window gets a Replant line, not only the first.
export function dailyItems({ timers = null, settings = null, plan = null, context = null, now = Date.now(), caps = null, ticked = [], name = pretty } = {}) {
    const nowMs = ms(now);
    const [dayStart, dayEnd] = dayBounds(nowMs);
    const done = new Set(ticked);
    const found = new Map();
    const add = (id, group, title, at = null, extra = {}) => {
        if (!found.has(id)) found.set(id, { id, group, title, at, overdue: at !== null && at <= nowMs && !done.has(id), ...extra });
    };
    const nice = item => name(String(item ?? '').replace(/__uncovered$/, ''));
    const startedMs = ms(timers?.startedAt);
    const target = timers?.levelUpTarget ?? context?.target ?? null;

    if (Array.isArray(timers?.rows) && Number.isFinite(startedMs)) {
        const assumptions = { ...DEFAULT_ASSUMPTIONS, ...settings?.assumptions };
        const rows = new Map(timers.rows.map(r => [r.key, r]));
        const levelUpSeconds = timers.levelUpSeconds > 0 ? timers.levelUpSeconds : null;
        // The list runs from the start of today to the later of the end of today and 12 hours from now, so a
        // session at 23:35 still shows the morning. The horizon counts from startedAt, not from now, so it
        // reaches that end however old the timers are. The per-row limit also counts from setup: it must
        // allow one event per fastest cycle over that whole span, or a quick row on old timers would run
        // out of events before today.
        const windowEnd = Math.max(dayEnd, nowMs + LOOKAHEAD_MS);
        const active = timers.rows.filter(r => r.on !== false && r.cycleSeconds > 0);
        const earliest = Math.min(startedMs, ...active.map(r => (r.startedAt && ms(r.startedAt)) || startedMs));
        const fastest = Math.min(Infinity, ...active.map(effectiveCycle));
        const maxPerRow = Math.min(ROW_EVENTS_CEILING, Math.max(6, Math.ceil(((windowEnd - earliest) / 1000 + MARGIN_S) / fastest) + 2));
        const events = buildEvents(timers.rows, {
            startedAt: timers.startedAt, horizonSeconds: Math.max(0, (windowEnd - startedMs) / 1000) + MARGIN_S,
            assumptions, levelUpSeconds, levelUpTarget: target, caps, maxPerRow, workers: timers.workers, foodEnergy: timers.foodEnergy,
        });
        const ready = new Map();      // row key -> its first batch (the "done" event, made once per row)
        const harvests = new Map();   // row key -> store-full ("collect") and check-in events in the window
        for (const e of events) {
            const at = Math.round(e.at), row = rows.get(e.key), approximate = !!e.approximate;
            if (e.kind === 'levelup') {
                if (at <= nowMs) add(`levelup:${target ?? ''}`, 'Level', target ? `Level up to RV ${target} now` : 'Level up now', at);
            } else if (e.kind === 'feed') {
                // One reminder, from the food energy typed in at setup; it has no row. An estimate, so approximate.
                if (at >= dayStart && at < windowEnd) add(`feed:${timers.startedAt}`, 'Food', 'Refill food', at, { approximate });   // the id follows the timers, not the time, which moves with the worker count
            } else if (!row || at < dayStart || at >= windowEnd) {
                continue;
            } else if (e.kind === 'water') {
                add(`water:${e.key}:${at}`, 'Water', `Water ${nice(row.item)} on ${row.facility}`, at, { approximate });
            } else if (e.kind === 'done') {
                if (!ready.has(e.key)) ready.set(e.key, { at, approximate });
            } else {
                harvests.set(e.key, [...(harvests.get(e.key) || []), { at, kind: e.kind, approximate }]);
            }
        }
        // First batches: ready, which is not the same as the store being full.
        for (const [key, e] of ready) {
            const row = rows.get(key), crop = row.kind === 'crop';
            add(`ready:${key}:${e.at}`, 'Collect', crop ? `Ready to harvest: ${nice(row.item)} on ${row.facility}` : `Ready: first ${nice(row.item)} batch at ${row.facility}`, e.at, { approximate: e.approximate });
        }
        // A crop that is not re-sown waits for the player: every harvest in the window is also a replant. The first
        // is the plan's own first-batch time; later ones are one grow time apart if each replant was on time, so
        // they are approximate. They are made here, not from the events, because with re-sowing off buildEvents
        // makes no later harvest events (the plot sits idle until it is replanted).
        if (!assumptions.plotsResow) {
            for (const row of timers.rows) {
                if (row.kind !== 'crop' || row.on === false || !(row.cycleSeconds > 0)) continue;
                const start = row.startedAt ? ms(row.startedAt) : startedMs;
                if (!Number.isFinite(start)) continue;
                const interval = effectiveCycle(row) * 1000, first = start + interval;
                // Harvests number n = 0, 1, 2 ... after the first; those from the start of today up to the window's end.
                const from = Math.max(0, Math.ceil((dayStart - first) / interval));
                // Thinned on the harvest's own number (every step-th harvest since setup), with a step that depends only on
                // the crop, so a line keeps its id as the window moves through the day and its tick is not lost.
                const step = Math.max(1, Math.ceil(86400000 / interval / MAX_REPLANT_ITEMS));
                for (let n = Math.ceil(from / step) * step; first + n * interval < windowEnd; n += step) {
                    const at = Math.round(first + n * interval);
                    add(`replant:${row.key}:${at}`, 'Replant', n === 0 ? `Replant ${nice(row.item)} on ${row.facility}` : `Harvest, then replant ${nice(row.item)} on ${row.facility}`, at, { approximate: n > 0 });
                }
            }
        }
        // Store full: collect. Check-ins exist only for rows whose store size is not known.
        for (const [key, list] of harvests) {
            const row = rows.get(key), crop = row.kind === 'crop', step = Math.ceil(list.length / MAX_ROW_ITEMS);
            for (const e of list.filter((_, i) => i % step === 0)) {
                const title = e.kind === 'checkin' ? `Check ${nice(row.item)} at ${row.facility}` : `${crop ? 'Harvest' : 'Collect'} ${nice(row.item)} from ${row.facility}`;
                add(`${e.kind}:${key}:${e.at}`, 'Collect', title, e.at, { approximate: e.approximate });
            }
        }
    } else {
        for (const row of planRows(plan)) add(`collect:${row.key}`, 'Collect', `Collect ${nice(row.item)} from ${row.facility}`);
    }

    const count = value => Math.round(value).toLocaleString('en-US');
    for (const r of context?.unavailable ? [] : plan?.level_up?.requirements || []) {
        const missing = Math.ceil(r.need - r.have - 1e-9);
        if (!(r.have < r.need) || missing < 1) continue;
        add(`level:${r.name}`, 'Level', `Get ${count(missing)} more ${r.name === 'coins' ? 'Home Coins' : nice(r.name)}${target ? ` for RV ${target}` : ''} (${count(r.have)} of ${count(r.need)} in stock)`);
    }
    // Stable sort: lines with the same time (or none) keep the order they were added in, which is the plan's.
    return [...found.values()].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group)
        || (a.at === null) - (b.at === null) || (a.at ?? 0) - (b.at ?? 0));
}

// The non-empty groups, in display order: [{ group, items }].
export function groupItems(items) {
    return GROUPS.map(group => ({ group, items: (items || []).filter(i => i.group === group) })).filter(g => g.items.length > 0);
}

// --- ticks, kept per local day ----------------------------------------------------------------

// { version: 1, days: { 'YYYY-MM-DD': { ticked: [ids], doneAt: ISO string | null } } }
export const emptyState = () => ({ version: 1, days: {} });
const entry = (state, day) => state?.days?.[day] || { ticked: [], doneAt: null };
const put = (state, day, value) => ({ version: 1, days: { ...(state?.days || {}), [day]: value } });

function clean(saved) {
    const state = emptyState();
    if (saved?.version !== 1 || !saved.days || typeof saved.days !== 'object') return state;
    for (const [day, v] of Object.entries(saved.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !v || typeof v !== 'object') continue;
        const ticked = (Array.isArray(v.ticked) ? v.ticked : []).filter(id => typeof id === 'string');
        state.days[day] = { ticked: [...new Set(ticked)], doneAt: typeof v.doneAt === 'string' ? v.doneAt : null };
    }
    return state;
}

// The saved text (or null) as a state. Anything unreadable gives an empty one; it never throws.
export function readState(raw) {
    try { return clean(typeof raw === 'string' && raw ? JSON.parse(raw) : null); } catch { return emptyState(); }
}

export const writeState = state => JSON.stringify(clean(state));

// Flips one item for that day, or sets it when `on` is given.
export function toggle(state, day, id, on) {
    const ticked = new Set(entry(state, day).ticked);
    if (on === undefined ? !ticked.has(id) : on) ticked.add(id); else ticked.delete(id);
    return put(state, day, { ...entry(state, day), ticked: [...ticked] });
}

// Ticks every id and records when ("I did all this").
export function tickAll(state, day, ids, doneAt) {
    return put(state, day, { ticked: [...new Set([...entry(state, day).ticked, ...ids])], doneAt: doneAt ?? null });
}

export function untickDay(state, day) {
    const days = { ...(state?.days || {}) };
    delete days[day];
    return { version: 1, days };
}

// Keeps the newest `keepDays` days that have anything saved.
export function prune(state, keepDays = 14) {
    const keep = Object.keys(state?.days || {}).sort().reverse().slice(0, Math.max(0, keepDays));
    return { version: 1, days: Object.fromEntries(keep.map(day => [day, state.days[day]])) };
}

// How many of these ids are ticked that day (ticks for ids no longer in the list do not count).
export function doneCount(state, day, ids) {
    const ticked = new Set(entry(state, day).ticked);
    return (ids || []).filter(id => ticked.has(id)).length;
}

export const allDone = (state, day, ids) => (ids || []).length > 0 && doneCount(state, day, ids) === ids.length;

export const snapshotNote = (day, done, total) => `Daily checklist ${day}: ${done} of ${total} done`;
