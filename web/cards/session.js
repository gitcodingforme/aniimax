// Session planner card: "I have 40 minutes tonight" or "overnight, 8 hours". On a click the plan
// is solved again without the recipes that do not suit the window and shown next to the current
// one. The decisions live in ../session.js (tested in tests/session.test.mjs); this file draws
// them. The card contract is in web/panels.js.

import {
    SESSION_KEY, adaptPlan, aimInput, firstCollectBy, levelUpLosses, readSettings, rowRates, shouldStop, unknownCapRows, windowCoins,
    windowSecondsFor, writeSettings,
} from '../session.js?v=fork-m10-1';
import { planRows } from '../reminders.js?v=fork-m10-1';
import { diffPlans, stripVariant, summarizePlan } from '../plan-summary.js?v=fork-m10-1';

const MAX_ROUNDS = 3;

export function mount(el, ctx) {
    ctx.addStylesheet('css/session.css');
    const { escape, number, duration, item } = ctx.format;
    el.innerHTML = `
        <h2>Session planner</h2>
        <p class="hint">Plan for the time you have. A session keeps only recipes whose batches finish before you stop. Overnight leaves out anything whose output store fills before morning, so nothing sits full while you sleep. Store sizes come from fan wikis and are not checked in game.</p>
        <fieldset class="session-modes">
            <legend>How long</legend>
            <label class="session-mode"><input type="radio" name="session-mode" value="session"> Session</label>
            <label class="session-length"><input type="number" id="session-minutes" min="1" max="720" step="1" inputmode="numeric"> minutes</label>
            <label class="session-mode"><input type="radio" name="session-mode" value="overnight"> Overnight</label>
            <label class="session-length"><input type="number" id="session-hours" min="1" max="24" step="0.5" inputmode="decimal"> hours</label>
        </fieldset>
        <label class="session-aim">Aim for
            <select id="session-aim">
                <option value="strategy">my strategy</option>
                <option value="coins">Home Coins only</option>
            </select>
        </label>
        <div class="feature-actions">
            <button type="button" id="session-run" class="skip-add-btn">Plan it</button>
            <button type="button" id="session-stop" class="skip-add-btn" hidden>Stop</button>
        </div>
        <p class="feature-status" id="session-status" role="status" aria-live="polite"></p>
        <div id="session-result"></div>`;
    const radios = [...el.querySelectorAll('input[name="session-mode"]')];
    const minutesEl = el.querySelector('#session-minutes');
    const hoursEl = el.querySelector('#session-hours');
    const aimEl = el.querySelector('#session-aim');
    const runBtn = el.querySelector('#session-run');
    const stopBtn = el.querySelector('#session-stop');
    const statusEl = el.querySelector('#session-status');
    const resultEl = el.querySelector('#session-result');

    function load() {
        try {
            return readSettings(localStorage.getItem(SESSION_KEY));
        } catch (err) {
            console.warn('Could not read the session planner settings from localStorage:', err);
            return readSettings(null);
        }
    }

    function save() {
        try {
            localStorage.setItem(SESSION_KEY, writeSettings(settings));
        } catch (err) {
            console.warn('Could not save the session planner settings to localStorage:', err);
        }
    }

    let settings = load();
    let current = null; // the latest 'plan' value
    // The run on screen: { snap, mode, windowSeconds, aim, recipes, facilities, caps, running,
    // controller, round, result (adaptPlan's answer), coins: { now, adapted }, error, stopped (a new
    // plan stopped the run) }.
    let state = null;

    function showSettings() {
        radios.forEach(r => { r.checked = r.value === settings.mode; });
        minutesEl.value = String(settings.minutes);
        hoursEl.value = String(settings.hours);
        el.classList.toggle('session-overnight', settings.mode === 'overnight');
    }

    function readInputs() {
        const mode = radios.find(r => r.checked)?.value || settings.mode;
        settings = readSettings(JSON.stringify({ mode, minutes: minutesEl.value, hours: hoursEl.value }));
    }

    const isStale = () => !!state && !(current && current.setupHash === state.snap.setupHash && current.setup === state.snap.setup);
    const name = n => escape(item(stripVariant(n)));
    const coinsText = n => (Number.isFinite(n) ? escape(number(Math.round(n))) : '–');
    const windowTitle = s => (s.mode === 'session' ? `For a ${duration(s.windowSeconds)} session` : `Overnight (${duration(s.windowSeconds)})`);

    function delta(now, then, { lowerIsBetter = false } = {}) {
        if (!Number.isFinite(now) || !Number.isFinite(then) || then === 0 || now === then) return '';
        const pct = Math.round((now - then) / Math.abs(then) * 100);
        if (pct === 0) return '';
        const good = lowerIsBetter ? pct < 0 : pct > 0;
        return ` <span class="${good ? 'delta-up' : 'delta-down'}">${pct > 0 ? '+' : '−'}${Math.abs(pct)}%</span>`;
    }

    // Why the window figure is under steady income times the window, when it is: in a session the
    // engine counts the wait for first batches; overnight, stores that fill stop until collected.
    function gapNote(facts) {
        const steady = facts.coinsPerHour / 3600 * state.windowSeconds;
        if (!Number.isFinite(facts.windowCoins) || !(steady > 0) || facts.windowCoins >= steady * 0.99) return '';
        const why = state.mode === 'session'
            ? 'lower than steady income because the first batches take a while to arrive'
            : 'lower than steady income because some stores fill and stop until collected';
        return `<span class="session-note">${why}</span>`;
    }

    function chips(names) {
        const once = [...new Set(names.map(stripVariant))];
        return `<ul class="feature-chips">${once.map(n => `<li>${name(n)}</li>`).join('')}</ul>`;
    }

    function collectText(first) {
        if (!first) return 'no store size known';
        return `after ${escape(duration(first.fillSeconds))} <span class="session-note">${name(first.item)}, ${escape(first.facility)}</span>`;
    }

    // One column of the comparison: a plan's facts, with deltas against `other` when given.
    function column(title, facts, other = null) {
        const lines = [
            ['Steady income', Number.isFinite(facts.coinsPerHour) ? `${coinsText(facts.coinsPerHour)} coins/h${other ? delta(facts.coinsPerHour, other.coinsPerHour) : ''}` : '–'],
            [state.mode === 'session' ? `Coins in ${escape(duration(state.windowSeconds))}` : `Coins by morning`,
                facts.windowCoins === undefined ? 'working out…' : `${Number.isFinite(facts.windowCoins) ? '~' : ''}${coinsText(facts.windowCoins)}${other ? delta(facts.windowCoins, other.windowCoins) : ''}${gapNote(facts)}`],
            ['First store full', collectText(facts.first)],
        ];
        if (facts.showLevelUp) {
            lines.push(['Level-up covered in', Number.isFinite(facts.levelUpSeconds)
                ? `${escape(duration(facts.levelUpSeconds))}${other ? delta(facts.levelUpSeconds, other.levelUpSeconds, { lowerIsBetter: true }) : ''}`
                : 'not covered']);
        }
        const unknown = facts.unknown.length
            ? `<p class="session-sub">Never fills (cap unknown):</p>${chips(facts.unknown.map(r => r.item))}`
            : '';
        return `<div class="session-col">
            <h3>${escape(title)}</h3>
            <dl class="session-facts">${lines.map(([dt, dd]) => `<dt>${dt}</dt><dd>${dd}</dd>`).join('')}</dl>
            ${facts.extra || ''}${unknown}
        </div>`;
    }

    function factsFor(plan, coins, showLevelUp) {
        const summary = summarizePlan(plan);
        const rows = planRows(plan, { recipes: state.recipes, facilities: state.facilities });
        return {
            coinsPerHour: summary.coinsPerHour,
            windowCoins: coins,
            first: firstCollectBy(rows, state.caps, state.assumptions),
            levelUpSeconds: summary.levelUpSeconds,
            showLevelUp,
            unknown: unknownCapRows(rows, state.caps, state.assumptions),
        };
    }

    function diffTable(changes) {
        if (changes.length === 0) return '<p class="session-sub">Same facilities as the current plan.</p>';
        const body = changes.map(c => `<tr>
            <td>${escape(c.facility)}</td><td>${name(c.item)}</td>
            <td class="session-num">${escape(number(c.before))}</td><td class="session-num">${escape(number(c.after))}</td>
        </tr>`).join('');
        return `<div class="feature-scroll"><table class="session-diff">
            <thead><tr><th>Facility</th><th>Makes</th><th class="session-num">Now</th><th class="session-num">Adapted</th></tr></thead>
            <tbody>${body}</tbody>
        </table></div>`;
    }

    function warnings(s, result) {
        const list = [];
        const nowPlan = s.snap.plan;
        if (!Array.isArray(s.recipes) || s.recipes.length === 0) {
            list.push('The recipe list has not loaded yet, so batch sizes are unknown and every row counts as never filling.');
        }
        if (s.aim === 'coins') list.push('Solved for Home Coins only: your strategy\'s priorities and level-up are set aside.');
        if (result?.plan && !result.complete && result.remaining.length) {
            const what = s.mode === 'session' ? 'batches longer than the window' : 'stores that fill before morning';
            list.push(`After ${result.rounds} re-solves the plan still has ${what}: ${result.remaining.map(name).join(', ')}.`);
        }
        if (s.aim === 'strategy' && result?.excluded?.length && nowPlan?.level_up) {
            const plans = [nowPlan, result.plan].filter(Boolean);
            const lost = [...new Set(plans.flatMap(p => levelUpLosses(p, result.excluded, s.recipes)))];
            if (lost.length) list.push(`The level-up needs ${lost.map(name).join(', ')} (directly or as an ingredient), which this plan leaves out.`);
            const before = summarizePlan(nowPlan).levelUpSeconds;
            if (result.plan && Number.isFinite(before) && summarizePlan(result.plan).levelUpSeconds === null) {
                list.push('The adapted plan never covers the level-up.');
            }
        }
        if (s.mode === 'overnight' && result?.plan) {
            const prorated = rowRates(result.plan, planRows(result.plan, { recipes: s.recipes, facilities: s.facilities })).prorated;
            list.push(`Coins by morning is an estimate: each row earns its share of the income until its store is full${prorated ? ' (split evenly between rows, since this plan lists no per-product income)' : ''}, then stops until collected.`);
        }
        return list.map(w => `<p class="session-warning">${w}</p>`).join('');
    }

    function renderResult() {
        const s = state;
        const result = s?.result;
        if (!result) {
            resultEl.innerHTML = '';
            return;
        }
        if (!result.plan) {
            const left = result.excluded.length ? `<p class="session-sub">Left out before giving up:</p>${chips(result.excluded)}` : '';
            resultEl.innerHTML = `<p class="session-warning">No plan fits this window. ${escape(result.error || '')}</p>${left}${warnings(s, result)}`;
            return;
        }
        const showLevelUp = !!(s.snap.plan?.level_up || result.plan.level_up);
        const now = factsFor(s.snap.plan, s.coins.now, showLevelUp);
        const adapted = factsFor(result.plan, s.coins.adapted, showLevelUp);
        adapted.extra = result.excluded.length
            ? `<p class="session-sub">Left out:</p>${chips(result.excluded)}`
            : `<p class="session-sub">${s.aim === 'coins' ? 'Nothing left out: the Home Coins plan already fits.' : 'Nothing left out: the current plan already fits.'}</p>`;
        resultEl.innerHTML = `
            <div class="feature-compare session-compare">
                ${column('Current plan', now)}
                ${column(windowTitle(s), adapted, now)}
            </div>
            <h3 class="session-heading">Facility differences</h3>
            ${diffTable(diffPlans(s.snap.plan, result.plan))}
            ${warnings(s, result)}`;
    }

    function statusText() {
        if (!current?.plan?.success) return 'Solve a plan first.';
        if (!state) return `Pick a length and press Plan it. The plan is solved again up to ${MAX_ROUNDS} times, so this can take a minute.`;
        const parts = [];
        if (isStale()) parts.push(state.stopped ? 'Setup changed; plan it again. (stopped)' : 'Setup changed; plan it again.');
        if (state.running) {
            parts.push(state.result ? 'Working out the coins in the window…' : state.round
                ? `Solving again without ${state.round.excluded.length} recipe${state.round.excluded.length === 1 ? '' : 's'} (try ${state.round.n} of ${MAX_ROUNDS})…`
                : 'Solving…');
        } else if (state.error) {
            parts.push(state.error);
        } else if (state.result) {
            const r = state.result;
            const left = `${r.excluded.length} recipe${r.excluded.length === 1 ? '' : 's'} left out`;
            if (!r.plan) parts.push(`Gave up with ${left}.`);
            else if (r.rounds === 0) parts.push(state.aim === 'coins' ? 'Solved for Home Coins only; it already fits this window.' : 'The current plan already fits this window.');
            else parts.push(`Solved again ${r.rounds} time${r.rounds === 1 ? '' : 's'}; ${left}.`);
        }
        return parts.join(' ');
    }

    function render() {
        const running = !!state?.running;
        runBtn.disabled = running || !current?.plan?.success || !current?.input;
        stopBtn.hidden = !running;
        el.classList.toggle('session-stale', isStale());
        statusEl.textContent = statusText();
        renderResult();
    }

    // The reminders' switches (which rows keep working by themselves), as the Reminders card set them.
    function reminderAssumptions() {
        try {
            return ctx.getReminderSettings()?.assumptions || null;
        } catch (err) {
            console.warn('Could not read the reminder settings:', err);
            return null;
        }
    }

    async function coinsInWindow(s) {
        const adapted = s.result.plan;
        if (s.mode === 'overnight') {
            const coins = p => windowCoins(p, planRows(p, { recipes: s.recipes, facilities: s.facilities }), s.caps, s.windowSeconds, s.assumptions);
            return { now: coins(s.snap.plan), adapted: coins(adapted) };
        }
        const over = p => ctx.solver.timeOver(p, s.windowSeconds)
            .then(goal => (goal?.success ? goal.amount_produced : null), () => null);
        const nowCoins = over(s.snap.plan);
        const adaptedCoins = adapted === s.snap.plan ? nowCoins : over(adapted);
        return { now: await nowCoins, adapted: await adaptedCoins };
    }

    async function run() {
        const snap = ctx.last('plan');
        if (!snap?.plan?.success || !snap.input || state?.running) {
            render();
            return;
        }
        readInputs();
        save();
        showSettings();
        const s = {
            snap,
            mode: settings.mode,
            windowSeconds: windowSecondsFor(settings),
            aim: aimEl.value === 'coins' ? 'coins' : 'strategy',
            recipes: ctx.getRecipes(),
            facilities: snap.input.facilities || null,
            caps: ctx.config.OUTPUT_CAPS,
            assumptions: reminderAssumptions(),
            running: true,
            controller: new AbortController(),
            round: null,
            result: null,
            coins: { now: undefined, adapted: undefined },
            error: null,
            stopped: false,
        };
        state = s;
        render();
        try {
            s.result = await adaptPlan({
                base: aimInput(snap.input, s.aim, { aniipodTiers: ctx.config.ANIIPOD_TIERS, skipped: snap.context?.skipped }),
                plan: s.aim === 'strategy' ? snap.plan : null,
                mode: s.mode,
                windowSeconds: s.windowSeconds,
                findPlan: ctx.solver.findPlan,
                recipes: s.recipes,
                facilities: s.facilities,
                caps: s.caps,
                assumptions: s.assumptions,
                maxRounds: MAX_ROUNDS,
                signal: s.controller.signal,
                onRound: (n, excluded) => {
                    s.round = { n, excluded };
                    if (state === s) render();
                },
            });
            if (s.result.plan) {
                if (state === s) render();
                s.coins = await coinsInWindow(s);
            }
        } catch (err) {
            const message = err?.message || String(err);
            s.error = message === 'cancelled' ? 'Stopped.' : message === 'timed out' ? 'The planner ran out of time.' : `The planner failed: ${message}`;
            console.warn('Session planner run ended:', err);
        }
        s.running = false;
        s.controller = null;
        if (state === s) render();
    }

    radios.forEach(r => r.addEventListener('change', () => {
        readInputs();
        save();
        showSettings();
    }));
    [minutesEl, hoursEl].forEach(input => {
        input.addEventListener('focus', () => {
            const mode = input === minutesEl ? 'session' : 'overnight';
            radios.forEach(r => { r.checked = r.value === mode; });
            el.classList.toggle('session-overnight', mode === 'overnight');
        });
        input.addEventListener('change', () => {
            readInputs();
            save();
            showSettings();
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') runBtn.click();
        });
    });
    runBtn.addEventListener('click', run);
    stopBtn.addEventListener('click', () => state?.controller?.abort());

    showSettings();
    // A new plan never starts a run; the result only says when it no longer matches. A run still
    // solving stops when no plan is on screen, the inputs were solved again or another Aniimo setup is
    // shown: its Stop button is dimmed then, and it would hold a solver slot. Once the solving is
    // done (a result is in) only the coin count is left, which holds no slot, so that run carries on.
    ctx.on('plan', (value) => {
        current = value || null;
        if (state?.controller && shouldStop(!!state.running && !state.result, state.snap, current)) {
            state.stopped = true;
            state.controller.abort();
        }
        render();
    });
}
