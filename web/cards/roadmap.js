// Upgrade roadmap card: "what should I upgrade next?" On a click, each possible change to the
// current setup is solved for the most Home Coins (ctx.solver.rank with measure 'coins') and
// shown with its cost, the extra coins an hour, how fast it pays back, and how long the plan's
// income takes to save its coins. Logic in web/roadmap.js; the card contract is in web/panels.js.

import {
    emptyRoadmapStatus, nextBatch, remainingCount, roadmapCandidates, roadmapHomeLevel, scoreRoadmap, shouldStop, slowerItemThanCoins,
} from '../roadmap.js?v=fork-m9-2';
import { summarizePlan } from '../plan-summary.js?v=fork-m9-2';

const BATCH = 20;

export function mount(el, ctx) {
    ctx.addStylesheet('css/roadmap.css');
    const { escape, number, duration } = ctx.format;
    el.innerHTML = `
        <h2>Upgrade roadmap</h2>
        <p class="hint">Costs come from wikily.gg (not verified in game); gains are what the planner expects from one change at a time.</p>
        <div class="feature-actions">
            <button type="button" id="roadmap-check" class="skip-add-btn">Check upgrades</button>
            <button type="button" id="roadmap-stop" class="skip-add-btn" hidden>Stop</button>
            <button type="button" id="roadmap-more" class="skip-add-btn" hidden>Check more</button>
        </div>
        <p class="feature-status" id="roadmap-status" role="status" aria-live="polite"></p>
        <div class="feature-scroll" id="roadmap-table"></div>`;
    const checkBtn = el.querySelector('#roadmap-check');
    const stopBtn = el.querySelector('#roadmap-stop');
    const moreBtn = el.querySelector('#roadmap-more');
    const statusEl = el.querySelector('#roadmap-status');
    const tableEl = el.querySelector('#roadmap-table');

    let current = null; // the latest 'plan' value
    // The check on screen: { snap, homeLevel, simple, shown (solvable changes in the table),
    // unsolved (needs a higher RV), deferred (not in the table yet), results (by candidate id:
    // rank's answer, null for no plan, missing while unanswered), baseTop, baseProven, baseFailed,
    // coinsPerHour, running, controller, outcome (rank's last outcome), stopped (a new plan stopped
    // the run) }.
    let state = null;

    const isStale = () => !!state && !(current && current.setupHash === state.snap.setupHash && current.setup === state.snap.setup);

    const hours = h => (h === null || !Number.isFinite(h) ? '–' : h * 3600 < 60 ? 'under 1m' : duration(h * 3600));
    const rate = n => (n >= 10 ? number(Math.round(n)) : String(Number(n.toPrecision(2))));

    function gainCell(row) {
        if (row.status === 'gain') return `<span class="roadmap-gain">+${escape(rate(row.gainPerHour))}${row.proven === false ? '~' : ''}</span>`;
        if (row.status === 'no-gain') return 'no gain';
        if (row.status === 'failed') return 'no answer';
        if (row.status === 'needs-rv') return `needs RV ${escape(row.needsRv)}`;
        return state.running ? 'checking…' : 'not checked';
    }

    // A row's note, for the footnotes under the table. The next RV also waits on its items: the
    // plan's level-up (when it is for that RV) says how long the slowest takes.
    function noteFor(row) {
        if (!row.note) return null;
        const levelUp = state.snap.plan?.level_up;
        if (row.kind !== 'next-rv' || !levelUp || Number(state.snap.context?.target) !== row.level) return row.note;
        const coinsSeconds = Number.isFinite(row.affordInHours) ? row.affordInHours * 3600 : null;
        const slow = slowerItemThanCoins(levelUp.requirements, coinsSeconds);
        if (!slow) return row.note;
        return `${row.note} The slowest item is ${ctx.format.item(slow.name)}: ${slow.seconds === null
            ? 'this plan never makes enough'
            : `${duration(slow.seconds)} at this plan's pace`}, longer than saving the coins.`;
    }

    function renderTable(rows) {
        if (rows.length === 0) {
            tableEl.innerHTML = '';
            return;
        }
        const notes = [];
        const body = rows.map((row, i) => {
            const note = noteFor(row);
            if (note) notes.push(`<p class="hint small roadmap-footnote">* ${escape(row.label)}: ${escape(note)}</p>`);
            const muted = row.status !== 'gain' && row.status !== 'pending';
            const classes = [i === 0 && row.status === 'gain' ? 'roadmap-best' : '', muted ? 'roadmap-muted' : ''].filter(Boolean).join(' ');
            const cost = row.cost !== null ? escape(number(row.cost)) : (row.kind === 'build' ? 'not listed' : 'unknown');
            const afford = row.status === 'needs-rv' ? '–' : escape(hours(row.affordInHours));
            return `<tr${classes ? ` class="${classes}"` : ''}>
                <td>${escape(row.label)}${note ? ' *' : ''}</td>
                <td class="roadmap-num">${cost}</td>
                <td class="roadmap-num">${gainCell(row)}</td>
                <td class="roadmap-num">${row.status === 'gain' ? escape(hours(row.paybackHours)) : '–'}</td>
                <td class="roadmap-num">${afford}</td>
            </tr>`;
        }).join('');
        const unproven = rows.some(r => r.status === 'gain' && r.proven === false);
        tableEl.innerHTML = `<table class="roadmap-table">
            <thead><tr>
                <th>Change</th>
                <th class="roadmap-num">Cost</th>
                <th class="roadmap-num" title="Extra Home Coins an hour the planner expects with this change alone">+coins/h</th>
                <th class="roadmap-num" title="How long the extra coins take to repay the cost">Payback</th>
                <th class="roadmap-num" title="How long the plan's income now takes to save the cost in Home Coins, starting from zero; items a change also needs are not counted">Coins saved in</th>
            </tr></thead>
            <tbody>${body}</tbody>
        </table>${notes.join('')}${unproven ? '<p class="hint small roadmap-footnote">~ the solver ran out of time before proving this is its best answer.</p>' : ''}`;
    }

    function statusText(rows) {
        if (!state) {
            return current
                ? `Checks up to ${BATCH} changes to this setup, cheapest first. Each one is solved in full, so this can take a few minutes.`
                : 'Solve a plan first.';
        }
        const parts = [];
        if (isStale()) parts.push(state.stopped ? 'Setup changed; check again. (stopped)' : 'Setup changed; check again.');
        const asked = state.shown.length;
        const answered = state.shown.filter(c => state.results[c.id] !== undefined).length;
        const helped = rows.filter(r => r.status === 'gain').length;
        const within = `RV ${state.homeLevel} limits`;
        if (state.running) {
            parts.push(`Checking ${answered} of ${asked} changes within ${within}…`);
        } else if (state.baseFailed) {
            parts.push('The planner could not work out the current setup, so nothing could be compared.');
        } else if (asked === 0) {
            parts.push(emptyRoadmapStatus(state.unsolved, state.deferred, state.homeLevel, { simple: state.simple })
                || `Nothing to check within ${within}.`);
        } else {
            const outcome = state.outcome || {};
            const ended = outcome.cancelled ? 'Stopped. ' : outcome.timedOut ? 'Ran out of time. ' : outcome.failed ? 'A planner worker failed. ' : '';
            parts.push(`${ended}Checked ${answered} of ${asked} changes within ${within}; ${helped} would earn more.`);
        }
        const left = remainingCount(state.shown, state.deferred, state.results);
        if (!state.running && left > 0) parts.push(`${left} not checked yet.`);
        if (Number.isFinite(state.coinsPerHour)) parts.push(`Income now: ${number(Math.round(state.coinsPerHour))} coins/h.`);
        return parts.join(' ');
    }

    function render() {
        const running = !!state?.running;
        checkBtn.disabled = running || !current;
        stopBtn.hidden = !running;
        const left = state && !running && !isStale() ? remainingCount(state.shown, state.deferred, state.results) : 0;
        moreBtn.hidden = left === 0;
        moreBtn.disabled = left === 0;
        moreBtn.textContent = left > 0 ? `Check ${Math.min(BATCH, left)} more` : 'Check more';
        el.classList.toggle('roadmap-stale', isStale());
        const rows = state
            ? scoreRoadmap([...state.shown, ...state.unsolved], state.baseTop, state.results, {
                coinsPerHour: state.coinsPerHour, baseProven: state.baseProven,
            })
            : [];
        statusEl.textContent = statusText(rows);
        renderTable(rows);
    }

    async function run(batch) {
        const s = state;
        if (!s || batch.length === 0) {
            // Nothing to solve: the status line and any needs-RV rows still show.
            render();
            return;
        }
        s.running = true;
        s.stopped = false;
        s.outcome = null;
        s.baseFailed = false;
        s.controller = new AbortController();
        render();
        // The plan's own first solve, when it was the Home Coins one, spares solving the base again;
        // after the first batch the base's answer is known.
        const given = Number.isFinite(s.baseTop)
            ? { measure: 'coins', objective: s.baseTop, proven: s.baseProven }
            : (s.snap.plan?.measure_top?.measure === 'coins' ? s.snap.plan.measure_top : undefined);
        const outcome = await ctx.solver.rank('coins', s.snap.input, batch.map(c => c.input), {
            baseTop: given,
            signal: s.controller.signal,
            onBase: (base) => {
                if (base && Number.isFinite(base.top)) {
                    s.baseTop = base.top;
                    s.baseProven = base.proven !== false;
                } else {
                    s.baseFailed = true;
                }
                if (state === s) render();
            },
            onResult: (index, result) => {
                const c = batch[index];
                if (c) s.results[c.id] = result && Number.isFinite(result.top) ? result : null;
                if (state === s) render();
            },
        });
        if (!Number.isFinite(s.baseTop) && outcome.base && !Number.isFinite(outcome.base.top)) s.baseFailed = true;
        s.running = false;
        s.controller = null;
        s.outcome = outcome;
        if (state === s) render();
    }

    checkBtn.addEventListener('click', () => {
        const snap = ctx.last('plan');
        if (!snap?.input || state?.running) {
            render();
            return;
        }
        const simple = typeof snap.context?.simple === 'boolean' ? snap.context.simple : ctx.isSimple();
        // The RV level in the saved inputs (Advanced mode keeps it too), if there is one.
        let saved = null;
        try {
            saved = Number(ctx.getSetup()?.['home-level']) || null;
        } catch (_) { /* no saved inputs */ }
        const homeLevel = roadmapHomeLevel(snap.input, { config: ctx.config, simple, homeLevel: simple ? ctx.homeLevel() : saved, context: snap.context });
        const { candidates, deferred } = roadmapCandidates(snap.input, {
            config: ctx.config, homeLevel, simple, maxCandidates: BATCH, format: ctx.format,
        });
        state = {
            snap, homeLevel, simple,
            shown: candidates.filter(c => c.input),
            unsolved: candidates.filter(c => !c.input),
            deferred,
            results: {},
            baseTop: null, baseProven: true, baseFailed: false,
            coinsPerHour: summarizePlan(snap.plan).coinsPerHour,
            running: false, controller: null, outcome: null,
        };
        run(state.shown);
    });

    stopBtn.addEventListener('click', () => state?.controller?.abort());

    moreBtn.addEventListener('click', () => {
        if (!state || state.running || isStale()) return;
        const { batch, deferred } = nextBatch(state.shown, state.deferred, state.results, BATCH);
        state.deferred = deferred;
        for (const c of batch) if (!state.shown.includes(c)) state.shown.push(c);
        run(batch);
    });

    // A new plan never starts a check; the table only says when it no longer matches. A check still
    // running stops when no plan is on screen or the inputs were solved again: its Stop button is
    // dimmed then, and it would hold both solver slots. The answers so far stay on screen.
    ctx.on('plan', (value) => {
        current = value || null;
        if (state?.controller && shouldStop(!!state.running, state.snap, current)) {
            state.stopped = true;
            state.controller.abort();
        }
        render();
    });
}
