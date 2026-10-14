import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CACHE_KEY, bannerText, clearCache, fetchUpstreamChanges, newerUpstreamChanges, readCache, writeCache,
} from '../web/upstream-check.js';

const stamp = { appVersion: '0.17.1', commit: 'eeeed69', upstream: { commit: '174655c', date: '2026-10-11T19:43:59-04:00' } };

test('test_newer_upstream_changes_compares_dates_against_the_stamp', () => {
    const results = [
        { path: 'data', sha: '660990d', date: '2026-09-29T16:05:07Z' },
        { path: 'web/facility-config.js', sha: 'abc1234', date: '2026-10-20T08:00:00Z' },
        { path: 'src/models.rs', sha: 'def5678', date: '2026-10-25T08:00:00Z' },
    ];
    const newer = newerUpstreamChanges(stamp, results);
    assert.deepEqual(newer.map(r => r.path), ['src/models.rs', 'web/facility-config.js']);
    assert.equal(bannerText(stamp, newer),
        "Upstream changed game data on 2026-10-25 (models.rs, facility-config.js). This site's data is from 2026-10-11.");
    assert.deepEqual(newerUpstreamChanges(stamp, [results[0]]), []);
    assert.deepEqual(newerUpstreamChanges(null, results), []);
    assert.deepEqual(newerUpstreamChanges({ upstream: { date: 'soon' } }, results), []);
    assert.deepEqual(newerUpstreamChanges(stamp, [{ path: 'data', date: 'garbage' }, null]), []);
});

test('test_fetch_upstream_changes_reads_the_commits_api', async () => {
    const calls = [];
    const fetchImpl = async url => {
        calls.push(url);
        return { ok: true, json: async () => [{ sha: 'abcdef0123456', commit: { committer: { date: '2026-10-20T08:00:00Z' } } }] };
    };
    const results = await fetchUpstreamChanges(fetchImpl, ['data', 'web/facility-config.js']);
    assert.deepEqual(results, [
        { path: 'data', sha: 'abcdef0', date: '2026-10-20T08:00:00Z' },
        { path: 'web/facility-config.js', sha: 'abcdef0', date: '2026-10-20T08:00:00Z' },
    ]);
    assert.deepEqual(calls, [
        'https://api.github.com/repos/ae-bii/aniimax/commits?path=data&per_page=1',
        'https://api.github.com/repos/ae-bii/aniimax/commits?path=web%2Ffacility-config.js&per_page=1',
    ]);
    await assert.rejects(fetchUpstreamChanges(async () => ({ ok: false, status: 403 }), ['data']), /403/);
    const empty = await fetchUpstreamChanges(async () => ({ ok: true, json: async () => [] }), ['data']);
    assert.deepEqual(empty, [{ path: 'data', sha: '', date: '' }]);
});

test('test_cache_expires_after_six_hours_and_backs_off_after_a_failure', () => {
    const store = new Map();
    const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
    const results = [{ path: 'data', sha: 'a', date: '2026-10-20T08:00:00Z' }];
    const t0 = Date.parse('2026-10-21T00:00:00Z');
    assert.equal(readCache(storage, t0), null);
    writeCache(storage, results, t0);
    assert.deepEqual(readCache(storage, t0 + 5 * 3600 * 1000), results);
    assert.equal(readCache(storage, t0 + 7 * 3600 * 1000), null);
    writeCache(storage, null, t0);
    assert.deepEqual(readCache(storage, t0 + 30 * 60 * 1000), []);
    assert.equal(readCache(storage, t0 + 61 * 60 * 1000), null);
    clearCache(storage);
    assert.equal(store.has(CACHE_KEY), false);
    store.set(CACHE_KEY, '{broken');
    assert.equal(readCache(storage, t0), null);
    const broken = { getItem() { throw new Error('no storage'); }, setItem() { throw new Error('no storage'); }, removeItem() { throw new Error('no storage'); } };
    assert.equal(readCache(broken), null);
    writeCache(broken, results);
    clearCache(broken);
});
