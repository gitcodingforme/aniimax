// Out-of-date check: asks the GitHub API when ae-bii/aniimax last changed each watched path and
// compares that with the upstream commit this build was made from (web/version.json, written by
// the deploy workflow). Three small unauthenticated requests (limit: 60 per hour per address),
// cached in localStorage for six hours; a failed check backs off for one hour. Offline, rate
// limited or a local build without a stamp: no banner, no error. Pure parts are tested in
// tests/upstream_check.test.mjs.
export const UPSTREAM_REPO = 'ae-bii/aniimax';
export const WATCHED_PATHS = ['data', 'web/facility-config.js', 'src/models.rs'];
export const CACHE_KEY = 'aniimax-upstream-check-v1';
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const FAILURE_TTL_MS = 60 * 60 * 1000;

// The watched paths upstream changed after the build's upstream commit, newest first.
export function newerUpstreamChanges(stamp, results) {
    const since = Date.parse(stamp?.upstream?.date);
    if (!Number.isFinite(since) || !Array.isArray(results)) return [];
    return results
        .filter(r => r && typeof r.path === 'string' && Number.isFinite(Date.parse(r.date)) && Date.parse(r.date) > since)
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

export function bannerText(stamp, newer) {
    const day = iso => String(iso).slice(0, 10);
    const names = newer.map(r => r.path.replace(/^(web|src)\//, '')).join(', ');
    return `Upstream changed game data on ${day(newer[0].date)} (${names}). This site's data is from ${day(stamp.upstream.date)}.`;
}

export async function fetchUpstreamChanges(fetchImpl = globalThis.fetch, paths = WATCHED_PATHS) {
    return Promise.all(paths.map(async path => {
        const url = `https://api.github.com/repos/${UPSTREAM_REPO}/commits?path=${encodeURIComponent(path)}&per_page=1`;
        const response = await fetchImpl(url);
        if (!response.ok) throw new Error(`GitHub API answered ${response.status} for ${path}`);
        const [commit] = await response.json();
        return { path, sha: String(commit?.sha || '').slice(0, 7), date: commit?.commit?.committer?.date || '' };
    }));
}

// Cached results if still fresh; `null` when a new check is due. A cached failure counts as fresh
// for FAILURE_TTL_MS and yields an empty list (no banner), so a rate-limited address is not hammered.
export function readCache(storage, now = Date.now()) {
    try {
        const cached = JSON.parse(storage.getItem(CACHE_KEY) || 'null');
        if (!cached || !Number.isFinite(cached.checkedAt)) return null;
        if (Array.isArray(cached.results)) return now - cached.checkedAt < CACHE_TTL_MS ? cached.results : null;
        return now - cached.checkedAt < FAILURE_TTL_MS ? [] : null;
    } catch (_) {
        return null;
    }
}

export function writeCache(storage, results, now = Date.now()) {
    try {
        storage.setItem(CACHE_KEY, JSON.stringify({ checkedAt: now, results: Array.isArray(results) ? results : null }));
    } catch (_) { /* storage may be unavailable; the check just runs again next time */ }
}

export function clearCache(storage) {
    try { storage.removeItem(CACHE_KEY); } catch (_) { /* same */ }
}
