// Roster advisor card: for a player planning with "My Aniimo" (their own roster), which Aniimo is
// the weakest link and which change to the team helps most. On a click the plan is solved again
// (ctx.solver.rank, with the measure the plan leads with) with each Aniimo left out, each one a
// level higher, and a new Aniimo for each ability the owned facilities use that nobody on the
// team has, at level 1 and at the top level, plus the Best team as a reference for the
// "X% of the Best team" line. Logic in web/roster-advisor.js; the card contract is in
// web/panels.js.
//
// Which abilities the facilities use comes from ctx.items() (the worker's get_all_items): each
// recipe's `aniimo` ([ability, min level], from data/aniimo_requirements.csv) and each crop's or
// tree's `jobs` (data/grower_steps.csv), turned into rows by requirementsFromItems. If items()
// fails, each facility's own `ability` in ctx.config.FACILITIES stands in.

import {
    ADVISOR_MIN_GAIN, bestShare, homeCapFor, measureFor, measureLabel, neededAbilities, rankRows, requirementsFromItems,
    rosterCandidates, stopsCheck, weakestLink,
} from '../roster-advisor.js?v=fork-m10-2';

const MAX_CANDIDATES = 30;

export function mount(el, ctx) {
    ctx.addStylesheet('css/roster-advisor.css');
    const { escape, number, duration } = ctx.format;
    el.innerHTML = `
        <h2>Roster advisor</h2>
        <p class="hint" id="roster-advisor-hint" hidden>Pick My Aniimo in the Aniimo Team card to get advice on your team</p>
        <div id="roster-advisor-body">
            <p class="hint">Solves your plan again with each change to your team: each Aniimo left out (the one you miss least is your weakest link), each one a level higher, and a new Aniimo for each ability your facilities use that nobody on your team has. New Aniimo are counted without a personality bonus.</p>
            <div class="feature-actions">
                <button type="button" id="roster-advisor-run" class="skip-add-btn">Advise me</button>
                <button type="button" id="roster-advisor-stop" class="skip-add-btn" hidden>Stop</button>
            </div>
            <p class="feature-status" id="roster-advisor-status" role="status" aria-live="polite"></p>
            <p class="roster-advisor-share" id="roster-advisor-share" role="status" aria-live="polite" hidden></p>
            <div class="feature-scroll" id="roster-advisor-table" aria-busy="false"></div>
            <p class="hint small" id="roster-advisor-missing" role="status" aria-live="polite" hidden></p>
        </div>`;
    const hintEl = el.querySelector('#roster-advisor-hint');
    const bodyEl = el.querySelector('#roster-advisor-body');
    const runBtn = el.querySelector('#roster-advisor-run');
    const stopBtn = el.querySelector('#roster-advisor-stop');
    const statusEl = el.querySelector('#roster-advisor-status');
    const shareEl = el.querySelector('#roster-advisor-share');
    const tableEl = el.querySelector('#roster-advisor-table');
    const missingEl = el.querySelector('#roster-advisor-missing');

    let current = null; // the latest 'plan' value
    let lastTab = null; // the tab of the latest plan on screen (a null plan in between keeps it)
    // The check on screen: { snap, measure, label, candidates, total, results (by candidate index:
    // rank's answer, undefined while unanswered), baseTop ({ top, proven } or null), baseFailed,
    // needed, missing, homeCap, source, running, controller, outcome }.
    let state = null;

    // A roster edit plans again without a new setupHash, so the setup string is compared too.
    const isStale = () => !!state && !(current && current.setupHash === state.snap.setupHash && current.setup === state.snap.setup);
    const short = n => (Math.abs(n) >= 10 ? number(Math.round(Math.abs(n))) : String(Number(Math.abs(n).toPrecision(2))));
    const signed = n => `${n >= 0 ? '+' : '−'}${short(n)}`;
    const percent = share => {
        const p = Math.abs(share * 100);
        return `${share >= 0 ? '+' : '−'}${p >= 10 ? Math.round(p) : p.toFixed(1)}%`;
    };

    function effectText(row) {
        if (row.status === 'none') return 'no plan';
        const about = row.proven === false ? '~' : '';
        if (row.flat) {
            const coinsMove = state.measure !== 'coins' && Number.isFinite(row.coinsDelta) && Math.abs(row.coinsChange ?? 0) > ADVISOR_MIN_GAIN;
            if (coinsMove) return `${about}same ${state.label}, ${signed(row.coinsDelta)} coins/h`;
            return row.delta === null && state.baseTop === null ? '–' : `${about}no change`;
        }
        if (state.measure === 'level_up') {
            if (row.hoursSaved === null) return row.levelUpSeconds ? `${about}level-up in ${duration(row.levelUpSeconds)}` : `${about}no level-up`;
            const by = duration(Math.abs(row.hoursSaved) * 3600);
            return `${about}${by} ${row.hoursSaved > 0 ? 'sooner' : 'later'} (level-up in ${duration(row.levelUpSeconds)})`;
        }
        const unit = state.measure === 'coins' ? 'coins' : state.label;
        return `${about}${signed(row.delta)} ${unit}/h (${percent(row.change)})`;
    }

    function effectClass(row) {
        if (row.status !== 'ok') return '';
        const score = row.flat ? (row.coinsChange ?? 0) : row.change;
        if (Math.abs(score) <= ADVISOR_MIN_GAIN) return '';
        return score > 0 ? 'delta-up' : 'delta-down';
    }

    function renderTable(rows) {
        if (rows.length === 0) {
            tableEl.innerHTML = '';
            tableEl.removeAttribute('tabindex');
            tableEl.removeAttribute('role');
            tableEl.removeAttribute('aria-label');
            return;
        }
        // A scrolling box is reachable from the keyboard only while it has something in it.
        tableEl.setAttribute('tabindex', '0');
        tableEl.setAttribute('role', 'region');
        tableEl.setAttribute('aria-label', 'Roster advice');
        const weakest = weakestLink(rows);
        const body = rows.map((row) => {
            const notes = [row.note, row.overCap ? `over the roster cap (${state.homeCap})` : ''].filter(Boolean);
            const classes = [row === weakest ? 'roster-advisor-weakest' : '', row.status !== 'ok' ? 'roster-advisor-muted' : ''].filter(Boolean).join(' ');
            const coins = Number.isFinite(row.coinsPerHour) ? escape(number(Math.round(row.coinsPerHour))) : '–';
            return `<tr${classes ? ` class="${classes}"` : ''}>
                <td>${escape(row.label)}</td>
                <td class="roster-advisor-num ${effectClass(row)}">${escape(effectText(row))}</td>
                <td class="roster-advisor-num">${coins}</td>
                <td>${notes.map(n => `<span class="roster-advisor-note${n.startsWith('over') ? ' roster-advisor-over' : ''}">${escape(n)}</span>`).join(' ')}${row === weakest ? '<span class="roster-advisor-note">weakest link</span>' : ''}</td>
            </tr>`;
        }).join('');
        const unproven = rows.some(r => r.status === 'ok' && r.proven === false);
        tableEl.innerHTML = `<table class="roster-advisor-table">
            <caption class="visually-hidden">Changes to your Aniimo team and how each moves what the plan leads with (${escape(state.label)})</caption>
            <thead><tr>
                <th scope="col">Change</th>
                <th scope="col" class="roster-advisor-num" title="How the change moves what the plan leads with (${escape(state.label)})">Effect</th>
                <th scope="col" class="roster-advisor-num" title="Home Coins an hour with this change (shown when known)">Coins/h</th>
                <th scope="col">Note</th>
            </tr></thead>
            <tbody>${body}</tbody>
        </table>${unproven ? '<p class="hint small">~ the solver ran out of time before proving this is its best answer.</p>' : ''}`;
    }

    function shareText() {
        if (!state || !state.candidates.length || state.candidates[0].kind !== 'best') return '';
        const best = state.results[0];
        if (best === undefined) return '';
        if (!Number.isFinite(best?.top)) return 'The Best team found no plan to compare with.';
        const share = bestShare(state.baseTop, best);
        if (share === null) return '';
        const about = best.proven === false || state.baseTop?.proven === false ? '~' : '';
        const pct = `${about}${share >= 10 ? Math.round(share) : share.toFixed(1)}%`;
        return state.measure === 'level_up'
            ? `Your team levels up at ${pct} of the Best team's pace (every ability at its top level).`
            : `Your team gets ${pct} of the Best team's ${state.label} (every ability at its top level).`;
    }

    function statusText(rows) {
        if (!state) return current ? 'Each change is solved in full, so this can take a few minutes.' : 'Solve a plan first.';
        const parts = [];
        if (isStale()) parts.push('Your setup changed since this check; click Advise me again.');
        const asked = state.candidates.length;
        const answered = state.results.filter(r => r !== undefined).length;
        if (state.running) {
            parts.push(asked ? `Checking ${answered} of ${asked} changes…` : 'Getting ready…');
        } else if (state.baseFailed) {
            parts.push('The planner could not work out your team as it stands, so nothing could be compared.');
        } else {
            const outcome = state.outcome || {};
            const ended = outcome.cancelled ? 'Stopped. ' : outcome.timedOut ? 'Ran out of time. ' : outcome.failed ? 'A planner worker failed. ' : '';
            const helped = rows.filter(r => r.tier === 2 || (r.tier === 1 && r.score > ADVISOR_MIN_GAIN)).length;
            parts.push(`${ended}Checked ${answered} of ${asked} changes, ranked by ${state.label}; ${helped} would help.`);
            const weakest = weakestLink(rows);
            if (weakest) {
                parts.push(weakest.note === 'not needed by this plan'
                    ? `Weakest link: ${weakest.who}, which this plan doesn't need.`
                    : `Weakest link: ${weakest.who} (leaving it out: ${effectText(weakest)}).`);
            }
        }
        if (state.total > asked) parts.push(`${state.total - asked} more changes not checked (at most ${MAX_CANDIDATES} at once).`);
        if (state.source === 'facilities') parts.push('The recipe list could not be read, so abilities come from the facilities alone.');
        return parts.join(' ');
    }

    function render() {
        const custom = lastTab === 'custom';
        hintEl.hidden = custom;
        bodyEl.hidden = !custom;
        const running = !!state?.running;
        runBtn.disabled = running || !current || current.tab !== 'custom' || !current.input?.roster;
        stopBtn.hidden = !running;
        el.classList.toggle('roster-advisor-stale', isStale());
        const rows = state && !state.baseFailed ? rankRows(state.candidates, state.baseTop, state.results, state.measure) : [];
        statusEl.setAttribute('role', state?.baseFailed ? 'alert' : 'status');
        statusEl.textContent = statusText(rows);
        tableEl.setAttribute('aria-busy', running ? 'true' : 'false');
        const share = state && !state.baseFailed ? shareText() : '';
        shareEl.hidden = !share;
        shareEl.textContent = share;
        renderTable(rows);
        const missing = state?.missing || [];
        missingEl.hidden = missing.length === 0;
        missingEl.textContent = missing.length
            ? `Abilities your facilities use that nobody on your team has: ${missing.join(', ')}.${state.homeCap ? ` Your homeland holds ${state.homeCap} Aniimo.` : ''}`
            : '';
    }

    runBtn.addEventListener('click', async () => {
        const snap = ctx.last('plan');
        if (!snap?.input?.roster || snap.tab !== 'custom' || state?.running) {
            render();
            return;
        }
        const s = {
            snap, measure: measureFor(snap.input, snap.context), candidates: [], total: 0, results: [],
            baseTop: null, baseFailed: false, needed: [], missing: [], homeCap: null, source: 'recipes',
            running: true, controller: new AbortController(), outcome: null,
        };
        s.label = measureLabel(s.measure, ctx.config.SEASON?.points);
        state = s;
        render();
        let requirements = [];
        try {
            requirements = requirementsFromItems(await ctx.items());
        } catch (error) {
            console.warn('Roster advisor: the recipe list could not be read', error);
            s.source = 'facilities';
        }
        const needed = neededAbilities(snap.input, ctx.config, requirements);
        const simple = typeof snap.context?.simple === 'boolean' ? snap.context.simple : ctx.isSimple();
        s.homeCap = homeCapFor({ config: ctx.config, simple, homeLevel: ctx.homeLevel(), context: snap.context, input: snap.input });
        const members = snap.input.roster.members || [];
        // The page's roster holds the names; it lines up with the plan's members unless it was
        // edited since.
        const roster = ctx.getRoster() || [];
        const names = roster.length === members.length ? roster.map(a => a?.name || '') : [];
        const options = { neededAbilities: needed, homeCap: s.homeCap, names };
        s.candidates = rosterCandidates(snap.input, { ...options, maxCandidates: MAX_CANDIDATES });
        s.total = rosterCandidates(snap.input, { ...options, maxCandidates: Infinity }).length;
        s.results = s.candidates.map(() => undefined);
        s.needed = [...needed];
        const have = new Set(members.filter(m => m.count > 0).flatMap(m => Object.keys(m.abilities || {})));
        s.missing = s.needed.filter(a => !have.has(a));
        // The plan's own first solve, when it led with the same measure, spares solving the base again.
        const given = snap.plan?.measure_top?.measure === s.measure ? snap.plan.measure_top : undefined;
        if (given && Number.isFinite(given.objective)) s.baseTop = { top: given.objective, proven: given.proven !== false };
        if (state === s) render();
        const outcome = await ctx.solver.rank(s.measure, snap.input, s.candidates.map(c => c.input), {
            baseTop: given,
            signal: s.controller.signal,
            onBase: (base) => {
                if (Number.isFinite(base?.top)) s.baseTop = { top: base.top, proven: base.proven !== false };
                else s.baseFailed = true;
                if (state === s) render();
            },
            onResult: (index, result) => {
                if (index >= 0 && index < s.results.length) s.results[index] = result || null;
                if (state === s) render();
            },
        });
        if (s.baseTop === null && outcome.base && !Number.isFinite(outcome.base.top)) s.baseFailed = true;
        s.running = false;
        s.controller = null;
        s.outcome = outcome;
        if (state === s) render();
    });

    stopBtn.addEventListener('click', () => state?.controller?.abort());

    // A new plan never starts a check; the table only says when it no longer matches. A check
    // still running stops when the plan is cleared or fails, another setup is shown, or the inputs
    // were solved again: its Stop button is hidden or dimmed then, and it would hold both solver
    // slots.
    ctx.on('plan', (value) => {
        current = value || null;
        if (current) lastTab = current.tab;
        if (state?.running && stopsCheck(state.snap, current)) state.controller?.abort();
        render();
    });
}
