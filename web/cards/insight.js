// "Why am I behind?" card: the plan's predicted coins an hour against what actually happened
// between your snapshots, and, when the latest stretch fell short, ranked guesses at why. Logic in
// web/insight.js; the card contract is in web/panels.js. Nothing is stored. It follows the 'plan',
// 'history' and 'coins' topics. 'coins' is only a cue to redraw when new watcher readings come in,
// snapshot or not; the points themselves are always read from ctx.getCoinSeries(), so a profile
// import or a cleared log never leaves old points on screen.

import { gaps as findGaps, gapsWithin, guesses, intervals } from '../insight.js?v=fork-m10-2';
import { planRows } from '../reminders.js?v=fork-m10-2';

const SHORTFALL_BELOW = 0.9;
const MAX_GUESSES = 5;
const EMPTY = 'Save two snapshots, or let the game watcher on your PC log your coins, then come back to compare.';

export function mount(el, ctx) {
    ctx.addStylesheet('css/insight.css');
    const { escape, number } = ctx.format;
    el.innerHTML = `
        <h2>Why am I behind?</h2>
        <p class="hint">Guesses, not measurements: the app cannot see the game.</p>
        <p class="feature-status" id="insight-status" role="status" aria-live="polite"></p>
        <div class="feature-scroll" id="insight-table"></div>
        <div id="insight-guesses"></div>`;
    const statusEl = el.querySelector('#insight-status');
    const tableEl = el.querySelector('#insight-table');
    const guessEl = el.querySelector('#insight-guesses');

    const pad = n => String(n).padStart(2, '0');
    const when = ms => {
        const d = new Date(ms);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const percent = share => `${Math.round(share * 100)}%`;
    const shareClass = share => (share === null ? '' : share >= 0.95 ? 'delta-up' : share < 0.8 ? 'delta-down' : '');

    function renderTable(list) {
        if (list.length === 0) {
            tableEl.innerHTML = '';
            return;
        }
        const body = list.map(row => {
            const notes = [
                row.source === 'watcher' ? 'watcher readings' : 'snapshot balances',
                row.spent ? 'coins were spent' : '',
            ].filter(Boolean).join(', ');
            return `<tr>
                <td>${escape(when(row.fromMs))} to ${escape(when(row.toMs))}</td>
                <td class="insight-num">${escape(number(Math.round(row.hours * 10) / 10))}</td>
                <td class="insight-num">${escape(number(Math.round(row.predictedPerHour)))}</td>
                <td class="insight-num">${row.actualPerHour === null ? '–' : escape(number(Math.round(row.actualPerHour)))}</td>
                <td class="insight-num ${shareClass(row.share)}">${row.share === null ? '–' : escape(percent(row.share))}</td>
                <td>${escape(notes)}</td>
            </tr>`;
        }).join('');
        tableEl.innerHTML = `<table class="insight-table">
            <caption class="visually-hidden">Predicted and actual Home Coins an hour between snapshots</caption>
            <thead><tr>
                <th scope="col">Between snapshots</th>
                <th scope="col" class="insight-num">Hours</th>
                <th scope="col" class="insight-num" title="What the plan said when the first snapshot was saved">Plan coins/h</th>
                <th scope="col" class="insight-num" title="Coins gained an hour, counting only stretches where the balance rose">Actual coins/h</th>
                <th scope="col" class="insight-num">% of plan</th>
                <th scope="col">Based on</th>
            </tr></thead>
            <tbody>${body}</tbody>
        </table>`;
    }

    function renderGuesses(latest, snapshots, series) {
        if (!latest) {
            guessEl.innerHTML = '';
            return;
        }
        if (latest.share === null) {
            guessEl.innerHTML = '<p class="hint small">Coins were spent in the latest stretch, so its real pace cannot be told.</p>';
            return;
        }
        if (latest.share >= SHORTFALL_BELOW) {
            guessEl.innerHTML = `<p class="hint small">The latest stretch reached ${escape(percent(latest.share))} of the plan, so there is nothing to explain.</p>`;
            return;
        }
        const snapshot = snapshots.find(s => s.id === latest.from);
        const topic = ctx.last('plan');
        const rows = topic?.plan && snapshot
            ? planRows(topic.plan, { recipes: ctx.getRecipes(), facilities: topic.input?.facilities ?? null })
            : [];
        const list = guesses({
            plan: topic,
            rows,
            caps: ctx.config.OUTPUT_CAPS,
            gaps: gapsWithin(findGaps(series), latest.fromMs, latest.toMs),
            setup: snapshot?.setup ?? null,
            shortfallPerHour: latest.predictedPerHour - latest.actualPerHour,
            snapshotHash: snapshot?.setupHash ?? null,
            hours: latest.hours,
            recipes: ctx.getRecipes(),
        }).slice(0, MAX_GUESSES);
        const items = list.map(g => `<li class="insight-guess">
            <span class="insight-confidence insight-confidence-${escape(g.confidence)}">${escape(g.confidence)}</span>
            ${escape(g.text)}
            <span class="insight-amount">${g.coinsPerHour === null ? 'size unknown' : `up to about ${escape(number(g.coinsPerHour))} coins/h`}</span>
        </li>`).join('');
        const general = topic?.setupHash && snapshot?.setupHash && topic.setupHash === snapshot.setupHash ? '' :
            '<p class="hint small">The setup on screen is not the one from that snapshot, so only general reasons are listed.</p>';
        guessEl.innerHTML = `<h3 class="insight-heading">Possible reasons for ${escape(percent(latest.share))} of the plan</h3>
            <ul class="insight-guesses">${items}</ul>${general}`;
    }

    function render() {
        const snapshots = ctx.getHistory();
        const series = ctx.getCoinSeries();
        const list = intervals(snapshots, series);
        if (list.length === 0) {
            statusEl.textContent = EMPTY;
            renderTable([]);
            renderGuesses(null);
            return;
        }
        statusEl.textContent = `${list.length} ${list.length === 1 ? 'stretch' : 'stretches'} compared, newest last.`;
        renderTable(list);
        renderGuesses(list[list.length - 1], snapshots, series);
    }

    ctx.on('history', render);
    ctx.on('plan', render);
    // A cue to redraw only; the value is not used. undefined is the replay of a topic the page has
    // not published yet: no change.
    ctx.on('coins', (value) => {
        if (value !== undefined) render();
    });
}
