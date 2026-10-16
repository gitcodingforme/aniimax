// Streaks and milestones: pure helpers over the history snapshots and the watcher's coin series.
// Tested in tests/streaks.test.mjs. `toDay(date) -> 'YYYY-MM-DD'` is injectable so tests do not
// depend on the time zone; the default uses the local calendar date.
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function localDay(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dayNumber(day) {
    const [y, m, d] = String(day).split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function validSnapshots(snapshots) {
    return (Array.isArray(snapshots) ? snapshots : [])
        .filter(s => s && typeof s.id === 'string' && Number.isFinite(Date.parse(s.id)))
        .sort((a, b) => Date.parse(a.id) - Date.parse(b.id));
}

// Sorted, unique days on which at least one snapshot was saved.
export function snapshotDays(snapshots, toDay = localDay) {
    const days = new Set(validSnapshots(snapshots).map(s => toDay(new Date(s.id))));
    return [...days].sort();
}

// current: the run of consecutive days ending at the last day, kept only if that day is today or
// yesterday (otherwise 0). longest: the longest run ever. lastDay: the latest day or null.
export function streaks(days, today) {
    const list = [...new Set(Array.isArray(days) ? days : [])].sort();
    if (list.length === 0) return { current: 0, longest: 0, lastDay: null };
    let longest = 1, run = 1;
    for (let i = 1; i < list.length; i++) {
        run = dayNumber(list[i]) - dayNumber(list[i - 1]) === 1 ? run + 1 : 1;
        longest = Math.max(longest, run);
    }
    const lastDay = list[list.length - 1];
    const age = dayNumber(today) - dayNumber(lastDay);
    return { current: age === 0 || age === 1 ? run : 0, longest, lastDay };
}

// The first day each RV level was seen. A later lower RV (a restore) is ignored.
export function rvMilestones(snapshots, toDay = localDay) {
    const out = [];
    let top = 0;
    for (const s of validSnapshots(snapshots)) {
        const rv = s.actual?.rv;
        if (Number.isInteger(rv) && rv > top) {
            top = rv;
            out.push({ rv, day: toDay(new Date(s.id)) });
        }
    }
    return out;
}

// Best predicted coins/h (earliest snapshot wins a tie), best actual coins/h (the steepest rising
// stretch of at least one hour in the watcher series, dated by its end), and the highest RV seen.
export function personalBests(snapshots, coinSeries, toDay = localDay) {
    let predictedPerHour = null, highestRv = null;
    for (const s of validSnapshots(snapshots)) {
        const p = s.predicted?.coinsPerHour;
        if (Number.isFinite(p) && (!predictedPerHour || p > predictedPerHour.value)) {
            predictedPerHour = { value: p, day: toDay(new Date(s.id)) };
        }
        const rv = s.actual?.rv;
        if (Number.isInteger(rv) && (!highestRv || rv > highestRv.value)) {
            highestRv = { value: rv, day: toDay(new Date(s.id)) };
        }
    }
    const series = (Array.isArray(coinSeries) ? coinSeries : []).filter(p => Number.isFinite(p?.t) && Number.isFinite(p?.coins))
        .sort((a, b) => a.t - b.t);
    let actualPerHour = null;
    for (let i = 0; i < series.length; i++) {
        for (let j = i + 1; j < series.length; j++) {
            if (series[j].t - series[i].t < HOUR_MS) continue;
            const rate = (series[j].coins - series[i].coins) / ((series[j].t - series[i].t) / HOUR_MS);
            if (rate > 0 && (!actualPerHour || rate > actualPerHour.value)) {
                actualPerHour = { value: Math.round(rate), day: toDay(new Date(series[j].t)) };
            }
        }
    }
    return { predictedPerHour, actualPerHour, highestRv };
}

// Everything the card shows, in one object.
export function summarize(snapshots, coinSeries, today, toDay = localDay) {
    const days = snapshotDays(snapshots, toDay);
    return {
        streak: streaks(days, today),
        count: validSnapshots(snapshots).length,
        bests: personalBests(snapshots, coinSeries, toDay),
        milestones: rvMilestones(snapshots, toDay),
    };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const num = n => Math.round(n).toLocaleString('en-US');

export function chips(summary) {
    const { streak, count, bests } = summary;
    return [
        { label: 'Current streak', value: plural(streak.current, 'day') },
        { label: 'Longest streak', value: plural(streak.longest, 'day') },
        { label: 'Snapshots saved', value: String(count) },
        { label: 'Highest RV', value: bests.highestRv ? `RV ${bests.highestRv.value} (${bests.highestRv.day})` : 'none yet' },
        { label: 'Best predicted coins/h', value: bests.predictedPerHour ? `${num(bests.predictedPerHour.value)} (${bests.predictedPerHour.day})` : 'none yet' },
        { label: 'Best actual coins/h', value: bests.actualPerHour ? `${num(bests.actualPerHour.value)} (${bests.actualPerHour.day})` : 'none yet' },
    ];
}
