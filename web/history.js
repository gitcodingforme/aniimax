// Progress history: dated snapshots of the setup plus what the plan predicted at the time, kept
// in the browser (aniimax-history-v1) with a backup file the player keeps. Pure functions only
// (no DOM, no storage), tested in tests/history.test.mjs; app.js wires buttons and storage.
export const HISTORY_FORMAT = 'aniimax-history';
export const HISTORY_VERSION = 1;
export const MAX_SNAPSHOTS = 300;
const MAX_FILE_BYTES = 20_000_000;
const MODULES = [
    ['ecological-module-level', 'Ecological Module'],
    ['kitchen-module-level', 'Kitchen Module'],
    ['resource-detector-level', 'Resource Detector'],
    ['crafting-module-level', 'Crafting Module'],
];

// --- helpers ---------------------------------------------------------------------------

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

// Fields that change how the plan is shown, not what it is; ignored by the hash and the diff.
export const DISPLAY_ONLY_KEYS = ['rate-unit', 'layout-sim-on', 'target-amount', 'current-amount'];

// Short, stable fingerprint of a setup (FNV-1a over its sorted JSON, display-only fields left
// out), so "did the setup change?" is one string comparison.
export function setupHash(setup) {
    const relevant = setup && typeof setup === 'object' && !Array.isArray(setup)
        ? Object.fromEntries(Object.entries(setup).filter(([key]) => !DISPLAY_ONLY_KEYS.includes(key)))
        : setup ?? null;
    const text = stableJson(relevant);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function isoOrEmpty(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function pretty(name) {
    return String(name ?? '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function formatSeconds(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '?';
    const total = Math.round(seconds);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    return `${minutes}m`;
}

// --- snapshots ---------------------------------------------------------------------------

// What the plan said, reduced to the few numbers worth keeping. `null` when there was no plan.
export function predictionFrom(plan, context) {
    if (!plan || plan.success === false || !Number.isFinite(plan.rate_per_second)) return null;
    const levelUp = plan.level_up && Number.isFinite(plan.level_up.seconds) && plan.level_up.seconds > 0 ? {
        target: finite(Number(context?.target)) ?? null,
        seconds: plan.level_up.seconds,
        requirements: (plan.level_up.requirements || []).map(r => ({
            name: String(r.name ?? ''), need: finite(r.need) ?? 0, have: finite(r.have) ?? 0, perSecond: finite(r.per_second) ?? 0,
        })),
    } : null;
    return {
        coinsPerHour: Math.round(plan.rate_per_second * 3600),
        strategy: context?.levelUp ? 'level_up' : 'priorities',
        levelUp,
        proven: plan.proven_optimal === true,
        fallback: plan.fallback_reason ? String(plan.fallback_reason) : null,
    };
}

export function makeSnapshot({ setup, actual = {}, predicted = null, site = {}, note = '', now = new Date() }) {
    if (!setup || typeof setup !== 'object' || Array.isArray(setup) || !setup.facilityTiers) {
        throw new Error('a snapshot needs the current setup');
    }
    const id = isoOrEmpty(now) || new Date().toISOString();
    const cleanActual = {};
    if (Number.isInteger(actual?.rv) && actual.rv >= 1) cleanActual.rv = actual.rv;
    if (Number.isFinite(actual?.coins) && actual.coins >= 0) cleanActual.coins = actual.coins;
    return {
        id,
        setup,
        setupHash: setupHash(setup),
        actual: cleanActual,
        note: typeof note === 'string' ? note.slice(0, 500) : '',
        predicted: predicted && typeof predicted === 'object' ? predicted : null,
        site: { appVersion: String(site?.appVersion ?? ''), dataVersion: String(site?.dataVersion ?? '') },
    };
}

export function isSnapshot(value) {
    return !!value && typeof value === 'object' && typeof value.id === 'string' && isoOrEmpty(value.id) !== ''
        && !!value.setup && typeof value.setup === 'object' && !!value.setup.facilityTiers;
}

// Keeps the list sorted by date, one entry per id (a newer save of the same id replaces the old one),
// and drops the oldest past MAX_SNAPSHOTS.
export function addSnapshots(list, incoming) {
    const byId = new Map((Array.isArray(list) ? list : []).filter(isSnapshot).map(s => [s.id, s]));
    for (const s of (Array.isArray(incoming) ? incoming : [incoming])) {
        if (isSnapshot(s)) byId.set(s.id, { ...s, setupHash: s.setupHash || setupHash(s.setup) });
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(-MAX_SNAPSHOTS);
}

// --- views ---------------------------------------------------------------------------

export function rvSeries(snapshots) {
    return snapshots.filter(s => Number.isInteger(s.actual?.rv)).map(s => ({ t: Date.parse(s.id), rv: s.actual.rv, id: s.id }));
}

// For every snapshot that predicted a level-up: how long the plan said, and how long it really took
// (time to the first later snapshot at a higher RV), if that has happened yet.
export function paceRows(snapshots) {
    const rows = [];
    snapshots.forEach((s, i) => {
        const levelUp = s.predicted?.levelUp;
        const rv = s.actual?.rv;
        if (!levelUp || !Number.isInteger(rv)) return;
        const reached = snapshots.slice(i + 1).find(later => Number.isInteger(later.actual?.rv) && later.actual.rv > rv);
        const actualSeconds = reached ? (Date.parse(reached.id) - Date.parse(s.id)) / 1000 : null;
        rows.push({
            from: s.id,
            rv,
            target: levelUp.target ?? rv + 1,
            predictedSeconds: levelUp.seconds,
            actualSeconds,
            reachedAt: reached ? reached.id : null,
            ratio: actualSeconds !== null && levelUp.seconds > 0 ? actualSeconds / levelUp.seconds : null,
        });
    });
    return rows;
}

function tiersText(tiers) {
    const parts = (Array.isArray(tiers) ? tiers : []).filter(t => Number(t?.count) > 0)
        .map(t => `${Number(t.count)}×Lv.${Number(t.level) || 1}`);
    return parts.length ? parts.join(' + ') : 'none';
}

function rosterText(entry) {
    const abilities = Object.entries(entry.abilities || {}).map(([a, l]) => `${a} ${l}`).join(', ');
    const personalities = (entry.personalities || []).filter(Boolean).join('/');
    return `${Number(entry.count) || 1}× ${abilities || 'no abilities'}${personalities ? ` (${personalities})` : ''}`;
}

// Plain-language differences between two setups, as { what, before, after }. Display-only fields
// (rate unit, goal amounts, layout animation) are ignored on purpose.
export function diffSetups(a, b) {
    const changes = [];
    const push = (what, before, after) => { if (String(before) !== String(after)) changes.push({ what, before: String(before), after: String(after) }); };
    const strategy = s => s['strategy-level-up'] ? `level up to RV ${s['level-up-target'] ?? '?'}` : 'priorities';
    const priorities = s => (s.priorities || []).filter(p => p?.on).map(p => pretty(p.target)).join(' > ') || 'none';
    const aniimoMode = s => s['aniimo-custom'] ? 'custom roster' : s['aniimo-minimum'] ? 'minimum team' : 'best Aniimo';

    push('RV level', a['home-level'] ?? '?', b['home-level'] ?? '?');
    push('Mode', a['mode-simple'] === false || a['mode-advanced'] ? 'advanced' : 'simple', b['mode-simple'] === false || b['mode-advanced'] ? 'advanced' : 'simple');
    push('Strategy', strategy(a), strategy(b));
    push('Priorities', priorities(a), priorities(b));
    for (const name of new Set([...Object.keys(a.facilityTiers || {}), ...Object.keys(b.facilityTiers || {})])) {
        push(name, tiersText(a.facilityTiers?.[name]), tiersText(b.facilityTiers?.[name]));
    }
    for (const [key, label] of MODULES) push(label, a[key] ?? '0', b[key] ?? '0');
    push('Aniimo', aniimoMode(a), aniimoMode(b));
    for (const ability of new Set([...Object.keys(a.aniimoLevels || {}), ...Object.keys(b.aniimoLevels || {})])) {
        push(`${ability} Aniimo level`, a.aniimoLevels?.[ability] ?? '-', b.aniimoLevels?.[ability] ?? '-');
    }
    const rosterA = new Map((a.roster || []).map((r, i) => [r.name || `Aniimo ${i + 1}`, r]));
    const rosterB = new Map((b.roster || []).map((r, i) => [r.name || `Aniimo ${i + 1}`, r]));
    for (const name of new Set([...rosterA.keys(), ...rosterB.keys()])) {
        push(`Roster: ${name}`, rosterA.has(name) ? rosterText(rosterA.get(name)) : 'absent', rosterB.has(name) ? rosterText(rosterB.get(name)) : 'absent');
    }
    for (const item of new Set([...Object.keys(a.levelUpStock || {}), ...Object.keys(b.levelUpStock || {})])) {
        push(`Stock: ${pretty(item)}`, a.levelUpStock?.[item] ?? 0, b.levelUpStock?.[item] ?? 0);
    }
    const listDiff = (what, before, after) => {
        const was = new Set(before || []), now = new Set(after || []);
        const added = [...now].filter(x => !was.has(x)).map(pretty), removed = [...was].filter(x => !now.has(x)).map(pretty);
        if (added.length) changes.push({ what, before: '', after: `added ${added.join(', ')}` });
        if (removed.length) changes.push({ what, before: '', after: `removed ${removed.join(', ')}` });
    };
    listDiff('Skipped recipes', a.skippedRecipes, b.skippedRecipes);
    listDiff('Unlocked special recipes', a.unlockedSpecial, b.unlockedSpecial);
    push('Season', a['season-on'] ? `on, ${a['season-currency-per-day'] ?? '?'}/day` : 'off', b['season-on'] ? `on, ${b['season-currency-per-day'] ?? '?'}/day` : 'off');
    return changes;
}

// A small step chart of RV level over time, as an SVG string using the page's CSS colors.
export function rvChartSvg(points, { width = 600, height = 160 } = {}) {
    if (points.length === 0) return '';
    const pad = { left: 36, right: 12, top: 12, bottom: 24 };
    const t0 = points[0].t, t1 = Math.max(points[points.length - 1].t, t0 + 1);
    const rvMin = Math.max(1, Math.min(...points.map(p => p.rv)) - 1);
    const rvMax = Math.max(...points.map(p => p.rv)) + 1;
    const x = t => pad.left + (t - t0) / (t1 - t0) * (width - pad.left - pad.right);
    const y = rv => pad.top + (rvMax - rv) / (rvMax - rvMin) * (height - pad.top - pad.bottom);
    const path = points.map((p, i) => (i === 0 ? `M${x(p.t).toFixed(1)},${y(p.rv).toFixed(1)}`
        : `H${x(p.t).toFixed(1)} V${y(p.rv).toFixed(1)}`)).join(' ') + ` H${(width - pad.right).toFixed(1)}`;
    const ticks = [];
    for (let rv = rvMin; rv <= rvMax; rv++) {
        ticks.push(`<text x="${pad.left - 6}" y="${(y(rv) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--text-muted)">${rv}</text>`
            + `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(rv).toFixed(1)}" y2="${y(rv).toFixed(1)}" stroke="var(--border)" stroke-width="0.5" />`);
    }
    const day = t => new Date(t).toISOString().slice(0, 10);
    const dots = points.map(p => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.rv).toFixed(1)}" r="3" fill="var(--accent)"><title>RV ${p.rv} on ${day(p.t)}</title></circle>`).join('');
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="RV level over time" class="history-chart-svg">${ticks.join('')}`
        + `<path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" />${dots}`
        + `<text x="${pad.left}" y="${height - 6}" font-size="10" fill="var(--text-muted)">${day(t0)}</text>`
        + `<text x="${width - pad.right}" y="${height - 6}" font-size="10" text-anchor="end" fill="var(--text-muted)">${day(t1)}</text></svg>`;
}

// --- Home Coins over time (points logged by scripts/watch_game.py into coins.json) -------------

// The watcher's points as [{t: ms, coins}], oldest first, one per time (the later reading wins),
// bad entries dropped.
export function coinSeries(points) {
    const byTime = new Map();
    for (const p of Array.isArray(points) ? points : []) {
        const t = typeof p?.t === 'string' ? Date.parse(p.t) : NaN;
        if (!Number.isFinite(t) || !Number.isInteger(p.coins) || p.coins < 0) continue;
        byTime.set(t, p.coins);
    }
    return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, coins]) => ({ t, coins }));
}

// The straight line the latest snapshot with a coins/hour prediction implies: it starts where that
// snapshot was taken, at the coins the snapshot recorded, or else at the last logged point before
// the snapshot (the balance as last seen), or else the first logged point after it, and rises by
// coinsPerHour. Null when there is no such snapshot or no anchor at all.
export function predictedCoinLine(snapshots, series) {
    const list = (Array.isArray(snapshots) ? snapshots : []).filter(s => Number.isFinite(s?.predicted?.coinsPerHour));
    if (list.length === 0) return null;
    const latest = [...list].sort((a, b) => a.id.localeCompare(b.id))[list.length - 1];
    const from = Date.parse(latest.id);
    if (!Number.isFinite(from)) return null;
    const perHour = latest.predicted.coinsPerHour;
    if (Number.isFinite(latest.actual?.coins)) return { from, coins: latest.actual.coins, perHour };
    const points = series || [];
    const before = [...points].reverse().find(p => p.t <= from);
    if (before) return { from: before.t, coins: before.coins, perHour };
    const next = points.find(p => p.t >= from);
    return next ? { from: next.t, coins: next.coins, perHour } : null;
}

// 220000 -> "220k", 1250000 -> "1.25M", 950 -> "950".
export function compactNumber(n) {
    const trim = (value, digits) => String(Number(value.toFixed(digits)));
    const abs = Math.abs(n);
    if (abs >= 1e9) return `${trim(n / 1e9, 2)}B`;
    if (abs >= 1e6) return `${trim(n / 1e6, 2)}M`;
    if (abs >= 1e3) return `${trim(n / 1e3, 1)}k`;
    return String(Math.round(n));
}

// Round-number axis ticks: 1, 2 or 5 times a power of ten, 3 to 5 of them, covering [min, max].
export function niceTicks(min, max) {
    if (!(max > min)) { const widen = Math.max(1, Math.abs(min) * 0.01); min -= widen; max += widen; }
    min = Math.max(0, min);
    const raw = (max - min) / 3;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    let step = magnitude;
    for (const factor of [1, 2, 5, 10]) {
        step = factor * magnitude;
        if (Math.ceil(max / step) - Math.floor(min / step) <= 4) break;
    }
    const ticks = [];
    for (let v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + step / 1e6; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return ticks;
}

// Actual coins as a line with dots, and the prediction as a dashed line from its anchor to the
// right edge. A single series needs no legend; with the prediction there are two, so a key shows.
// Colours are the page's own tokens: the accent for what happened, the muted ink for the plan.
export function coinChartSvg(series, line, { width = 600, height = 160 } = {}) {
    if (!Array.isArray(series) || series.length === 0) return '';
    const legend = !!line;
    const pad = { left: 46, right: 12, top: legend ? 26 : 12, bottom: 24 };
    const t0 = Math.min(series[0].t, line ? line.from : Infinity);
    // The right edge reaches an hour past the last point and past the plan line's anchor, so a
    // snapshot taken after the watcher's last reading still gets a visible dashed line.
    const t1 = Math.max(series[series.length - 1].t, line ? line.from : -Infinity, t0) + 3_600_000;
    const predictedAt = t => line.coins + line.perHour * (t - line.from) / 3_600_000;
    const values = series.map(p => p.coins);
    if (line) values.push(line.coins, predictedAt(t1));
    const ticks = niceTicks(Math.min(...values), Math.max(...values));
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    const x = t => pad.left + (t - t0) / (t1 - t0) * (width - pad.left - pad.right);
    const y = v => pad.top + (hi - v) / (hi - lo) * (height - pad.top - pad.bottom);
    const f = n => n.toFixed(1);
    const grid = ticks.map(v => `<line x1="${pad.left}" x2="${width - pad.right}" y1="${f(y(v))}" y2="${f(y(v))}" stroke="var(--border)" stroke-width="1" />`
        + `<text x="${pad.left - 6}" y="${f(y(v) + 3)}" text-anchor="end" font-size="10" fill="var(--text-muted)">${compactNumber(v)}</text>`).join('');
    const pad2 = n => String(n).padStart(2, '0');
    const spanShort = t1 - t0 < 2 * 86_400_000;
    const label = t => {
        const d = new Date(t);
        const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        return spanShort ? `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : date;
    };
    const path = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${f(x(p.t))},${f(y(p.coins))}`).join(' ');
    // Dots on every reading while there are few; with many only the latest, so the line stays readable.
    const dotted = series.length <= 40 ? series : [series[series.length - 1]];
    const dots = dotted.map(p => `<g><circle cx="${f(x(p.t))}" cy="${f(y(p.coins))}" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2" />`
        + `<circle cx="${f(x(p.t))}" cy="${f(y(p.coins))}" r="10" fill="transparent"><title>${p.coins.toLocaleString('en-US')} coins, ${label(p.t)}</title></circle></g>`).join('');
    const dashed = line
        ? `<path d="M${f(x(line.from))},${f(y(line.coins))} L${f(x(t1))},${f(y(predictedAt(t1)))}" fill="none" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" stroke-dasharray="6 5" />`
        : '';
    const key = legend
        ? `<line x1="${pad.left}" x2="${pad.left + 18}" y1="10" y2="10" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" />`
            + `<text x="${pad.left + 24}" y="13" font-size="10" fill="var(--text-muted)">Actual (watcher)</text>`
            + `<line x1="${pad.left + 118}" x2="${pad.left + 136}" y1="10" y2="10" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" stroke-dasharray="6 5" />`
            + `<text x="${pad.left + 142}" y="13" font-size="10" fill="var(--text-muted)">Plan predicted (${compactNumber(line.perHour)}/h)</text>`
        : '';
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Home Coins over time" class="history-chart-svg">${grid}${key}`
        + `${dashed}<path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />${dots}`
        + `<text x="${pad.left}" y="${height - 6}" font-size="10" fill="var(--text-muted)">${label(t0)}</text>`
        + `<text x="${width - pad.right}" y="${height - 6}" font-size="10" text-anchor="end" fill="var(--text-muted)">${label(t1)}</text></svg>`;
}

// --- backup file ---------------------------------------------------------------------------

export function historyFile(snapshots, site = {}, now = new Date()) {
    return {
        format: HISTORY_FORMAT,
        version: HISTORY_VERSION,
        savedAt: isoOrEmpty(now) || new Date().toISOString(),
        site: { appVersion: String(site?.appVersion ?? ''), dataVersion: String(site?.dataVersion ?? '') },
        snapshots: addSnapshots([], snapshots),
    };
}

export function parseHistoryFile(content) {
    if (typeof content !== 'string') throw new Error('this is not a text file');
    if (content.length > MAX_FILE_BYTES) throw new Error('this file is too large to be a history backup');
    let data;
    try {
        data = JSON.parse(content);
    } catch (_) {
        throw new Error('this file is not valid JSON');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.format !== HISTORY_FORMAT) {
        throw new Error('this file is not an Aniimax history backup');
    }
    if (!Number.isInteger(data.version) || data.version < 1) throw new Error('this backup has no valid version number');
    if (data.version > HISTORY_VERSION) throw new Error(`this backup is version ${data.version}; this site reads up to version ${HISTORY_VERSION}`);
    if (!Array.isArray(data.snapshots)) throw new Error('this backup has no snapshots in it');
    const snapshots = data.snapshots.filter(isSnapshot);
    if (snapshots.length === 0 && data.snapshots.length > 0) throw new Error('none of the snapshots in this backup are readable');
    return addSnapshots([], snapshots);
}

export function historyFilename(now = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `aniimax-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.history.json`;
}
