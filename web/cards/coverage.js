// "How sure is this data?" card: for each recipe, the best check behind its numbers (my own checks
// in game, a fan wiki, or nothing yet), plus the facility-level facts. The logic is in
// web/coverage.js; the card contract is in web/panels.js. Nothing is fetched until the section is
// first opened. web/data-sources.json is committed; web/verification.json exists only on my local
// site (it is gitignored), so the public card shows the wiki and my values.csv rows only.
import { coverageHtml, loadCoverage } from '../coverage.js?v=fork-m10-2';

export function mount(el, ctx) {
    ctx.addStylesheet('css/coverage.css');
    el.innerHTML = `
        <div class="card-head"><h2>How sure is this data?</h2></div>
        <p class="hint">Where each recipe's numbers come from: your own checks in game, a fan wiki, or nothing yet.</p>
        <details class="coverage-details" id="coverage-details">
            <summary>Show the checks</summary>
            <div class="coverage-body" id="coverage-body" aria-live="polite" aria-busy="false"></div>
        </details>`;
    const details = el.querySelector('#coverage-details');
    const body = el.querySelector('#coverage-body');
    let state = 'idle'; // idle -> loading -> done; back to idle after a failure, so opening again retries

    const status = (message, isError = false) => {
        body.innerHTML = '';
        const p = document.createElement('p');
        p.className = 'feature-status';
        p.setAttribute('role', isError ? 'alert' : 'status');
        p.textContent = message;
        body.appendChild(p);
        return p;
    };

    async function load() {
        if (state !== 'idle') return;
        state = 'loading';
        body.setAttribute('aria-busy', 'true');
        status('Loading the checks...');
        let items;
        try {
            items = await ctx.items();
        } catch (err) {
            state = 'idle';
            console.warn('coverage: the game data is not ready', err);
            body.setAttribute('aria-busy', 'false');
            const p = status('The game data is not ready yet (the solver is still loading). ', true);
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.id = 'coverage-retry';
            retry.className = 'toggle-button small';
            retry.textContent = 'Try again';
            retry.addEventListener('click', load);
            p.appendChild(retry);
            return;
        }
        try {
            const model = await loadCoverage({ getItems: () => items, config: ctx.config });
            body.innerHTML = coverageHtml(model, ctx.format);
            body.setAttribute('aria-busy', 'false');
            state = 'done';
        } catch (err) {
            state = 'idle';
            console.warn('coverage: not shown', err);
            body.setAttribute('aria-busy', 'false');
            status('The checks could not be shown. Close this section and open it again to retry.', true);
        }
    }

    details.addEventListener('toggle', () => {
        if (details.open) load();
    });
}
