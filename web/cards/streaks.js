// "Streaks and milestones" card: snapshot streaks, first day of each RV level, personal bests.
// Reads the history through ctx; stores nothing.
import { chips, localDay, summarize } from '../streaks.js?v=fork-m9-2';

const MAX_MILESTONES = 8;

export function mount(el, ctx) {
    ctx.addStylesheet('css/streaks.css');
    const esc = ctx.format.escape;
    el.innerHTML = '<h2>Streaks and milestones</h2><div id="streaks-body"></div>';
    const body = el.querySelector('#streaks-body');

    function render() {
        const snapshots = ctx.getHistory() || [];
        if (snapshots.length === 0) {
            body.innerHTML = '<p class="streaks-empty">Save a snapshot to start a streak</p>';
            return;
        }
        const summary = summarize(snapshots, ctx.getCoinSeries() || [], localDay(new Date()));
        const chipHtml = chips(summary)
            .map(c => `<span class="chip"><strong>${esc(c.label)}:</strong> ${esc(c.value)}</span>`).join('');
        const recent = summary.milestones.slice(-MAX_MILESTONES).reverse();
        const list = recent.length
            ? `<h3>RV milestones</h3><ul class="streaks-milestones">${recent
                .map(m => `<li><span>RV ${esc(m.rv)}</span><span class="streaks-day">${esc(m.day)}</span></li>`).join('')}</ul>`
            : '';
        body.innerHTML = `<div class="feature-chips">${chipHtml}</div>${list}`;
    }

    ctx.on('history', render);
}
