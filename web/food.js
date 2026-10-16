// Worker food: how long the food bowl lasts and the reminder to refill it. Pure functions only (no
// DOM, no storage); tested in tests/food.test.mjs. reminders.js adds the event to the plan's
// reminders and daily.js puts it in the checklist.
//
// Where the numbers come from (docs/research/worker-food.md in the workspace): fan sites say every
// working Aniimo eats from one shared bowl at 10 food energy a minute (600 an hour). That rate is
// from the closed beta and nobody has measured it in the released game, so everything here is an
// estimate (INFERRED, medium-low confidence) and the event says so. No food cost is subtracted
// from the plan: the likely upkeep is about 1% of income, inside the plan's own error.

// Food energy one working Aniimo eats a minute.
export const FOOD_RATE_PER_MINUTE = 10;
export const FEED_TITLE = 'Refill the food bowl';
// Shown on the Reminders card when the player says their workers are not kept fed.
export const FOOD_NOTE = 'The plan assumes your workers stay fed; no food cost is subtracted';

const isPositive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

// How many Aniimo the roster has: the sum of each card's `count` (a card with no count is one
// Aniimo). 0 when there is no roster.
export function rosterSize(roster) {
    let total = 0;
    for (const card of Array.isArray(roster) ? roster : []) {
        if (!card || typeof card !== 'object') continue;
        const count = card.count === undefined ? 1 : Number(card.count);
        if (Number.isFinite(count) && count > 0) total += Math.floor(count);
    }
    return total;
}

// How many Aniimo are working under the plan, to know how fast the bowl empties. `rows` are the
// reminders' rows (planRows in reminders.js, or the copy saved with the timers). Each unit of a
// crop or gathering row keeps one Aniimo (a gatherer's stays all day); a processor's units share
// Aniimo, so it counts only the units busy on average (`busy`, the plan's busy_units), as the
// Aniimo Team card does. Rows the player switched off (`on: false`) and rows that run on
// generator power with no Aniimo (`electric`) are left out. With the player's own Aniimo (the
// "My Aniimo" tab, `tab === 'custom'`, or a `setup` named "roster:...") nobody can work more
// than the roster has, so its size is the ceiling. Whole Aniimo, rounded up: a bowl that seems
// to empty early is the safer mistake. An estimate: it assumes one Aniimo per staffed unit.
export function workingAniimo(rows, { setup = null, tab = null, roster = null } = {}) {
    let staffed = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row !== 'object' || row.on === false || row.electric === true) continue;
        const busy = Number(row.busy), count = Number(row.count);
        const units = row.kind === 'processor' && busy > 0 ? busy : count > 0 ? count : busy;
        if (Number.isFinite(units) && units > 0) staffed += units;
    }
    const workers = Math.max(0, Math.ceil(staffed - 1e-9));   // max() also turns -0 into 0
    const ownRoster = tab === 'custom' || (typeof setup === 'string' && setup.startsWith('roster:'));
    const size = ownRoster ? rosterSize(roster) : 0;
    return size > 0 ? Math.min(workers, size) : workers;
}

// Hours a bowl with `energy` food energy lasts when `workers` Aniimo each eat `ratePerMinute` a
// minute. Null when the energy, the number of workers or the rate is not a positive number.
export function foodHours(energy, workers, ratePerMinute = FOOD_RATE_PER_MINUTE) {
    if (!isPositive(energy) || !isPositive(workers) || !isPositive(ratePerMinute)) return null;
    return energy / (ratePerMinute * workers) / 60;
}

// A time span in hours as text, in the style of the reminders: "45m", "3h 20m", "1h 05m".
export function foodDuration(hours) {
    if (!isPositive(hours)) return '';
    const total = Math.max(1, Math.round(hours * 60));
    const h = Math.floor(total / 60), m = total % 60;
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

// The reminder to refill the bowl `hours` after `now` (ms, or anything Date.parse reads), which is
// the moment the energy was counted (setup). The text is read when the reminder fires, so it says how
// long the bowl lasts from setup, not "from now". The
// same shape as the events buildEvents makes: { at, kind, key, title, body, approximate }.
// Null when there is no usable time or span.
export function feedEvent(now, hours) {
    const start = typeof now === 'number' ? now : now instanceof Date ? now.getTime() : Date.parse(now);
    if (!Number.isFinite(start) || !isPositive(hours)) return null;
    return {
        at: start + hours * 3600 * 1000, kind: 'feed', key: 'food', approximate: true,
        title: FEED_TITLE,
        body: `The bowl should be about empty (it lasts about ${foodDuration(hours)} from setup); estimate from fan data (${FOOD_RATE_PER_MINUTE} food energy per minute per working Aniimo)`,
    };
}
