// "What if" card: a sandbox for trying a few changes on a copy of the plan on screen. The form is
// filled from the current plan's input; on "Try it" the edited copy is solved on its own
// (ctx.solver.findPlan) and shown next to the current plan. It never writes the saved profile or a
// snapshot and keeps nothing in storage. Logic in web/what-if.js; the card contract is in web/panels.js.

import { stripVariant } from '../plan-summary.js?v=fork-m9-1';
import { applyEdits, buildableFacilities, editsFromForm, homeLevelFor, sideBySide, slugOf, warnings } from '../what-if.js?v=fork-m9-1';

const MAX_ABILITY_LEVEL = 4; // MAX_ANIIMO_LEVEL in app.js and models.rs

export function mount(el, ctx) {
    ctx.addStylesheet('css/what-if.css');
    const { escape, number, duration, item } = ctx.format;
    const cfg = ctx.config;
    el.innerHTML = `
        <h2>What if</h2>
        <p class="hint">Change a few things and see how the plan answers. Your own setup stays as it is, and nothing here is saved.</p>
        <p class="feature-status" id="what-if-note" role="status"></p>
        <div class="what-if-form" id="what-if-form"></div>
        <div class="feature-actions">
            <button type="button" id="what-if-try" class="skip-add-btn">Try it</button>
            <button type="button" id="what-if-stop" class="skip-add-btn" disabled>Stop</button>
            <button type="button" id="what-if-reset" class="skip-add-btn">Reset to my setup</button>
        </div>
        <p class="feature-status" id="what-if-status" role="status" aria-live="polite"></p>
        <ul class="what-if-warnings" id="what-if-warnings"></ul>
        <div id="what-if-result" aria-live="polite"></div>`;
    const formEl = el.querySelector('#what-if-form');
    const tryBtn = el.querySelector('#what-if-try');
    const stopBtn = el.querySelector('#what-if-stop');
    const resetBtn = el.querySelector('#what-if-reset');
    const noteEl = el.querySelector('#what-if-note');
    const statusEl = el.querySelector('#what-if-status');
    const warnEl = el.querySelector('#what-if-warnings');
    const resultEl = el.querySelector('#what-if-result');

    let current = null;  // the latest 'plan' value, or null
    let seedSnap = null; // the plan value the form was filled from
    let seeded = {};     // data-key -> the value the form was filled with
    let markup = '';     // the form's HTML as last built
    let run = null;      // { controller } while a solve runs
    let shown = null;    // { setupHash, setup } of the plan the comparison on screen was made against

    const controls = () => [...formEl.querySelectorAll('[data-key]')];
    const isFacilityKey = key => key.startsWith('facility|');

    // The form's flat values, as editsFromForm takes them: only what differs from how it was
    // filled, but every box of a facility with a change (its tiers are replaced as a whole).
    function changedValues() {
        const touched = new Set(controls().filter(c => isFacilityKey(c.dataset.key) && c.value !== seeded[c.dataset.key])
            .map(c => c.dataset.key.split('|')[1]));
        const out = {};
        for (const c of controls()) {
            const key = c.dataset.key;
            if (isFacilityKey(key) ? touched.has(key.split('|')[1]) : c.value !== seeded[key]) out[key] = c.value;
        }
        return out;
    }

    const describeChanges = () => controls().filter(c => c.type !== 'hidden' && c.value !== seeded[c.dataset.key])
        .map(c => `${c.dataset.label}: ${seeded[c.dataset.key]} → ${c.value === '' ? 'blank' : c.value}`);

    const isDirty = () => Object.keys(changedValues()).length > 0;
    const isStale = () => !!(current && seedSnap && (current.setupHash !== seedSnap.setupHash || current.setup !== seedSnap.setup));

    function options(from, to, chosen) {
        const levels = [];
        for (let l = Math.min(from, chosen); l <= Math.max(to, chosen); l++) levels.push(l);
        return levels.map(l => `<option value="${l}"${l === chosen ? ' selected' : ''}>${l}</option>`).join('');
    }

    const isSimpleFor = snap => (typeof snap.context?.simple === 'boolean' ? snap.context.simple : ctx.isSimple());
    // The RV level the plan is for (Simple mode: its own; Advanced: the lowest covering what is owned).
    const rvOf = snap => homeLevelFor(snap.input, cfg, { simple: isSimpleFor(snap), homeLevel: ctx.homeLevel(), target: Number(snap.context?.target) || null });

    // The form for `input` at RV level `rv`, as { html, values }: values maps each box's data-key to its start value.
    function buildForm(input, rv) {
        const values = {};
        const attrs = (key, value, label) => {
            values[key] = String(value);
            return `data-key="${escape(key)}" data-label="${escape(label)}"`;
        };
        const select = (id, label, key, text, from, to, chosen) => `
            <label for="${id}">${label}</label>
            <select id="${id}" ${attrs(key, chosen, text)}>${options(from, to, chosen)}</select>`;

        // One row for tier `i` of facility `f` (a facility you could build is a tier with a count of 0).
        const facilityRow = (f, tier, i, name, top) => {
            const id = `what-if-${slugOf(f.name)}${i ? `-${i + 1}` : ''}`;
            const level = f.hasLevels === false
                ? `<input type="hidden" ${attrs(`facility|${f.name}|${i}|level`, 1, `${name} level`)} value="1">`
                : select(`${id}-level`, 'Level', `facility|${f.name}|${i}|level`, `${name} level`, 1, top, tier.level);
            return `<div class="what-if-row">
                <label for="${id}-count" class="what-if-name">${escape(name)}</label>
                <input type="number" min="0" step="1" id="${id}-count" value="${tier.count}" ${attrs(`facility|${f.name}|${i}|count`, tier.count, `${name} count`)}>
                ${level}</div>`;
        };
        const facilityRows = [];
        const buildRows = [];
        const buildable = new Set(buildableFacilities(input, cfg, rv));
        for (const f of cfg.FACILITIES || []) {
            const tiers = (input.facilities?.[f.name] || []).filter(t => t.count > 0);
            const top = Math.max(1, ...Object.keys(f.unlocks || {}).map(Number));
            tiers.forEach((tier, i) => facilityRows.push(facilityRow(f, tier, i, tiers.length > 1 ? `${f.name} (group ${i + 1})` : f.name, top)));
            if (buildable.has(f.name)) buildRows.push(facilityRow(f, { count: 0, level: 1 }, 0, f.name, top));
        }

        const moduleRows = (cfg.modules || Object.keys(cfg.MODULE_MAX_LEVELS || {})).map((id) => {
            const name = cfg.moduleNames?.[id] || id;
            const top = Math.max(0, ...(cfg.MODULE_MAX_LEVELS?.[id] || []));
            return `<div class="what-if-row">${select(`what-if-module-${slugOf(id)}`, escape(name), `module|${id}`, name, 0, top, Number(input.modules?.[id]) || 0)}</div>`;
        });

        let aniimo = '';
        if (input.aniimo === 'roster' && Array.isArray(input.roster?.members)) {
            aniimo = input.roster.members.map((m, i) => {
                const label = `Aniimo ${i + 1}${m.count > 1 ? ` (×${m.count})` : ''}`;
                const rows = Object.entries(m.abilities || {}).map(([ability, level]) => `<div class="what-if-row">
                    ${select(`what-if-member-${i + 1}-${slugOf(ability)}`, escape(ability), `roster|${i}|${ability}`, `${label} ${ability}`, 1, MAX_ABILITY_LEVEL, Number(level) || 1)}</div>`);
                return `<div class="what-if-member"><p class="what-if-member-name">${escape(label)}</p>${rows.join('') || '<p class="hint small">No abilities.</p>'}</div>`;
            }).join('');
            aniimo = aniimo ? `<div class="what-if-group"><h3>Aniimo levels</h3><div class="what-if-grid">${aniimo}</div></div>` : '';
        } else if (input.aniimo === 'minimum') {
            aniimo = '<p class="hint small">The minimum team plan ignores Aniimo levels, so there is nothing to change there.</p>';
        } else if (Object.keys(input.aniimo_levels || {}).length > 0) {
            const rows = Object.entries(input.aniimo_levels).map(([ability, level]) => `<div class="what-if-row">
                ${select(`what-if-ability-${slugOf(ability)}`, escape(ability), `ability|${ability}`, `${ability} Aniimo level`, 1, MAX_ABILITY_LEVEL, Number(level) || 1)}</div>`);
            aniimo = `<div class="what-if-group"><h3>Aniimo levels</h3><div class="what-if-grid">${rows.join('')}</div></div>`;
        }

        const group = (title, rows) => (rows.length ? `<div class="what-if-group"><h3>${title}</h3><div class="what-if-grid">${rows.join('')}</div></div>` : '');
        return { html: group('Facilities', facilityRows) + group(`Not built yet (unlocked by RV ${rv})`, buildRows) + group('Modules', moduleRows) + aniimo, values };
    }

    function seedForm(snap, force = false) {
        const built = buildForm(snap.input, rvOf(snap));
        seeded = built.values;
        seedSnap = snap;
        // The same markup is left alone, so a plan that came back the same does not steal focus.
        if (force || built.html !== markup) formEl.innerHTML = built.html;
        markup = built.html;
    }

    function render() {
        const resultStale = !!shown && !(current && current.setupHash === shown.setupHash && current.setup === shown.setup);
        tryBtn.disabled = !!run || !current;
        stopBtn.disabled = !run;
        if (!current) noteEl.textContent = 'Solve a plan first, then try changes here.';
        else if (isStale() && isDirty()) noteEl.textContent = 'The plan changed after you started editing. Try it applies your changes to the new plan; Reset to my setup starts over from it.';
        else if (resultStale) noteEl.textContent = 'The plan changed since this comparison. Press Try it again to compare with the new plan.';
        else noteEl.textContent = '';
        resultEl.classList.toggle('what-if-stale', resultStale);
    }

    // Home Coins an hour and the time to the next RV level, for the plan as it stands and with the changes.
    const delta = (value, text, goodWhenUp) => {
        if (value === null || Math.round(value) === 0) return '';
        return ` <span class="${(value > 0) === goodWhenUp ? 'delta-up' : 'delta-down'}">(${escape(text)})</span>`;
    };

    function showComparison(snap, plan, tried) {
        shown = { setupHash: snap.setupHash, setup: snap.setup };
        const changes = `<p class="hint small">Tried: ${tried.map(escape).join('; ')}</p>`;
        const cmp = sideBySide(snap.plan, plan);
        if (!cmp.b.ok) {
            resultEl.innerHTML = `${changes}<p class="what-if-fail">No plan with these changes: ${escape(plan?.error || 'the planner found none')}.</p>`;
            return;
        }
        const coins = s => (s.coinsPerHour === null ? '–' : number(Math.round(s.coinsPerHour)));
        const levelUp = s => (s.levelUpSeconds === null ? '–' : duration(s.levelUpSeconds));
        const dCoins = cmp.deltaCoinsPerHour;
        const dTime = cmp.deltaLevelUpSeconds;
        const stats = (title, s, extraCoins, extraTime) => `<div class="what-if-col"><h3>${title}</h3><dl class="what-if-stats">
            <dt>Home Coins an hour</dt><dd>${coins(s)}${extraCoins}</dd>
            <dt>Time to the next RV level</dt><dd>${levelUp(s)}${extraTime}</dd></dl></div>`;
        const rows = cmp.rows.map(r => `<tr><td>${escape(r.facility)}</td><td>${escape(item(stripVariant(r.item)))}</td>
            <td class="what-if-num">${r.before}</td><td class="what-if-num">${r.after}</td></tr>`).join('');
        const table = rows
            ? `<div class="feature-scroll"><table class="what-if-table"><thead><tr><th>Facility</th><th>Item</th><th class="what-if-num">Before</th><th class="what-if-num">After</th></tr></thead><tbody>${rows}</tbody></table></div>`
            : '<p class="hint small">No facility changes what it makes.</p>';
        const unproven = cmp.a.proven && cmp.b.proven ? '' : '<p class="hint small">The solver ran out of time before proving one of these is its best answer, so small differences may be noise.</p>';
        resultEl.innerHTML = `${changes}<div class="feature-compare">
            ${stats('Your plan now', cmp.a, '', '')}
            ${stats('With your changes', cmp.b,
                delta(dCoins, `${dCoins > 0 ? '+' : ''}${dCoins === null ? '' : number(Math.round(dCoins))}`, true),
                delta(dTime, `${dTime > 0 ? '+' : '−'}${dTime === null ? '' : duration(Math.abs(dTime))}`, false))}
        </div>${table}${unproven}`;
    }

    async function tryIt() {
        const snap = ctx.last('plan');
        if (!snap?.input || run) return;
        const edits = editsFromForm(changedValues());
        const tried = describeChanges();
        if (tried.length === 0 || !Object.values(edits).some(group => Object.keys(group).length > 0)) {
            statusEl.textContent = 'Change a number or a level above first, then press Try it.';
            return;
        }
        const input = applyEdits(snap.input, edits);
        warnEl.innerHTML = warnings(input, cfg, isSimpleFor(snap) ? rvOf(snap) : null).map(w => `<li>${escape(w)}</li>`).join('');
        const controller = new AbortController();
        run = { controller };
        let steps = 0;
        statusEl.textContent = 'Working it out…';
        render();
        try {
            const plan = await ctx.solver.findPlan(input, {
                signal: controller.signal,
                onProgress: (count) => {
                    if (count && typeof count === 'object' && count.state !== 'done') return;
                    steps++;
                    statusEl.textContent = `Working it out… ${steps} step${steps === 1 ? '' : 's'} done.`;
                },
            });
            showComparison(snap, plan, tried);
            statusEl.textContent = plan?.success ? 'Done.' : 'The planner found no plan with these changes.';
        } catch (error) {
            const message = String(error?.message || error);
            statusEl.textContent = message === 'cancelled' ? 'Stopped.'
                : message === 'timed out' ? 'The planner ran out of time. Try a smaller change.'
                : `The planner failed: ${message}`;
        } finally {
            if (run?.controller === controller) run = null;
            render();
        }
    }

    tryBtn.addEventListener('click', tryIt);
    stopBtn.addEventListener('click', () => run?.controller.abort());
    resetBtn.addEventListener('click', () => {
        run?.controller.abort();
        if (current) seedForm(current, true);
        statusEl.textContent = '';
        warnEl.innerHTML = '';
        resultEl.innerHTML = '';
        shown = null;
        render();
    });
    formEl.addEventListener('input', render);
    formEl.addEventListener('change', render);

    // A new plan never starts a solve: it refills the form if nothing was edited, else it only marks it.
    ctx.on('plan', (value) => {
        current = value?.input ? value : null;
        if (current && !isDirty()) seedForm(current);
        render();
    });
}
