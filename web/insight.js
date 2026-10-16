// "Why am I behind?": compares what the plan predicted with what actually happened between two
// snapshots, and guesses at the reasons. Pure functions only (no DOM, no storage); tested in
// tests/insight.test.mjs; web/cards/insight.js draws it. The app cannot see the game, so every
// reason here is a guess from the plan and from gaps in the watcher's readings, never a measurement.
import { batchesUntilFull, effectiveCycle, outputCap, pretty } from './reminders.js?v=fork-m10-1';
import { stripVariant } from './plan-summary.js?v=fork-m10-1';

export const MIN_INTERVAL_MINUTES = 30;
export const WATERING_LOSS = 0.25; // two waterings of an eighth of the grow time each
const HOUR_MS = 3_600_000;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 };

// "1h 20m", "45m", from seconds.
function span(seconds) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

// --- intervals ------------------------------------------------------------------

// Coins gained per hour inside [from, to] from the watcher's points, counting only the stretches
// where the balance rose; a stretch where it fell means coins were spent, so it is left out (its
// time too) and `spent` is set. `perHour` is null without half an hour of rising stretches.
function watcherRate(points, from, to) {
    const inside = points.filter(p => p.t >= from && p.t <= to);
    let gained = 0, riseMs = 0, spent = false;
    for (let i = 1; i < inside.length; i++) {
        const a = inside[i - 1], b = inside[i];
        if (b.coins >= a.coins) {
            gained += b.coins - a.coins;
            riseMs += b.t - a.t;
        } else {
            spent = true;
        }
    }
    return { spent, perHour: riseMs >= MIN_INTERVAL_MINUTES * 60_000 ? gained / (riseMs / HOUR_MS) : null };
}

// One row per pair of neighbouring snapshots where the first one carried a prediction:
// { from, to (snapshot ids), fromMs, toMs, hours, predictedPerHour, actualPerHour (null when the
// coins cannot be told), share (actual / predicted, null likewise), source: 'watcher' | 'snapshots',
// spent (coins were spent, so the actual figure is low or unknown) }. Intervals under 30 minutes
// and intervals with no coin figure at all are left out.
export function intervals(snapshots, series = []) {
    const list = (Array.isArray(snapshots) ? snapshots : [])
        .filter(s => s && typeof s.id === 'string' && Number.isFinite(Date.parse(s.id)))
        .sort((a, b) => a.id.localeCompare(b.id));
    const points = Array.isArray(series) ? series : [];
    const out = [];
    list.forEach((snap, i) => {
        const next = list[i + 1];
        const predictedPerHour = snap.predicted?.coinsPerHour;
        if (!next || !(predictedPerHour > 0)) return;
        const fromMs = Date.parse(snap.id), toMs = Date.parse(next.id);
        const hours = (toMs - fromMs) / HOUR_MS;
        if (hours * 60 < MIN_INTERVAL_MINUTES) return;
        const watcher = watcherRate(points, fromMs, toMs);
        let actualPerHour = watcher.perHour, source = 'watcher', spent = watcher.spent;
        if (actualPerHour === null) {
            source = 'snapshots';
            const a = snap.actual?.coins, b = next.actual?.coins;
            if (!finite(a) || !finite(b)) {
                if (!spent) return;
            } else if (b < a) {
                spent = true;
            } else {
                actualPerHour = (b - a) / hours;
            }
        }
        out.push({
            from: snap.id, to: next.id, fromMs, toMs, hours, predictedPerHour, actualPerHour,
            share: actualPerHour === null ? null : actualPerHour / predictedPerHour, source, spent,
        });
    });
    return out;
}

// Stretches of the watcher's series with no reading for at least `minMinutes`: INFERRED to mean
// the player was away from the game (or the watcher was off), as { from, to (ms), minutes }.
export function gaps(series, minMinutes = 20) {
    const out = [];
    const points = Array.isArray(series) ? series : [];
    for (let i = 1; i < points.length; i++) {
        const minutes = (points[i].t - points[i - 1].t) / 60_000;
        if (minutes >= minMinutes) out.push({ from: points[i - 1].t, to: points[i].t, minutes });
    }
    return out;
}

// The parts of `list` that fall inside [fromMs, toMs], cut to that window.
export function gapsWithin(list, fromMs, toMs) {
    return (list || []).map(g => {
        const from = Math.max(g.from, fromMs), to = Math.min(g.to, toMs);
        return { from, to, minutes: (to - from) / 60_000 };
    }).filter(g => g.minutes > 0);
}

// --- shares ------------------------------------------------------------------

// Each plan row's share (0 to 1) of the plan's income, as a Map keyed by row.key. From the plan's
// income_streams (what each sold item earns net of its ingredients) when it has any; ingredient
// rows with no stream of their own count as 0, because their value is already inside the product
// that uses them. Without streams, rows are prorated by how many batches they finish per second.
export function shareOfRate(rows, plan) {
    const result = plan?.plan ?? plan;
    const streams = (result?.income_streams || []).filter(s => s && s.rate_per_second > 0);
    const shares = new Map();
    const total = streams.reduce((sum, s) => sum + s.rate_per_second, 0);
    if (total > 0) {
        for (const row of rows || []) {
            const mine = streams.filter(s => String(s.item_name).replace(/__uncovered$/, '') === row.item && (!s.facility || s.facility === row.facility));
            shares.set(row.key, mine.reduce((sum, s) => sum + s.rate_per_second, 0) / total);
        }
        return shares;
    }
    const weight = row => (row.busy ?? row.count) / row.cycleSeconds;
    const sum = (rows || []).reduce((acc, row) => acc + weight(row), 0);
    for (const row of rows || []) shares.set(row.key, sum > 0 ? weight(row) / sum : 0);
    return shares;
}

// The share (0 to 1) of the plan's income that rides on each crop row because the crop is an
// ingredient of something the plan sells, as a Map keyed by row.key (crops that feed nothing are
// left out). A crop that only feeds a processor has no income stream of its own, so shareOfRate
// gives it 0 even though the product made from it pays for the crop's work. This walks `recipes`
// (the page's recipe index; `ingredients` is a list of item names) from each income stream down
// to the crop rows: a stream's income is split equally between its recipe's ingredients, an
// ingredient that a processor makes passes its part further down the same way, and a part that
// reaches an ingredient with no crop row in the plan (mined, bought, unknown) is dropped. Several
// rows of one crop share their part by facility count. The split is a guess: what a short crop
// really costs depends on which ingredient is scarcest. Without income_streams or without recipes
// there is nothing to follow and the Map is empty.
export function feederShares(rows, plan, recipes) {
    const shares = new Map();
    const result = plan?.plan ?? plan;
    const streams = (result?.income_streams || []).filter(s => s && s.rate_per_second > 0);
    const total = streams.reduce((sum, s) => sum + s.rate_per_second, 0);
    const index = Array.isArray(recipes) ? recipes.filter(r => r && typeof r.name === 'string') : [];
    if (!(total > 0) || index.length === 0) return shares;
    const crops = new Map(); // item name without variant suffixes -> its crop rows
    for (const row of Array.isArray(rows) ? rows : []) {
        if (row?.kind !== 'crop') continue;
        const name = stripVariant(row.item);
        crops.set(name, [...(crops.get(name) || []), row]);
    }
    if (crops.size === 0) return shares;
    const recipeOf = (name, facility) => index.find(r => r.name === name && r.facility === facility) || index.find(r => r.name === name) || null;
    const credit = (name, fraction) => {
        const makers = crops.get(name);
        const weight = row => (row.count > 0 ? row.count : 1);
        const weights = makers.reduce((sum, row) => sum + weight(row), 0);
        for (const row of makers) shares.set(row.key, (shares.get(row.key) || 0) + fraction * weight(row) / weights);
    };
    const spread = (name, facility, fraction, path) => {
        if (path.length > 8 || path.includes(name)) return;
        const recipe = recipeOf(name, facility);
        const parts = [...new Set((recipe?.ingredients || recipe?.raw_materials || []).filter(p => typeof p === 'string').map(stripVariant))];
        for (const part of parts) {
            if (crops.has(part)) credit(part, fraction / parts.length);
            else spread(part, null, fraction / parts.length, [...path, name]);
        }
    };
    for (const stream of streams) spread(stripVariant(stream.item_name), stream.facility, stream.rate_per_second / total, []);
    return shares;
}

// --- guesses ------------------------------------------------------------------

// Ranked guesses at why the pace fell short, as { cause, coinsPerHour (null when it cannot be
// sized), text, confidence: 'high' | 'medium' | 'low' }, biggest first. `plan` is the 'plan' topic
// value ({ plan, setupHash, tab }); `rows` are planRows() for it; `caps` is OUTPUT_CAPS; `gaps`
// are the watcher gaps inside the interval; `setup` and `snapshotHash` belong to the snapshot the
// interval started at; `hours` is the interval's length; `recipes` is the page's recipe index, which
// lets the watering guess count crops that only feed a processor (see feederShares). Row-level
// guesses need the plan's setup to be the snapshot's (same setupHash); otherwise only the general
// ones are given. Sizes are capped at the shortfall, since no single cause can explain more than
// was missing.
export function guesses({ plan = null, rows = [], caps = null, gaps: gapList = [], setup = null, shortfallPerHour = null, snapshotHash = null, hours = null, recipes = null } = {}) {
    const result = plan?.plan ?? null;
    const ratePerHour = finite(result?.rate_per_second) ? result.rate_per_second * 3600 : 0;
    const limit = finite(shortfallPerHour) && shortfallPerHour > 0 ? shortfallPerHour : Infinity;
    const size = value => Math.round(Math.min(Math.max(value, 0), limit));
    const sameSetup = !!plan && !!snapshotHash && plan.setupHash === snapshotHash;
    const rowLevel = sameSetup && ratePerHour > 0 && Array.isArray(rows) && rows.length > 0;
    const longest = (gapList || []).reduce((best, g) => (g.minutes > (best?.minutes ?? 0) ? g : best), null);
    const out = [];

    if (rowLevel) {
        const shares = shareOfRate(rows, plan);
        const perHour = row => (shares.get(row.key) || 0) * ratePerHour;

        if (longest) {
            const gapSeconds = longest.minutes * 60;
            const divisor = hours > 0 ? hours : gapSeconds / 3600;
            for (const row of rows) {
                const batches = batchesUntilFull(outputCap(caps, row.facility, row.level), row.yieldPerBatch);
                const fill = batches ? batches * effectiveCycle(row) : 0;
                if (!(fill > 0) || gapSeconds <= fill) continue;
                const lost = perHour(row) * (gapSeconds - fill) / 3600 / divisor;
                if (size(lost) < 1) continue;
                out.push({
                    cause: 'output-capped',
                    coinsPerHour: size(lost),
                    confidence: gapSeconds >= 2 * fill ? 'high' : 'medium',
                    text: `${pretty(row.item)} on ${row.count}× ${row.facility} stops when its store is full, about ${span(fill)} after a collection. `
                        + `There was a stretch of about ${span(gapSeconds)} with no readings, so it was probably full and idle for about ${span(gapSeconds - fill)}.`,
                });
            }
        }

        // Every crop row counts, including one that only feeds a processor: its own income is 0, but
        // the product made from it is paid for by its work (feederShares), so that income counts too.
        const crops = rows.filter(r => r.kind === 'crop');
        const feeding = feederShares(rows, plan, recipes);
        const cropIncome = crops.reduce((sum, r) => sum + perHour(r) + (feeding.get(r.key) || 0) * ratePerHour, 0);
        if (cropIncome > 0) {
            const feeders = crops.filter(r => (feeding.get(r.key) || 0) > 0 && (shares.get(r.key) || 0) === 0);
            out.push({
                cause: 'watering',
                coinsPerHour: size(cropIncome * WATERING_LOSS),
                confidence: (gapList || []).length > 0 ? 'medium' : 'low',
                text: `Crops (${crops.map(r => pretty(r.item)).join(', ')}) ask for water twice as they grow, and each watering takes an eighth off the grow time. `
                    + 'Missing both costs a quarter of their income; missing one costs about half of that.'
                    + (feeders.length > 0 ? ` ${feeders.map(r => pretty(r.item)).join(', ')} only feed other recipes, so the income of what they go into is counted too.` : ''),
            });
        }

        if (hours > 0) {
            const late = rows.filter(r => r.kind === 'processor' && r.leadSeconds > r.cycleSeconds);
            const lost = late.reduce((sum, r) => sum + perHour(r) * (r.leadSeconds - r.cycleSeconds) / 3600 / hours, 0);
            if (late.length > 0 && size(lost) >= 1) {
                out.push({
                    cause: 'lead-time',
                    coinsPerHour: size(lost),
                    confidence: 'medium',
                    text: `${late.map(r => pretty(r.item)).join(', ')} cannot start until the ingredients arrive, `
                        + `which delays the first batch by up to ${span(Math.max(...late.map(r => r.leadSeconds - r.cycleSeconds)))}. A short interval feels this the most.`,
                });
            }
        }
    }

    if (setup?.['aniimo-best'] || (sameSetup && plan.tab === 'best')) {
        out.push({
            cause: 'best-team',
            coinsPerHour: null,
            confidence: 'medium',
            text: 'The plan assumed the best possible Aniimo for every job. If your real team is weaker or busy elsewhere, you earn less than predicted.',
        });
    }
    out.push({
        cause: 'unsold',
        coinsPerHour: null,
        confidence: 'low',
        text: 'Coins only count when sold. Output sitting in storage, or kept for a level-up, is not in your balance yet.',
    });

    return out.sort((a, b) => {
        if ((a.coinsPerHour === null) !== (b.coinsPerHour === null)) return a.coinsPerHour === null ? 1 : -1;
        return (b.coinsPerHour ?? 0) - (a.coinsPerHour ?? 0) || CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    });
}
