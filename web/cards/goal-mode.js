// Goal mode card: "reach RV N" or "have K of an item". On a click each goal is solved with the
// engine's level-up cost (ctx.solver.findPlan), one RV step after another, and the card says how
// long it takes and what to run. Logic in web/goal-mode.js; the card contract is in web/panels.js.
import {
    GOAL_KEY, atCurrentPlan, formatDays, goalItems, itemGoalInput, readGoal, rvSteps, shouldStop, startLevel, stepOutcome, unmakeable,
} from '../goal-mode.js?v=fork-m9-2';
import { summarizePlan } from '../plan-summary.js?v=fork-m9-2';

const PER_CLICK = 5; // RV steps solved per click
const TOP_ROWS = 4; // producing rows shown per step

export function mount(el, ctx) {
    ctx.addStylesheet('css/goal-mode.css');
    const { escape, number, perHour } = ctx.format;
    const label = name => (name === 'coins' ? 'Home Coins' : ctx.format.item(name));
    const maxRv = Number.isInteger(ctx.config.MAX_HOME_LEVEL) ? ctx.config.MAX_HOME_LEVEL : 20;
    let saved = { kind: 'rv' };
    try {
        saved = readGoal(localStorage.getItem(GOAL_KEY));
    } catch (err) {
        console.warn('Could not read the saved goal:', err);
    }
    el.innerHTML = `
        <h2>Goal mode</h2>
        <p class="hint">Pick a target and the planner works out which recipes reach it soonest, using the same level-up solve as the Level up strategy. Each solve can take a minute. For a plain Home Coins target, use Set a Goal above.</p>
        <div class="tabs" role="radiogroup" aria-label="Goal type">
            <label><input type="radio" name="goal-mode-kind" value="rv"> Reach RV</label>
            <label><input type="radio" name="goal-mode-kind" value="item"> Have items</label>
        </div>
        <div class="input-row goal-mode-row" id="goal-mode-rv-row">
            <div class="input-field">
                <label for="goal-mode-rv">Target RV level</label>
                <input type="number" id="goal-mode-rv" min="2" max="${maxRv}" step="1">
            </div>
            <label class="goal-mode-check" id="goal-mode-upgrades-row" title="Simple mode only: adds the coins to upgrade facilities to the levels each RV unlocks (costs from wikily.gg, not verified in game).">
                <input type="checkbox" id="goal-mode-upgrades"> Count facility upgrade costs
            </label>
        </div>
        <div class="input-row goal-mode-row" id="goal-mode-item-row">
            <div class="input-field">
                <label for="goal-mode-item">Item</label>
                <select id="goal-mode-item"><option value="">Loading items…</option></select>
            </div>
            <div class="input-field">
                <label for="goal-mode-amount">How many</label>
                <input type="number" id="goal-mode-amount" min="1" step="1" value="${escape(String(saved.amount ?? 100))}">
            </div>
            <div class="input-field">
                <label for="goal-mode-have">Already have</label>
                <input type="number" id="goal-mode-have" min="0" step="1" value="${escape(String(saved.have ?? 0))}">
            </div>
        </div>
        <div class="feature-actions">
            <button type="button" id="goal-mode-run" class="skip-add-btn">Work it out</button>
            <button type="button" id="goal-mode-stop" class="skip-add-btn" hidden>Stop</button>
            <button type="button" id="goal-mode-continue" class="skip-add-btn" hidden>Continue</button>
        </div>
        <p class="feature-status" id="goal-mode-status" role="status" aria-live="polite"></p>
        <div class="feature-scroll" id="goal-mode-results"></div>`;
    const $ = sel => el.querySelector(sel);
    const kindInputs = [...el.querySelectorAll('input[name="goal-mode-kind"]')];
    const rvInput = $('#goal-mode-rv');
    const upgradesInput = $('#goal-mode-upgrades');
    const itemSelect = $('#goal-mode-item');
    const amountInput = $('#goal-mode-amount');
    const haveInput = $('#goal-mode-have');
    const runBtn = $('#goal-mode-run');
    const stopBtn = $('#goal-mode-stop');
    const continueBtn = $('#goal-mode-continue');
    const statusEl = $('#goal-mode-status');
    const resultsEl = $('#goal-mode-results');

    kindInputs.forEach(input => { input.checked = input.value === saved.kind; });
    upgradesInput.checked = saved.countUpgrades;

    let current = null; // the latest 'plan' value
    let state = null; // the goal on screen (see startRv and startItem)
    let items = null; // the item list once loaded
    let recipes = null; // get_all_items' recipes once loaded
    let loading = null;
    let shownFrom = null; // the starting RV level the target input was last checked against

    const kind = () => (kindInputs.find(i => i.checked)?.value === 'item' ? 'item' : 'rv');
    const simpleOf = snap => (typeof snap?.context?.simple === 'boolean' ? snap.context.simple : ctx.isSimple());
    const simple = () => simpleOf(current);
    // The RV level the plan's setup is at (Advanced mode's RV input is hidden and may be stale).
    const fromLevel = (snap = current) => startLevel(snap?.input, {
        config: ctx.config, simple: simpleOf(snap), homeLevel: ctx.homeLevel(), context: snap?.context,
    });
    // No plan on screen counts as stale too: nothing to continue from.
    const isStale = () => !!state && (!current || current.setupHash !== state.snap.setupHash || current.setup !== state.snap.setup);
    // The skips the player made themselves when the plan was solved (see goalBase in ../goal-mode.js).
    const skippedOf = snap => (Array.isArray(snap?.context?.skipped) ? snap.context.skipped : []);
    const whole = (input, min) => {
        const n = Math.floor(Number(input.value));
        return Number.isFinite(n) && n >= min ? n : null;
    };

    function save() {
        try {
            localStorage.setItem(GOAL_KEY, JSON.stringify({
                kind: kind(), rv: whole(rvInput, 1), from: fromLevel(), item: itemSelect.value || saved.item || null,
                amount: whole(amountInput, 1), have: whole(haveInput, 0), countUpgrades: upgradesInput.checked,
            }));
        } catch (err) {
            console.warn('Could not save the goal:', err);
        }
    }

    function loadItems() {
        if (items || loading) return;
        loading = ctx.items().then((list) => {
            recipes = list;
            items = goalItems(list, label);
            itemSelect.innerHTML = items.map(o => `<option value="${escape(o.name)}">${escape(o.label)}</option>`).join('');
            if (saved.item && items.some(o => o.name === saved.item)) itemSelect.value = saved.item;
        }, (err) => {
            console.warn('Could not load the item list:', err);
            itemSelect.innerHTML = '<option value="">Items not loaded yet</option>';
        }).finally(() => {
            loading = null;
            render();
        });
    }

    // The recipes, for saying why a goal can't be made; null when they can't be loaded.
    async function recipeList() {
        if (!recipes) {
            try {
                recipes = await ctx.items();
            } catch (err) {
                console.warn('Could not load the recipes:', err);
            }
        }
        return recipes;
    }

    const moduleName = id => ctx.config.moduleNames?.[id] || label(id);
    const makerText = m => `${m.facility} Lv ${m.level}+${m.module ? ` with ${moduleName(m.module[0])} ${m.module[1]}` : ''}`;
    // "Rough Lumber (Wood Block from Woodland Lv 1+)": what the setup can't make, and what would.
    const missingText = missing => missing.slice(0, 3).map(({ item, needs }) => {
        const parts = needs.slice(0, 2).map((n) => {
            const makers = n.makers.length ? n.makers.slice(0, 2).map(makerText).join(' or ') : 'no recipe on the list';
            return n.item === item ? `made at ${makers}` : `${label(n.item)} from ${makers}`;
        });
        return `${label(item)}${parts.length ? ` (${parts.join('; ')})` : ''}`;
    }).join(', ');

    const chips = rows => (rows.length
        ? `<ul class="feature-chips">${rows.slice(0, TOP_ROWS).map(r => `<li>${escape(r.facility)} x${escape(String(r.count))}: ${escape(label(r.item))}</li>`).join('')}</ul>`
        : '');
    const slowestText = o => (o.slowest ? `${escape(label(o.slowest.name))} (${escape(formatDays(o.slowest.seconds))})` : '–');

    function problemText(o, what, simpleMode) {
        if (o.status === 'unreachable') {
            const fix = simpleMode ? 'Check the recipes you skipped.' : 'Add the facility that makes it, or use Simple mode.';
            const named = o.missing?.length ? escape(missingText(o.missing)) : what;
            return `This setup can't make ${named}. ${fix}`;
        }
        if (o.status === 'rejected') return `The planner did not take this goal${o.reason ? ` (${escape(o.reason)})` : ''}.`;
        if (o.status === 'failed') return `The planner failed: ${escape(o.error)}.`;
        if (o.status === 'skipped') return 'Skipped.';
        return '';
    }

    function renderRv(s) {
        const done = s.steps.slice(0, s.next);
        const body = done.map((step, i) => {
            const o = s.results[i];
            const ok = o.status === 'ok';
            const what = `everything RV ${step.rv} costs`;
            const note = [o.ready ? 'your stock already covers it' : '', step.note].filter(Boolean).join('; ');
            return `<tr${ok ? '' : ' class="goal-mode-bad"'}>
                <td>RV ${escape(String(step.rv))}${note ? `<span class="goal-mode-note">${escape(note)}</span>` : ''}</td>
                <td class="goal-mode-num">${ok ? escape(formatDays(o.seconds)) : '–'}</td>
                <td>${ok ? slowestText(o) : '–'}</td>
                <td>${ok ? chips(o.rows) : problemText(o, what, simpleOf(s.snap))}</td>
            </tr>`;
        }).join('');
        const oks = done.map((_, i) => s.results[i]).filter(o => o.status === 'ok');
        const total = oks.reduce((sum, o) => sum + (Number.isFinite(o.seconds) ? o.seconds : 0), 0);
        const all = s.next === s.steps.length && oks.length === s.steps.length;
        const lastRv = s.steps[s.steps.length - 1]?.rv;
        const totalText = !oks.length ? ''
            : all ? `RV ${escape(String(s.from))} to RV ${escape(String(lastRv))}: ${escape(formatDays(total))} in all.`
                : s.next < s.steps.length ? `Worked out so far: ${escape(formatDays(total))} for ${oks.length} of ${s.steps.length} steps.`
                    : `${escape(formatDays(total))} for ${oks.length} of ${s.steps.length} steps; the rest could not be worked out.`;
        const stocked = (s.steps.find(step => step.input)?.input.level_up.stock || []).length > 0;
        resultsEl.innerHTML = done.length ? `<table class="goal-mode-table">
            <thead><tr><th>Step</th><th class="goal-mode-num">Time</th><th>Slowest part</th><th>Run</th></tr></thead>
            <tbody>${body}</tbody>
        </table>${totalText ? `<p class="goal-mode-total">${totalText}</p>` : ''}
        <p class="hint small">Each step starts once the RV before it is reached, from nothing saved${stocked ? ' (your stock counts toward the first)' : ''}. Times are steady running, without each recipe's first wait.</p>` : '';
    }

    function renderItem(s) {
        const name = escape(label(s.item));
        const est = s.estimate;
        const lines = [];
        if (est.seconds === 0) {
            lines.push(`<p class="goal-mode-total">You already have ${escape(number(s.amount))} ${name}: ready now.</p>`);
        } else if (est.seconds === null) {
            lines.push(`<p>At your current plan: it does not sell any ${name}, so there is no quick estimate.</p>`);
        } else {
            const wait = est.lead > 0 ? `, the first after ${escape(ctx.format.duration(est.lead))}` : '';
            lines.push(`<p>At your current plan: ${escape(formatDays(est.seconds))} (it sells ${escape(perHour(est.perSecond))} an hour${wait}), if you keep them instead of selling.</p>`);
        }
        const o = s.outcome;
        if (o && o.status === 'ok' && !o.ready) {
            const now = Number.isFinite(s.nowPerHour) ? ` (the plan on screen: ${escape(number(Math.round(s.nowPerHour)))})` : '';
            const earns = Number.isFinite(s.coinsPerHour)
                ? `<p>Meanwhile it earns ${escape(number(Math.round(s.coinsPerHour)))} Home Coins an hour${now}. Run:</p>` : '';
            lines.push(`<p class="goal-mode-total">Planned for it: ${escape(formatDays(o.seconds))}.</p>`, earns, chips(o.rows));
        } else if (o && o.status !== 'ok') {
            const keep = est.seconds ? ' The estimate above still stands.' : '';
            lines.push(`<p class="goal-mode-bad">${problemText(o, name, simpleOf(s.snap))}${keep}</p>`);
        }
        resultsEl.innerHTML = lines.join('');
    }

    function statusText() {
        if (!current) return 'Solve a plan first.';
        const parts = [];
        if (isStale()) parts.push(state.stopped ? 'Setup changed; work it out again. (stopped)' : 'Setup changed; work it out again.');
        if (state?.running) {
            parts.push(state.kind === 'rv' ? `Working out RV ${state.working} (step ${state.next + 1} of ${state.steps.length})…` : `Planning for ${label(state.item)}…`);
        } else if (state?.ended) {
            parts.push(state.ended);
        } else if (state?.kind === 'rv' && state.next < state.steps.length) {
            parts.push(`Worked out ${state.next} of ${state.steps.length} steps.`);
        } else if (!state && kind() === 'rv' && fromLevel() >= maxRv) {
            parts.push(`RV ${maxRv} is the top level.`);
        }
        return parts.join(' ');
    }

    function render() {
        const k = kind();
        const running = !!state?.running;
        $('#goal-mode-rv-row').hidden = k !== 'rv';
        $('#goal-mode-item-row').hidden = k !== 'item';
        $('#goal-mode-upgrades-row').hidden = !simple();
        const from = fromLevel();
        rvInput.min = String(Math.min(maxRv, from + 1));
        // The target starts one above the starting level, or at the one picked last time from the
        // same level; a new starting level moves a target that is no longer above it.
        if (shownFrom === null || rvInput.value === '') {
            const remembered = saved.from === from && saved.rv > from ? saved.rv : null;
            rvInput.value = String(Math.min(maxRv, remembered || from + 1));
        } else if (from !== shownFrom && !(Number(rvInput.value) > from)) {
            rvInput.value = String(Math.min(maxRv, from + 1));
        }
        shownFrom = from;
        runBtn.disabled = running || !current || (k === 'item' && !items);
        stopBtn.hidden = !running;
        const left = state?.kind === 'rv' && !running && !state.blocked && !isStale() ? state.steps.length - state.next : 0;
        continueBtn.hidden = left <= 0;
        continueBtn.textContent = `Continue (${left} more step${left === 1 ? '' : 's'})`;
        el.classList.toggle('goal-mode-stale', isStale());
        statusEl.textContent = statusText();
        if (!state) resultsEl.innerHTML = '';
        else if (state.kind === 'rv') renderRv(state);
        else renderItem(state);
    }

    const endedText = (err, what) => (err?.message === 'cancelled' ? 'Stopped.'
        : err?.message === 'timed out' ? `Timed out on ${what}.` : `The planner could not run: ${err?.message || err}.`);

    async function runRv(s) {
        s.running = true;
        s.stopped = false;
        s.ended = null;
        s.controller = new AbortController();
        let solved = 0;
        while (s.next < s.steps.length && solved < PER_CLICK) {
            const step = s.steps[s.next];
            if (!step.input || step.ready) {
                s.results[s.next] = step.input ? { status: 'ok', seconds: 0, slowest: null, rows: [], ready: true } : { status: 'skipped' };
                s.next++;
                continue;
            }
            s.working = step.rv;
            if (state === s) render();
            let plan;
            try {
                plan = await ctx.solver.findPlan(step.input, { signal: s.controller.signal });
            } catch (err) {
                s.ended = endedText(err, `RV ${step.rv}`);
                break;
            }
            solved++;
            const costNames = step.input.level_up.cost.map(([n]) => n);
            const outcome = stepOutcome(plan, costNames);
            if (outcome.status === 'unreachable') {
                const list = await recipeList();
                if (list) outcome.missing = unmakeable(costNames, list, step.input);
            }
            s.results[s.next] = outcome;
            s.next++;
            if (outcome.status !== 'ok') {
                s.blocked = true;
                // Only when there were steps after it: the table row already says what went wrong.
                if (s.next < s.steps.length) s.ended = `Stopped at RV ${step.rv}: the steps after it were not worked out.`;
                break;
            }
        }
        s.running = false;
        s.controller = null;
        if (state === s) render();
    }

    function startRv(snap) {
        const from = fromLevel(snap);
        const to = whole(rvInput, 1);
        if (!to || to <= from || to > maxRv) {
            statusEl.textContent = `Pick an RV level from ${from + 1} to ${maxRv}.`;
            return;
        }
        const steps = rvSteps(snap.input, {
            from, to, config: ctx.config, simple: simpleOf(snap), countUpgrades: upgradesInput.checked, skipped: skippedOf(snap),
        });
        state = { kind: 'rv', snap, from, steps, results: [], next: 0, running: false, blocked: false, ended: null };
        runRv(state);
    }

    async function startItem(snap) {
        const item = itemSelect.value;
        const amount = whole(amountInput, 1);
        const have = whole(haveInput, 0) || 0;
        if (!item || !amount) {
            statusEl.textContent = 'Pick an item and how many you want.';
            return;
        }
        const s = { kind: 'item', snap, item, amount, have, estimate: atCurrentPlan(snap.plan, item, amount, have), outcome: null };
        s.nowPerHour = summarizePlan(snap.plan).coinsPerHour;
        state = s;
        if (have >= amount) {
            s.outcome = { status: 'ok', seconds: 0, slowest: null, rows: [], ready: true };
            render();
            return;
        }
        s.running = true;
        s.controller = new AbortController();
        render();
        try {
            const input = itemGoalInput(snap.input, item, amount, have, { tiers: ctx.config.ANIIPOD_TIERS, skipped: skippedOf(snap) });
            const plan = await ctx.solver.findPlan(input, { signal: s.controller.signal });
            s.outcome = stepOutcome(plan, [item]);
            if (s.outcome.status === 'unreachable') {
                const list = await recipeList();
                if (list) s.outcome.missing = unmakeable([item], list, input);
            }
            s.coinsPerHour = summarizePlan(plan).coinsPerHour;
        } catch (err) {
            s.ended = endedText(err, label(item));
        }
        s.running = false;
        s.controller = null;
        if (state === s) render();
    }

    runBtn.addEventListener('click', () => {
        const snap = ctx.last('plan');
        if (!snap?.input || state?.running) {
            render();
            return;
        }
        current = snap;
        save();
        if (kind() === 'rv') startRv(snap);
        else startItem(snap);
    });
    stopBtn.addEventListener('click', () => state?.controller?.abort());
    continueBtn.addEventListener('click', () => {
        if (state?.kind === 'rv' && !state.running && !state.blocked && !isStale()) runRv(state);
    });
    kindInputs.forEach(input => input.addEventListener('change', () => {
        if (kind() === 'item') loadItems();
        save();
        render();
    }));
    [rvInput, upgradesInput, itemSelect, amountInput, haveInput].forEach(input => input.addEventListener('change', save));

    if (kind() === 'item') loadItems();
    // A new plan never starts a solve; the results only say when they no longer match. A solve still
    // running stops when no plan is on screen or the inputs were solved again: its Stop button is
    // dimmed then, and it would hold a solver slot. The steps worked out so far stay on screen.
    ctx.on('plan', (value) => {
        current = value || null;
        if (state?.controller && shouldStop(!!state.running, state.snap, current)) {
            state.stopped = true;
            state.controller.abort();
        }
        if (kind() === 'item') loadItems();
        render();
    });
}
