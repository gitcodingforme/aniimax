// Daily checklist card: today's play session as one tick list, built from the running reminders and
// the plan. All decisions (what is on the list, what is overdue, how ticks are kept per day) are in
// ../daily.js and tested in tests/daily.test.mjs; this file only draws it. See web/panels.js for the
// card contract.
import {
    DAILY_KEY, allDone, dailyItems, dayKey, doneCount, groupItems, prune, readState, snapshotNote, staleTimersNote, tickAll, timeLabel, toggle, untickDay, writeState,
} from '../daily.js?v=fork-m10-1';

// The list is rebuilt this often so lines turn overdue by themselves while the page stays open.
const REFRESH_MS = 60 * 1000;

export async function mount(el, ctx) {
    ctx.addStylesheet('css/daily.css');
    const esc = ctx.format.escape;
    el.innerHTML = `
        <div class="card-head">
            <h2>Daily checklist</h2>
            <div class="config-actions">
                <button type="button" id="daily-all-btn" class="toggle-button small" title="Ticks everything on today's list and saves a snapshot to your history.">I did all this</button>
                <button type="button" id="daily-none-btn" class="toggle-button small">Untick today</button>
            </div>
        </div>
        <p class="hint">Today's play session in one list. Unlike the Setup checklist above, which resets when the plan changes, these ticks start fresh every day.</p>
        <p id="daily-stale" class="daily-warning" role="status" aria-live="polite" hidden></p>
        <p id="daily-note" class="hint" role="status" aria-live="polite"></p>
        <p id="daily-count" class="feature-status" role="status" aria-live="polite"></p>
        <div id="daily-groups"></div>
        <p id="daily-status" class="feature-status" role="status" aria-live="polite"></p>`;
    const stale = el.querySelector('#daily-stale');
    const note = el.querySelector('#daily-note');
    const count = el.querySelector('#daily-count');
    const groupsEl = el.querySelector('#daily-groups');
    const status = el.querySelector('#daily-status');
    const allBtn = el.querySelector('#daily-all-btn');
    const noneBtn = el.querySelector('#daily-none-btn');

    function load() {
        try {
            return readState(localStorage.getItem(DAILY_KEY));
        } catch (err) {
            console.warn('Could not read the daily checklist from localStorage:', err);
            return readState(null);
        }
    }

    function save() {
        try {
            localStorage.setItem(DAILY_KEY, writeState(prune(state)));
        } catch (err) {
            console.warn('Could not save the daily checklist to localStorage:', err);
        }
    }

    let state = load();
    let current = { day: dayKey(), items: [] };   // what is on screen, for the buttons
    let shownHtml = null;

    function render() {
        const now = Date.now();
        const day = dayKey(now);
        const topic = ctx.last('plan');
        const timers = ctx.getTimers();
        const entry = state.days[day];
        const ticked = entry?.ticked || [];
        let items = [];
        try {
            items = dailyItems({
                timers, settings: ctx.getReminderSettings(), plan: topic?.plan ?? null, context: topic?.context ?? null,
                now, caps: ctx.config.OUTPUT_CAPS, ticked, name: ctx.format.item,
            });
        } catch (err) {
            console.warn('The daily checklist could not build its list:', err);
            status.textContent = 'Could not build today\'s list from the reminders and the plan.';
        }
        current = { day, items };
        // Timers started from another plan than the one on screen still run, but may not match what is built.
        let warning = '';
        try {
            warning = staleTimersNote(timers, topic);
        } catch (err) {
            console.warn('The daily checklist could not compare the timers with the plan:', err);
        }
        stale.textContent = warning;
        stale.hidden = !warning;
        const ids = items.map(i => i.id);

        let n = 0;
        const html = groupItems(items).map(({ group, items: list }) => `<h3 class="daily-group">${group}</h3>` + list.map(item => {
            const box = `daily-${n++}`;
            const on = ticked.includes(item.id);
            const late = item.overdue ? ` <span class="daily-late">overdue ${esc(ctx.format.duration((now - item.at) / 1000))}</span>` : '';
            const when = item.at === null ? '' : `<span class="daily-when">${item.approximate ? '~' : ''}${esc(timeLabel(item.at, now))}</span> `;
            return `<div class="daily-item${on ? ' done' : ''}${item.overdue ? ' overdue' : ''}">`
                + `<input type="checkbox" id="${box}" data-id="${esc(item.id)}"${on ? ' checked' : ''}> `
                + `<label for="${box}">${when}<span class="daily-title">${esc(item.title)}</span>${late}</label></div>`;
        }).join('')).join('');
        if (html !== shownHtml) {
            const focused = groupsEl.querySelector?.('input:focus')?.dataset?.id;
            groupsEl.innerHTML = html;
            shownHtml = html;
            if (focused !== undefined) [...groupsEl.querySelectorAll('input[data-id]')].find(box => box.dataset.id === focused)?.focus();
        }

        const started = timers ? Date.parse(timers.startedAt) : NaN;
        if (items.length === 0) note.textContent = timers ? 'Nothing is due for the rest of today.' : 'Solve a plan to get a list for today.';
        else if (!timers) note.textContent = 'No reminders are running, so these lines have no times. Press "I just set everything up per the plan" in Reminders to get them.';
        else note.textContent = `Times come from your reminders (set up: ${timeLabel(started, now)}). A ~ means the moment is approximate.`;

        const overdue = items.filter(i => i.overdue).length;
        count.textContent = items.length === 0 ? '' : `${doneCount(state, day, ids)} of ${items.length} done`
            + (overdue ? `, ${overdue} overdue` : '') + (entry?.doneAt ? `. You marked it all done at ${timeLabel(entry.doneAt, now)}.` : '');
        allBtn.disabled = items.length === 0 || (allDone(state, day, ids) && !!entry?.doneAt);
        noneBtn.disabled = !entry || (entry.ticked.length === 0 && !entry.doneAt);
    }

    groupsEl.addEventListener('change', event => {
        const id = event.target?.dataset?.id;
        if (id === undefined) return;
        state = toggle(state, current.day, id, event.target.checked);
        save();
        status.textContent = '';
        render();
    });

    allBtn.addEventListener('click', () => {
        const { day, items } = current;
        if (items.length === 0) return;
        const ids = items.map(i => i.id);
        state = tickAll(state, day, ids, new Date().toISOString());
        save();
        const text = snapshotNote(day, doneCount(state, day, ids), ids.length);
        let snapshot = null;
        try {
            snapshot = ctx.saveSnapshot(text);
        } catch (err) {
            console.warn('The daily checklist could not save a snapshot:', err);
        }
        status.textContent = snapshot ? `Everything ticked, and a snapshot was saved: "${text}".` : 'Everything ticked, but the snapshot could not be saved.';
        render();
    });

    noneBtn.addEventListener('click', () => {
        state = untickDay(state, current.day);
        save();
        status.textContent = 'Today\'s ticks were cleared.';
        render();
    });

    ctx.on('timers', () => render());
    ctx.on('plan', () => render());
    setInterval(render, REFRESH_MS);
}
