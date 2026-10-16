// Compare homelands card: my setup next to a friend's (a profile file, pasted JSON, a share link
// or one of my own snapshots), and on "Solve both" their two plans' coins an hour and time to the
// next RV level. The other side lives in memory only; nothing of it is stored. Logic in
// web/compare.js and web/setup-input.js; the card contract is in web/panels.js.

import { compareResults, compareSetups, otherFromSetup, otherFromSnapshot, otherFromText, NOTHING_LOADED, planMoved, shouldStop } from '../compare.js?v=fork-m10-1';
import { aniimoTabOf, differingKeys, planInputFromSetup } from '../setup-input.js?v=fork-m10-1';
import { formatSeconds, setupHash } from '../history.js?v=fork-m10-1';
import { readShareHash } from '../share-config.js?v=fork-m10-1';

const MAX_FILE_BYTES = 2_000_000;

export function mount(el, ctx) {
    ctx.addStylesheet('css/compare.css');
    const { escape, number } = ctx.format;
    el.innerHTML = `
        <h2>Compare homelands</h2>
        <p class="hint">Put your setup next to a friend's. What you load here stays in this tab's memory only: it is not saved, not uploaded, and gone when you close or reload the page.</p>
        <p class="feature-status compare-warning" id="compare-warning" role="status" aria-live="polite" hidden>The compare tool's input differs from the page's; results may be off.</p>
        <div class="compare-chooser">
            <div class="input-field">
                <label for="compare-file">Profile file</label>
                <input type="file" id="compare-file" accept=".json,application/json">
            </div>
            <div class="input-field">
                <label for="compare-text">Or paste profile JSON or a share link</label>
                <textarea id="compare-text" rows="3" spellcheck="false" placeholder="{ ... } or https://.../#config=..."></textarea>
            </div>
            <div class="input-field">
                <label for="compare-snapshot">Or one of my snapshots</label>
                <select id="compare-snapshot"></select>
            </div>
        </div>
        <div class="feature-actions">
            <button type="button" id="compare-run" class="skip-add-btn">Compare</button>
            <button type="button" id="compare-solve" class="skip-add-btn" disabled>Solve both</button>
            <button type="button" id="compare-stop" class="skip-add-btn" hidden disabled>Stop</button>
            <button type="button" id="compare-clear" class="skip-add-btn">Forget the other side</button>
        </div>
        <p class="feature-status" id="compare-status" role="status" aria-live="polite"></p>
        <div id="compare-output"></div>
        <div id="compare-results" aria-busy="false"></div>`;
    const q = id => el.querySelector(`#compare-${id}`);
    const fileEl = q('file');
    const textEl = q('text');
    const snapEl = q('snapshot');
    const runBtn = q('run');
    const solveBtn = q('solve');
    const stopBtn = q('stop');
    const statusEl = q('status');
    const outputEl = q('output');
    const resultsEl = q('results');
    const warningEl = q('warning');

    // The status line is a polite status; a problem reading the other side is an alert.
    const say = (text, isError = false) => {
        statusEl.setAttribute('role', isError ? 'alert' : 'status');
        statusEl.textContent = text;
    };

    let kind = 'text'; // which chooser was used last: 'file', 'text' or 'snapshot'
    let fileText = '';
    let fileName = '';
    let fileRead = 0; // counts file picks, so a slow read of an earlier file is ignored
    let other = null; // { setup, actual, source } of the comparison on screen
    let shown = null; // { setupHash, setup } of the page plan the solved results were taken against
    let started = null; // the same, for a "Solve both" that is running
    let stopReason = '';
    let controller = null;

    const sourceLabel = o => (o.source === 'profile' && fileName && kind === 'file' ? `profile file ${fileName}` : o.source);

    function fillSnapshots() {
        const list = ctx.getHistory().slice().reverse();
        snapEl.innerHTML = `<option value="">${list.length ? 'Pick a snapshot' : 'No snapshots yet'}</option>`
            + list.map(s => `<option value="${escape(s.id)}">${escape(s.id.slice(0, 16).replace('T', ' '))}${s.actual?.rv ? ` (RV ${escape(String(s.actual.rv))})` : ''}${s.note ? ` ${escape(s.note.slice(0, 30))}` : ''}</option>`).join('');
    }

    // Compares the compare tool's input for my setup with the page's own, when the page's plan is
    // for the setup as it is now. A difference means app.js and setup-input.js have drifted apart.
    function selfCheck() {
        const last = ctx.last('plan');
        let message = '';
        try {
            const setup = ctx.getSetup();
            if (last?.input && last.setupHash === setupHash(setup)) {
                const keys = differingKeys(planInputFromSetup(setup, ctx.config, { aniimoTab: last.tab }), last.input);
                if (keys.length) message = `The compare tool's input differs from the page's; results may be off. It differs in: ${keys.join(', ')}.`;
            }
        } catch (error) {
            console.warn('compare self-check failed', error);
            message = `The compare tool could not check its input against the page's; results may be off (${error?.message || 'error'}).`;
        }
        warningEl.textContent = message;
        warningEl.hidden = !message;
    }

    async function resolveOther() {
        if (kind === 'file') {
            if (!fileText) throw new Error(NOTHING_LOADED);
            return otherFromText(fileText);
        }
        if (kind === 'snapshot') {
            const snapshot = ctx.getHistory().find(s => s.id === snapEl.value);
            if (!snapshot) throw new Error(NOTHING_LOADED);
            return otherFromSnapshot(snapshot);
        }
        const text = textEl.value.trim();
        if (text.length > MAX_FILE_BYTES) throw new Error('that text is too large to be a profile or a setup');
        if (/^https?:\/\//i.test(text) || text.includes('#config=')) {
            let hash;
            try {
                hash = new URL(text).hash;
            } catch (_) {
                throw new Error('that link is not a complete web address');
            }
            const setup = await readShareHash(hash).catch(() => { throw new Error('that share link is damaged or from a newer version'); });
            if (!setup) throw new Error('that link has no shared setup in it (the part after #config=)');
            return otherFromSetup(setup, 'share link');
        }
        return otherFromText(text);
    }

    const cell = value => escape(String(value));
    function column(title, side, cmp, key, o, mineSide) {
        const facilities = cmp.facilities.map(f => `<li class="${f.same ? '' : 'compare-differs'}"><span>${cell(f.name)}</span> ${cell(f[key].levels)}</li>`).join('');
        const modules = cmp.modules.map(m => `<li class="${m.a === m.b ? '' : 'compare-differs'}"><span>${cell(m.name)}</span> ${cell(m[key])}</li>`).join('');
        const rv = cmp.rv[key] ?? 'unknown';
        const game = o?.actual?.rv ? `, game shows RV ${cell(o.actual.rv)}` : '';
        return `<div class="compare-col${mineSide ? ' compare-mine' : ''}">
            <h3>${cell(title)}</h3>
            <p class="hint small">${cell(side)}</p>
            <p><strong>RV level</strong> ${cell(rv)}${game}</p>
            <h4>Facilities</h4><ul class="compare-list">${facilities || '<li>none</li>'}</ul>
            <h4>Modules</h4><ul class="compare-list">${modules}</ul>
            <h4>Aniimo</h4><p>${cell(cmp.roster[key])}</p>
        </div>`;
    }

    function render(cmp, o) {
        const differences = cmp.diff.length
            ? `<h4>What differs (${cmp.diff.length})</h4><ul class="compare-list">${cmp.diff.map(d => `<li><span>${cell(d.what)}</span> ${d.before !== '' ? `${cell(d.before)} → ` : ''}${cell(d.after)}</li>`).join('')}</ul>`
            : '<p>These setups are the same.</p>';
        outputEl.innerHTML = `<div class="feature-compare">${column('Mine', 'this browser', cmp, 'a', null, true)}${column('The other homeland', sourceLabel(o), cmp, 'b', o, false)}</div>${differences}`;
    }

    async function compare() {
        resultsEl.innerHTML = '';
        shown = null;
        try {
            other = await resolveOther();
            render(compareSetups(ctx.getSetup(), other.setup, ctx.config), other);
            say(`Compared with the ${sourceLabel(other)}. Press Solve both to work out both plans.`);
            solveBtn.disabled = false;
            selfCheck();
        } catch (error) {
            other = null;
            outputEl.innerHTML = '';
            solveBtn.disabled = true;
            say(error.message === NOTHING_LOADED ? NOTHING_LOADED : `Could not read the other side: ${error.message}.`, error.message !== NOTHING_LOADED);
        }
    }

    const planOf = (input, signal) => ctx.solver.findPlan(input, { signal })
        .catch(error => ({ success: false, error: error?.message === 'cancelled' ? 'stopped' : (error?.message || 'the planner failed') }));

    function planCell(summary, plan) {
        if (!summary.ok) return `<td class="compare-num">no plan (${cell(plan?.error || 'unknown')})</td>`;
        return `<td class="compare-num">${cell(number(Math.round(summary.coinsPerHour ?? 0)))}</td>`;
    }

    function renderResults(result, planA, planB) {
        const { a, b } = result;
        const delta = (value, text, goodWhenUp) => {
            if (value === null) return '<td class="compare-num">–</td>';
            const good = goodWhenUp ? value > 0 : value < 0;
            const cls = value === 0 ? '' : good ? 'delta-up' : 'delta-down';
            return `<td class="compare-num ${cls}">${cell(text)}</td>`;
        };
        const coinsDelta = result.deltaCoinsPerHour === null ? null : Math.round(result.deltaCoinsPerHour);
        const secs = result.deltaLevelUpSeconds;
        const levelCell = s => (s.ok ? (s.levelUpSeconds === null ? 'n/a (not a level-up plan)' : formatSeconds(s.levelUpSeconds)) : '–');
        const rows = result.rows.filter(r => r.a !== r.b).slice(0, 40).map(r =>
            `<tr><td>${cell(r.facility)}</td><td>${cell(ctx.format.item(r.item))}</td><td class="compare-num">${cell(r.a)}</td><td class="compare-num">${cell(r.b)}</td></tr>`).join('');
        resultsEl.innerHTML = `<div class="feature-scroll" tabindex="0" role="region" aria-label="Plan comparison"><table class="compare-table">
            <caption class="visually-hidden">Home Coins an hour and time to the next RV level, for my plan and the other homeland's</caption>
            <thead><tr><th scope="col">Setting</th><th scope="col" class="compare-num">Mine</th><th scope="col" class="compare-num">Other</th><th scope="col" class="compare-num">Other minus mine</th></tr></thead>
            <tbody>
                <tr><td>Home Coins an hour</td>${planCell(a, planA)}${planCell(b, planB)}${delta(coinsDelta, `${coinsDelta > 0 ? '+' : ''}${number(coinsDelta ?? 0)}`, true)}</tr>
                <tr><td>Time to the next RV level</td><td class="compare-num">${cell(levelCell(a))}</td><td class="compare-num">${cell(levelCell(b))}</td>${delta(secs, `${secs > 0 ? '+' : '-'}${formatSeconds(Math.abs(secs ?? 0))}`, false)}</tr>
            </tbody></table></div>
            ${a.ok && b.ok && !(a.proven && b.proven) ? '<p class="hint small">At least one plan is not proven best (the solver ran out of time), so the gap is approximate.</p>' : ''}
            ${rows ? `<h4>Where the plans differ (facilities making each item)</h4><div class="feature-scroll" tabindex="0" role="region" aria-label="Where the plans differ"><table class="compare-table"><caption class="visually-hidden">Facilities making each item where the two plans differ</caption><thead><tr><th scope="col">Facility</th><th scope="col">Item</th><th scope="col" class="compare-num">Mine</th><th scope="col" class="compare-num">Other</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
    }

    async function solveBoth() {
        if (controller) return;
        if (!other) await compare();
        if (!other) return;
        const mine = ctx.getSetup();
        const mineHash = setupHash(mine);
        const last = ctx.last('plan');
        const reuse = !!(last?.plan && last.input && last.setupHash === mineHash && last.tab === aniimoTabOf(mine));
        const mineInput = reuse ? last.input : planInputFromSetup(mine, ctx.config);
        const otherInput = planInputFromSetup(other.setup, ctx.config);
        controller = new AbortController();
        started = { setupHash: reuse ? last.setupHash : mineHash, setup: last?.setup };
        stopReason = '';
        solveBtn.disabled = true;
        runBtn.disabled = true;
        stopBtn.hidden = false;
        stopBtn.disabled = false;
        resultsEl.innerHTML = '';
        resultsEl.setAttribute('aria-busy', 'true');
        say(reuse ? 'Using your plan on screen; solving the other homeland…' : 'Solving both plans…');
        const [planA, planB] = await Promise.all([
            reuse ? Promise.resolve(last.plan) : planOf(mineInput, controller.signal),
            planOf(otherInput, controller.signal),
        ]);
        const stopped = controller.signal.aborted;
        controller = null;
        stopBtn.hidden = true;
        stopBtn.disabled = true;
        runBtn.disabled = false;
        solveBtn.disabled = false;
        resultsEl.setAttribute('aria-busy', 'false');
        if (stopped) {
            say(stopReason || 'Stopped.');
            return;
        }
        shown = started;
        renderResults(compareResults(planA, planB), planA, planB);
        say('Done. The other side is compared as saved, with their own strategy and Aniimo choices.');
    }

    fileEl.addEventListener('change', () => {
        const file = fileEl.files?.[0];
        kind = 'file';
        fileText = '';
        fileName = '';
        const mine = ++fileRead;
        if (!file) return;
        if (file.size > MAX_FILE_BYTES) {
            say('That file is too large to be a profile.', true);
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            if (mine !== fileRead) return; // a newer file was picked meanwhile
            fileText = String(reader.result || '');
            fileName = file.name;
            say(`Read ${fileName}. Press Compare.`);
        };
        reader.onerror = () => { if (mine === fileRead) say('Could not read that file.', true); };
        reader.readAsText(file);
    });
    textEl.addEventListener('input', () => { kind = 'text'; });
    snapEl.addEventListener('change', () => { kind = 'snapshot'; });
    runBtn.addEventListener('click', compare);
    solveBtn.addEventListener('click', solveBoth);
    stopBtn.addEventListener('click', () => controller?.abort());
    q('clear').addEventListener('click', () => {
        controller?.abort();
        other = null;
        shown = null;
        fileText = '';
        fileName = '';
        fileEl.value = '';
        textEl.value = '';
        snapEl.value = '';
        outputEl.innerHTML = '';
        resultsEl.innerHTML = '';
        solveBtn.disabled = true;
        stopReason = '';
        resultsEl.setAttribute('aria-busy', 'false');
        say('The other side is forgotten.');
    });

    fillSnapshots();
    ctx.on('history', fillSnapshots);
    // A new plan never starts a solve; it re-runs the drift check and marks old results.
    ctx.on('plan', (value) => {
        selfCheck();
        if (shouldStop(!!controller, started, value)) {
            stopReason = "Stopped because the page's plan changed. Press Solve both to start again.";
            controller.abort();
        }
        resultsEl.classList.toggle('compare-stale', !!shown && planMoved(shown, value));
    });
}
