// Daily checklist: what to do in one play session, from the running reminders and the plan. It is a
// different thing from the Setup checklist (checklist.js): that one resets when the plan changes,
// this one starts fresh every local day. Pure functions only (no DOM, no storage); tested in
// tests/daily.test.mjs. web/cards/daily.js draws it and keeps the ticks in localStorage under DAILY_KEY.
import { DEFAULT_ASSUMPTIONS, buildEvents, planRows, pretty } from './reminders.js?v=fork-m9-1';

export const DAILY_KEY = 'aniimax-daily-v1';
export const GROUPS = Object.freeze(['Collect', 'Water', 'Replant', 'Level']);
const MARGIN_S = 3600;     // slack past midnight, so an event right at the end of the day is not cut off
const ROW_EVENTS_CEILING = 3000;   // most events buildEvents may make for one row (it stops at its per-row limit, counted from setup)
const MAX_ROW_ITEMS = 12;  // most collect lines one row gets in a day; a faster row is thinned evenly, not listed 48 times

const ms = value => (value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value));
const pad = n => String(n).padStart(2, '0');

// --- time (all local) ----------------------------------------------------------------------

// 'YYYY-MM-DD' in local time (not UTC), for a Date or a time in ms. Null for something that is not a time.
export function dayKey(date = Date.now()) {
    const d = new Date(ms(date));
    return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local 'HH:MM'.
export function clock(at) {
    const d = new Date(ms(at));
    return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// [start, end) of the local day that `nowMs` falls in; built from the calendar date so a 23 or 25 hour day is right.
function dayBounds(nowMs) {
    const d = new Date(nowMs);
    return [new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()];
}

// --- today's items ------------------------------------------------------------------------

// Today's actions as [{ id, group, title, at (ms or null), overdue, approximate? }], sorted by group then
// time. `timers` is the running reminders (or null), `settings` the reminder settings, `plan` the
// find_plan result and `context` the plan topic's context. `ticked` is the ids already ticked today:
// an item is overdue when its time has passed and it is not in there. `name` turns an item name into
// text (the page's own item formatter; defaults to the reminders' one). Without timers it falls back
// to one Collect line per producing plan row, which has no time.
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
        // The horizon counts from startedAt, not from now, so it reaches the end of today however old the timers are.
        // The per-row limit also counts from setup: it must allow one event per fastest cycle over that whole span,
        // or a quick row on old timers would run out of events before today.
        const active = timers.rows.filter(r => r.on !== false && r.cycleSeconds > 0);
        const first = Math.min(startedMs, ...active.map(r => (r.startedAt && ms(r.startedAt)) || startedMs));
        const horizonSeconds = Math.max(0, (dayEnd - startedMs) / 1000) + MARGIN_S;
        const fastest = Math.min(Infinity, ...active.map(r => r.cycleSeconds));
        const maxPerRow = Math.min(ROW_EVENTS_CEILING, Math.max(6, Math.ceil(((dayEnd - first) / 1000 + MARGIN_S) / fastest) + 2));
        const events = buildEvents(timers.rows, { startedAt: timers.startedAt, horizonSeconds, assumptions, levelUpSeconds, levelUpTarget: target, caps, maxPerRow });
        const harvests = new Map();   // row key -> today's collect, done and check-in events
        for (const e of events) {
            const at = Math.round(e.at), row = rows.get(e.key);
            if (e.kind === 'levelup') {
                if (at <= nowMs) add(`levelup:${target ?? ''}`, 'Level', target ? `Level up to RV ${target} now` : 'Level up now', at);
            } else if (!row || at < dayStart || at >= dayEnd) {
                continue;
            } else if (e.kind === 'water') {
                add(`water:${e.key}:${at}`, 'Water', `Water ${nice(row.item)} on ${row.facility}`, at, { approximate: !!e.approximate });
            } else {
                harvests.set(e.key, [...(harvests.get(e.key) || []), { at, kind: e.kind, approximate: !!e.approximate }]);
            }
        }
        for (const [key, list] of harvests) {
            const row = rows.get(key), crop = row.kind === 'crop', step = Math.ceil(list.length / MAX_ROW_ITEMS);
            for (const e of list.filter((_, i) => i % step === 0)) {
                add(`collect:${key}:${e.at}`, 'Collect', `${crop ? 'Harvest' : 'Collect'} ${nice(row.item)} from ${row.facility}${e.kind === 'checkin' ? ' (check-in)' : ''}`, e.at, { approximate: e.approximate });
                if (crop && !assumptions.plotsResow) add(`replant:${key}:${e.at}`, 'Replant', `Replant ${nice(row.item)} on ${row.facility}`, e.at);
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
