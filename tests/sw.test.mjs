// Tests for web/sw.js, the offline service worker. The file is a classic browser script, so it is
// run here with vm.runInNewContext and fake versions of what a browser gives a service worker:
// `caches`, `fetch`, `clients`, `registration`, `skipWaiting` and the event listeners.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { isLocalHost as registerIsLocalHost } from '../web/sw-register.js';

const SOURCE = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://gitcodingforme.github.io/aniimax/';
// A local development server: the worker's scope is the whole origin, and there is no version.json.
const LOCAL = 'http://localhost:8080/';
const MATHJAX = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js';

// Objects made inside the vm have another realm's prototypes; compare them as plain JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

function fakeResponse(body, { ok = true, status = ok ? 200 : 404, type = 'basic', redirected = false } = {}) {
    return {
        body, ok, status, type, redirected,
        clone() { return fakeResponse(body, { ok, status, type, redirected }); },
        async json() { return JSON.parse(body); },
        async text() { return body; },
    };
}
const stamp = (commit) => fakeResponse(JSON.stringify({ appVersion: '0.17.1', commit, builtAt: '2026-10-15T00:00:00Z' }));

function fakeCaches() {
    const stores = new Map();
    const log = [];
    return {
        stores,
        log,
        async open(name) {
            if (!stores.has(name)) stores.set(name, new Map());
            const entries = stores.get(name);
            return {
                async match(key) { return entries.get(String(key)); },
                async put(key, response) {
                    log.push(`put ${name} ${String(key).replace(SCOPE, '')} ${response.body}`);
                    entries.set(String(key), response);
                },
            };
        },
        async keys() { return [...stores.keys()]; },
        async delete(name) {
            log.push(`delete ${name}`);
            return stores.delete(name);
        },
    };
}

function fakeClient(url, { controlled = true } = {}) {
    return {
        url, type: 'window', controlled, messages: [], navigated: [],
        postMessage(message) { this.messages.push(plain(message)); },
        async navigate(to) { this.navigated.push(to); },
    };
}

// Loads sw.js into a fresh fake service worker global. `routes` maps full URLs to responses (or
// to functions returning one); anything else answers 404. `env.offline = true` makes fetch fail.
// `scope` is the site folder the worker looks after (the published site unless a test says local).
function loadWorker({ source = SOURCE, routes = {}, clients = [], caches = fakeCaches(), cachesGetter = null, scope = SCOPE } = {}) {
    const env = { listeners: {}, routes, clients, caches, fetched: [], offline: false, claimed: 0, skipped: 0, unregistered: 0 };
    const context = {
        console, URL, Response, setTimeout, clearTimeout,
        addEventListener: (type, listener) => { env.listeners[type] = listener; },
        registration: { scope, unregister: async () => { env.unregistered += 1; return true; } },
        skipWaiting: async () => { env.skipped += 1; },
        clients: {
            matchAll: async ({ includeUncontrolled = false } = {}) => env.clients.filter((c) => includeUncontrolled || c.controlled),
            claim: async () => { env.claimed += 1; },
        },
        fetch: async (input, init) => {
            const url = typeof input === 'string' ? input : input.url;
            env.fetched.push({ url, init: init ? plain(init) : undefined });
            if (env.offline) throw new TypeError('Failed to fetch');
            const answer = env.routes[url];
            if (answer === undefined) return fakeResponse('missing', { ok: false, status: 404 });
            if (typeof answer === 'function') return answer(url);
            return answer.clone();
        },
    };
    if (cachesGetter) Object.defineProperty(context, 'caches', { get: cachesGetter });
    else context.caches = caches;
    context.self = context;
    vm.runInNewContext(source, context);
    env.SW = context.SW;
    env.SW.NETWORK_TIMEOUT_MS = 30;
    return env;
}

const get = (path, extra = {}) => ({
    method: 'GET', url: new URL(path, SCOPE).href, mode: 'cors', destination: '', cache: 'default',
    headers: { get: () => null }, ...extra,
});
const navigation = (path = './') => get(path, { mode: 'navigate', destination: 'document', headers: { get: () => 'text/html' } });

// Awaits every waitUntil promise, including ones added while waiting.
async function settle(pending) {
    for (let i = 0; i < pending.length; i += 1) await pending[i];
}

async function fetchEvent(env, request) {
    const pending = [];
    let answer = null;
    env.listeners.fetch({
        request,
        resultingClientId: 'new-page',
        respondWith(promise) { answer = Promise.resolve(promise); },
        waitUntil(promise) { pending.push(Promise.resolve(promise)); },
    });
    const response = answer ? await answer : null;
    await settle(pending);
    return { responded: answer !== null, response };
}

async function lifecycle(env, type, data) {
    const pending = [];
    env.listeners[type]({ data, waitUntil(promise) { pending.push(Promise.resolve(promise)); } });
    await settle(pending);
}

const cacheNames = (env) => [...env.caches.stores.keys()];
const cached = (env, name, path) => env.caches.stores.get(name)?.get(new URL(path, SCOPE).href);

test('test_route_for_sends_each_kind_of_request_to_its_route', () => {
    const { SW } = loadWorker();
    const route = (path, extra) => SW.routeFor(get(path, extra), SCOPE);

    assert.equal(SW.routeFor(navigation(), SCOPE), 'network-first');
    for (const path of [
        'index.html', '?sw=on', 'version.json', 'locales/en.json', 'structure-overrides.json',
        'worker.js?load=1760000000000', 'layout-worker.js?load=1', 'layout.js?load=1',
        'pkg/aniimax.js?load=1', 'pkg/aniimax_bg.wasm',
    ]) assert.equal(route(path), 'network-first', path);

    for (const path of [
        'app.js?v=fork-m10-2', 'i18n.js', 'style.css', 'vendor/highs/highs.mjs', 'vendor/highs/highs.wasm',
        'icons/icon-192.png', 'manifest.webmanifest', 'sw-register.js?v=fork-m10-2',
    ]) assert.equal(route(path), 'swr', path);

    assert.equal(route('version.json', { method: 'POST' }), 'bypass');
    assert.equal(route('structure-overrides.json', { cache: 'no-store' }), 'bypass');
    for (const path of ['reading.json', 'coins.json', 'verification.json', 'reading.json?t=5', 'sw.js']) {
        assert.equal(route(path), 'bypass', path);
    }
    for (const url of [
        MATHJAX, 'https://api.github.com/repos/ae-bii/aniimax/commits?path=data', 'https://ntfy.sh/my-topic',
        'https://gitcodingforme.github.io/another-site/app.js',
    ]) assert.equal(route(url), 'bypass', url);

    // The local server's scope is the whole origin.
    const local = { ...get('app.js'), url: 'http://localhost:8080/app.js?v=1' };
    assert.equal(SW.routeFor(local, 'http://localhost:8080/'), 'swr');
    assert.equal(SW.routeFor({ ...local, url: 'http://localhost:8080/reading.json' }, 'http://localhost:8080/'), 'bypass');
});

test('test_cache_key_strips_load_and_keeps_v', () => {
    const { SW } = loadWorker();
    assert.equal(SW.cacheKey(`${SCOPE}worker.js?load=1760000000000`), `${SCOPE}worker.js`);
    assert.equal(SW.cacheKey(`${SCOPE}pkg/aniimax.js?load=1&v=2`), `${SCOPE}pkg/aniimax.js?v=2`);
    assert.equal(SW.cacheKey(`${SCOPE}app.js?v=fork-m10-2`), `${SCOPE}app.js?v=fork-m10-2`);
    assert.equal(SW.cacheKey(`${SCOPE}a.js?v=1&load=2&x=a%20b#frag`), `${SCOPE}a.js?v=1&x=a%20b`);
    assert.equal(SW.pageKey(`${SCOPE}index.html?sw=on#config=abc`), SCOPE);
    assert.equal(SW.keyFor(navigation('./?nosw'), SCOPE), SCOPE);
});

test('test_worker_urls_with_different_load_tags_share_one_saved_copy', async () => {
    const env = loadWorker({
        routes: {
            [`${SCOPE}version.json`]: stamp('aaa1111'),
            [`${SCOPE}pkg/aniimax.js?load=1`]: fakeResponse('solver js'),
        },
    });
    await lifecycle(env, 'install');
    const first = await fetchEvent(env, get('pkg/aniimax.js?load=1'));
    assert.equal(first.response.body, 'solver js');
    const solverKeys = () => [...env.caches.stores.get('aniimax-aaa1111').keys()].filter((key) => !key.endsWith('version.json'));
    assert.deepEqual(solverKeys(), [`${SCOPE}pkg/aniimax.js`]);

    env.offline = true;
    const second = await fetchEvent(env, get('pkg/aniimax.js?load=2'));
    assert.equal(second.response.body, 'solver js');
    assert.deepEqual(solverKeys(), [`${SCOPE}pkg/aniimax.js`]);
});

test('test_stale_while_revalidate_answers_from_cache_and_refreshes_it', async () => {
    // A dev stamp: on the published scope a missing version.json no longer verifies the cache.
    const env = loadWorker({ routes: { [`${SCOPE}version.json`]: stamp('dev'), [`${SCOPE}style.css`]: fakeResponse('old css') } });
    await lifecycle(env, 'install');
    assert.deepEqual(cacheNames(env), ['aniimax-dev']);

    assert.equal((await fetchEvent(env, get('style.css'))).response.body, 'old css');
    env.routes[`${SCOPE}style.css`] = fakeResponse('new css');
    const again = await fetchEvent(env, get('style.css'));
    assert.equal(again.response.body, 'old css');
    assert.equal(cached(env, 'aniimax-dev', 'style.css').body, 'new css');

    env.offline = true;
    assert.equal((await fetchEvent(env, get('style.css'))).response.body, 'new css');
    assert.equal((await fetchEvent(env, get('never-seen.css'))).response.type, 'error');
});

test('test_network_first_falls_back_to_the_cache_on_timeout_and_offline', async () => {
    const env = loadWorker({ routes: { [`${SCOPE}version.json`]: stamp('dev'), [`${SCOPE}locales/en.json`]: fakeResponse('{"v":1}') } });
    await lifecycle(env, 'install');
    assert.equal((await fetchEvent(env, get('locales/en.json'))).response.body, '{"v":1}');

    // Slower than the timeout: the saved copy answers, and the late network answer refreshes it.
    env.routes[`${SCOPE}locales/en.json`] = () => new Promise((resolve) => setTimeout(() => resolve(fakeResponse('{"v":2}')), 120));
    const slow = await fetchEvent(env, get('locales/en.json'));
    assert.equal(slow.response.body, '{"v":1}');
    assert.equal(cached(env, 'aniimax-dev', 'locales/en.json').body, '{"v":2}');

    // Slow with nothing saved: it keeps waiting for the network.
    env.routes[`${SCOPE}locales/ru.json`] = () => new Promise((resolve) => setTimeout(() => resolve(fakeResponse('{"ru":1}')), 80));
    assert.equal((await fetchEvent(env, get('locales/ru.json'))).response.body, '{"ru":1}');

    env.offline = true;
    assert.equal((await fetchEvent(env, get('locales/en.json'))).response.body, '{"v":2}');
    assert.equal((await fetchEvent(env, get('locales/zh-TW.json'))).response.type, 'error');
});

test('test_solver_files_wait_for_a_slow_network_and_use_the_cache_only_when_it_fails', async () => {
    const env = loadWorker({
        routes: {
            [`${SCOPE}version.json`]: stamp('dev'),
            [`${SCOPE}worker.js?load=1`]: fakeResponse('worker A'),
            [`${SCOPE}pkg/aniimax_bg.wasm`]: fakeResponse('wasm A'),
            [`${SCOPE}layout.js?load=1`]: fakeResponse('layout A'),
        },
    });
    await lifecycle(env, 'install');
    for (const path of ['worker.js?load=1', 'pkg/aniimax_bg.wasm', 'layout.js?load=1']) await fetchEvent(env, get(path));

    // Slower than the 30 ms test timeout: the new build still wins, never the saved old copy.
    const slow = (body) => () => new Promise((resolve) => setTimeout(() => resolve(fakeResponse(body)), 90));
    env.routes[`${SCOPE}worker.js?load=2`] = slow('worker B');
    env.routes[`${SCOPE}pkg/aniimax_bg.wasm`] = slow('wasm B');
    env.routes[`${SCOPE}layout.js?load=2`] = slow('layout B');
    assert.equal((await fetchEvent(env, get('worker.js?load=2'))).response.body, 'worker B');
    assert.equal((await fetchEvent(env, get('pkg/aniimax_bg.wasm'))).response.body, 'wasm B');
    assert.equal((await fetchEvent(env, get('layout.js?load=2'))).response.body, 'layout B');

    // A real network failure does use the saved copy.
    env.offline = true;
    assert.equal((await fetchEvent(env, get('pkg/aniimax_bg.wasm'))).response.body, 'wasm B');
    assert.equal((await fetchEvent(env, get('worker.js?load=3'))).response.body, 'worker B');
});

test('test_a_worker_start_checks_the_version_before_saving_the_solver', async () => {
    // A tab opened before a deploy (no navigation since) clicks Solve after it.
    const tab = fakeClient(SCOPE);
    const env = loadWorker({
        clients: [tab],
        routes: {
            [`${SCOPE}version.json`]: stamp('aaa1111'),
            [`${SCOPE}worker.js?load=1`]: fakeResponse('worker A'),
        },
    });
    await lifecycle(env, 'install');
    await fetchEvent(env, get('worker.js?load=1'));
    assert.equal(cached(env, 'aniimax-aaa1111', 'worker.js').body, 'worker A');

    env.routes[`${SCOPE}version.json`] = stamp('bbb2222');
    env.routes[`${SCOPE}worker.js?load=1`] = fakeResponse('worker B');
    env.routes[`${SCOPE}pkg/aniimax.js?load=1`] = fakeResponse('js B');
    const versionFetches = () => env.fetched.filter((call) => call.url === `${SCOPE}version.json`).length;
    const before = versionFetches();
    await Promise.all([fetchEvent(env, get('worker.js?load=1')), fetchEvent(env, get('layout-worker.js?load=1'))]);
    assert.equal(versionFetches() - before, 1, 'two worker starts at once share one check');
    await fetchEvent(env, get('pkg/aniimax.js?load=1'));
    assert.deepEqual(cacheNames(env), ['aniimax-bbb2222']);
    assert.equal(cached(env, 'aniimax-bbb2222', 'worker.js').body, 'worker B');
    assert.equal(cached(env, 'aniimax-bbb2222', 'pkg/aniimax.js').body, 'js B');
    assert.deepEqual(tab.messages, [{ type: 'aniimax-updated', commit: 'bbb2222' }]);

    // Other files do not start a check.
    const now = versionFetches();
    await fetchEvent(env, get('pkg/aniimax.js?load=2'));
    await fetchEvent(env, get('style.css'));
    assert.equal(versionFetches(), now);
});

test('test_nothing_is_saved_before_a_version_check_succeeds', async () => {
    // A cache left by an earlier run of the worker, then a fresh worker whose checks fail.
    const caches = fakeCaches();
    const old = await caches.open('aniimax-aaa1111');
    await old.put(`${SCOPE}style.css`, fakeResponse('old css'));
    caches.log.length = 0;
    const slowVersion = () => new Promise((resolve) => setTimeout(() => resolve(stamp('bbb2222')), 90));
    const env = loadWorker({
        caches,
        routes: {
            [SCOPE]: fakeResponse('<html>B</html>'),
            [`${SCOPE}style.css`]: fakeResponse('new css'),
            [`${SCOPE}version.json`]: fakeResponse('down', { ok: false, status: 503 }),
        },
    });
    await lifecycle(env, 'install');
    assert.equal((await fetchEvent(env, navigation())).response.body, '<html>B</html>');
    // Unconfirmed cache: the network answers, not the saved (maybe other build's) copy.
    assert.equal((await fetchEvent(env, get('style.css'))).response.body, 'new css');
    env.routes[`${SCOPE}version.json`] = slowVersion; // slower than the timeout: still no success
    await fetchEvent(env, navigation());
    await fetchEvent(env, get('worker.js?load=1'));
    assert.deepEqual(caches.log, [], 'no put and no delete before a successful check');
    assert.equal(env.SW.state.verified, false);

    // The network failing still falls back to the existing saved copy.
    env.offline = true;
    assert.equal((await fetchEvent(env, get('style.css'))).response.body, 'old css');

    // A check that works: rotate to the live build, then saving starts.
    env.offline = false;
    env.routes[`${SCOPE}version.json`] = stamp('bbb2222');
    await fetchEvent(env, navigation());
    assert.equal(env.SW.state.verified, true);
    assert.deepEqual(cacheNames(env), ['aniimax-bbb2222']);
    assert.equal(cached(env, 'aniimax-bbb2222', './').body, '<html>B</html>');
});

test('test_a_new_version_json_rotates_before_it_is_stored', async () => {
    const env = loadWorker({ routes: { [`${SCOPE}version.json`]: stamp('aaa1111'), [`${SCOPE}app.js?v=1`]: fakeResponse('app A') } });
    await lifecycle(env, 'install');
    await fetchEvent(env, get('app.js?v=1'));
    assert.deepEqual(env.caches.log.filter((line) => line.startsWith('put')).map((line) => line.split(' ').slice(0, 3).join(' ')),
        ['put aniimax-aaa1111 version.json', 'put aniimax-aaa1111 app.js?v=1']);

    // The page's own version.json fetch is the first to see build B.
    env.caches.log.length = 0;
    env.routes[`${SCOPE}version.json`] = stamp('bbb2222');
    await fetchEvent(env, get('version.json'));
    const log = env.caches.log.map((line) => line.replace(/ \{.*$/, ''));
    assert.deepEqual(log, ['delete aniimax-aaa1111', 'put aniimax-bbb2222 version.json']);
    assert.equal(JSON.parse(cached(env, 'aniimax-bbb2222', 'version.json').body).commit, 'bbb2222');
});

test('test_only_ok_basic_responses_are_saved', async () => {
    const env = loadWorker({
        routes: {
            [`${SCOPE}version.json`]: stamp('dev'),
            [`${SCOPE}gone.js`]: fakeResponse('nope', { ok: false, status: 404 }),
            [`${SCOPE}broken.json`]: fakeResponse('oops', { ok: false, status: 500 }),
            [`${SCOPE}opaque.js`]: fakeResponse('', { type: 'opaque', ok: false, status: 0 }),
            [`${SCOPE}cors.js`]: fakeResponse('x', { type: 'cors' }),
            [`${SCOPE}moved.js`]: fakeResponse('x', { redirected: true }),
            [`${SCOPE}fine.js`]: fakeResponse('fine'),
        },
    });
    await lifecycle(env, 'install');
    const missing = await fetchEvent(env, get('gone.js'));
    assert.equal(missing.response.status, 404, 'the error still reaches the page');
    for (const path of ['broken.json', 'opaque.js', 'cors.js', 'moved.js', 'fine.js']) await fetchEvent(env, get(path));
    // Besides fine.js, the version check saved its own version.json.
    assert.deepEqual([...env.caches.stores.get('aniimax-dev').keys()].sort(), [`${SCOPE}fine.js`, `${SCOPE}version.json`]);
});

test('test_bypassed_requests_are_left_to_the_browser', async () => {
    const env = loadWorker({ routes: { [`${SCOPE}reading.json`]: fakeResponse('{}') } });
    await lifecycle(env, 'install');
    const before = env.fetched.length;
    for (const request of [
        get('reading.json'), get('coins.json'), get('verification.json'), get(MATHJAX), get('https://ntfy.sh/topic'),
        get('version.json', { method: 'POST' }), get('app.js', { cache: 'no-store' }),
    ]) {
        const { responded } = await fetchEvent(env, request);
        assert.equal(responded, false, request.url);
    }
    assert.equal(env.fetched.length, before, 'the worker fetched nothing itself');
    assert.equal(env.caches.stores.get('aniimax-dev').size, 0);
});

test('test_missing_version_file_names_the_cache_dev_and_install_skips_waiting', async () => {
    const env = loadWorker();
    await lifecycle(env, 'install');
    assert.equal(env.skipped, 1);
    assert.deepEqual(cacheNames(env), ['aniimax-dev']);
    await lifecycle(env, 'activate');
    assert.equal(env.claimed, 1);
});

// A request to the local server (the helpers above build URLs under the published scope).
const localGet = (path, extra = {}) => ({ ...get(path, extra), url: new URL(path, LOCAL).href });

test('test_on_the_published_site_a_missing_version_file_never_verifies_or_saves', async () => {
    const env = loadWorker({
        routes: { [SCOPE]: fakeResponse('<html></html>'), [`${SCOPE}style.css`]: fakeResponse('css'), [`${SCOPE}app.js?v=1`]: fakeResponse('app') },
    });
    await lifecycle(env, 'install');
    env.caches.log.length = 0;
    assert.equal(env.SW.scopeIsLocal(), false);

    // The page and its files still load, but nothing is trusted or saved.
    assert.equal((await fetchEvent(env, navigation())).response.body, '<html></html>');
    assert.equal((await fetchEvent(env, get('style.css'))).response.body, 'css');
    assert.equal(env.SW.state.verified, false);

    // A later check (the retry delay passed) gets the same 404 and still does not verify.
    env.SW.state.lastCheckEnd = 0;
    assert.equal(await env.SW.checkVersion(), false);
    await fetchEvent(env, get('app.js?v=1'));
    assert.equal(env.SW.state.verified, false);
    assert.deepEqual(env.caches.log, [], 'no put and no delete');
    assert.equal(env.caches.stores.get('aniimax-dev').size, 0);

    // Nothing was saved, so offline there is nothing to fall back on.
    env.offline = true;
    assert.equal((await fetchEvent(env, get('style.css'))).response.type, 'error');

    // Once the real version.json is back, the cache is trusted and saving starts.
    env.offline = false;
    env.routes[`${SCOPE}version.json`] = stamp('aaa1111');
    await fetchEvent(env, navigation());
    assert.equal(env.SW.state.verified, true);
    assert.deepEqual(cacheNames(env), ['aniimax-aaa1111']);
});

test('test_on_a_local_server_a_missing_version_file_verifies_and_uses_the_dev_cache', async () => {
    const env = loadWorker({
        scope: LOCAL,
        routes: { [LOCAL]: fakeResponse('<html></html>'), [`${LOCAL}style.css`]: fakeResponse('css') },
    });
    assert.equal(env.SW.scopeIsLocal(), true);
    await lifecycle(env, 'install');
    assert.deepEqual(cacheNames(env), ['aniimax-dev']);

    assert.equal((await fetchEvent(env, localGet('style.css'))).response.body, 'css');
    assert.equal(env.SW.state.verified, true);
    assert.equal(env.caches.stores.get('aniimax-dev').get(`${LOCAL}style.css`).body, 'css');
    assert.deepEqual(cacheNames(env), ['aniimax-dev']);

    // Offline, the saved copy answers.
    env.offline = true;
    assert.equal((await fetchEvent(env, localGet('style.css'))).response.body, 'css');
});

test('test_on_a_local_server_a_missing_version_file_does_not_verify_over_a_real_builds_cache', async () => {
    // A cache from a real build is in the way: the 404 says nothing about which build it is.
    const caches = fakeCaches();
    await caches.open('aniimax-aaa1111');
    const env = loadWorker({ scope: LOCAL, caches, routes: { [`${LOCAL}style.css`]: fakeResponse('css') } });
    await lifecycle(env, 'install');
    caches.log.length = 0;
    await fetchEvent(env, localGet('style.css'));
    assert.equal(env.SW.state.verified, false);
    assert.deepEqual(caches.log, []);
});

test('test_local_scopes_are_told_apart_from_the_published_site_and_agree_with_sw_register', () => {
    const scopeIsLocal = (scope) => loadWorker({ scope }).SW.scopeIsLocal();
    for (const scope of [
        'http://localhost:8080/', 'http://127.0.0.1:8080/', 'http://[::1]:8080/', 'http://dev.localhost:3000/',
        'http://aniimax.test/', 'http://localhost:8080/aniimax/',
    ]) assert.equal(scopeIsLocal(scope), true, scope);
    for (const scope of [
        SCOPE, 'https://example.com/', 'https://localhost.example.com/', 'https://notlocalhost/', 'https://latest/',
    ]) assert.equal(scopeIsLocal(scope), false, scope);

    // sw.js carries its own copy of the rule (it cannot import); the copies must not drift apart.
    const { SW } = loadWorker();
    for (const host of [
        'localhost', 'LOCALHOST', '127.0.0.1', '[::1]', '::1', 'dev.localhost', 'a.b.test', 'test', '10.0.0.5', '192.168.1.20',
        '172.16.0.1', '172.31.255.1', '172.32.0.1', '169.254.1.1', '11.0.0.1', 'gitcodingforme.github.io', 'localhost.evil.com',
        'notlocalhost', '', null, undefined,
    ]) assert.equal(SW.isLocalHost(host), registerIsLocalHost(host), String(host));
});

test('test_every_module_the_solver_worker_imports_is_warmed_for_offline_use', async () => {
    // A worker's own imports do not show up in the page's resource list, so a module only the
    // worker loads must be in CORE_FILES. A module the page imports too (same ?v= address) is
    // warmed from that list instead, and needs no entry: an untagged entry would be saved under
    // another address than the tagged one the worker asks for.
    const workerSource = readFileSync(new URL('../web/worker.js', import.meta.url), 'utf8');
    const pageSource = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    const imports = [...workerSource.matchAll(/^\s*import\b[^'"]*?from\s+'(\.\/[^']+)'/gm)].map((match) => match[1]);
    assert.ok(imports.some((specifier) => specifier.startsWith('./shared.js')), 'worker.js imports shared.js');

    const { SW } = loadWorker();
    for (const specifier of imports) {
        const name = specifier.slice(2).split('?')[0];
        const warmedByCore = SW.CORE_FILES.includes(name);
        const warmedByPage = specifier.includes('?v=') && pageSource.includes(`'${specifier}'`);
        assert.ok(warmedByCore || warmedByPage, `${specifier} is warmed for offline use`);
    }

    // And the page-list route works end to end: warmed with the tag, found offline under the tag.
    const tagged = imports.find((specifier) => specifier.startsWith('./shared.js'));
    const env = loadWorker({ routes: { [`${SCOPE}version.json`]: stamp('aaa1111'), [new URL(tagged, SCOPE).href]: fakeResponse('shared') } });
    await lifecycle(env, 'install');
    await lifecycle(env, 'message', { type: 'aniimax-warm', urls: [new URL(tagged, SCOPE).href] });
    env.offline = true;
    assert.equal((await fetchEvent(env, get(tagged.slice(2)))).response.body, 'shared');
});

test('test_a_new_commit_rotates_caches_and_tells_open_tabs', async () => {
    const page = fakeClient(SCOPE);
    const oldTab = fakeClient(`${SCOPE}index.html`, { controlled: false });
    const otherSite = fakeClient('https://gitcodingforme.github.io/another-site/');
    const env = loadWorker({
        clients: [page, oldTab, otherSite],
        routes: {
            [SCOPE]: fakeResponse('<html>A</html>'),
            [`${SCOPE}version.json`]: stamp('aaa1111'),
            [`${SCOPE}pkg/aniimax_bg.wasm`]: fakeResponse('wasm A'),
            [`${SCOPE}app.js?v=1`]: fakeResponse('app A'),
        },
    });
    await env.caches.open('another-site-cache');
    await lifecycle(env, 'install');
    await lifecycle(env, 'activate');
    await fetchEvent(env, navigation());
    await fetchEvent(env, get('pkg/aniimax_bg.wasm'));
    await fetchEvent(env, get('app.js?v=1'));
    assert.deepEqual(cacheNames(env), ['another-site-cache', 'aniimax-aaa1111']);
    assert.deepEqual(page.messages, [], 'the first install is not an update');

    // A deploy: version.json now names another commit.
    env.routes[SCOPE] = fakeResponse('<html>B</html>');
    env.routes[`${SCOPE}version.json`] = stamp('bbb2222');
    const loaded = await fetchEvent(env, navigation());
    assert.equal(loaded.response.body, '<html>B</html>');
    assert.deepEqual(cacheNames(env), ['another-site-cache', 'aniimax-bbb2222']);
    assert.deepEqual(page.messages, [{ type: 'aniimax-updated', commit: 'bbb2222' }]);
    assert.deepEqual(oldTab.messages, [{ type: 'aniimax-updated', commit: 'bbb2222' }]);
    assert.deepEqual(otherSite.messages, [], 'other sites on the origin are left alone');
    assert.equal(cached(env, 'aniimax-bbb2222', 'version.json') !== undefined, true);

    // The same commit again: nothing new.
    await fetchEvent(env, navigation());
    assert.equal(page.messages.length, 1);

    // Offline now: the old build's wasm is gone, never paired with the new build's page.
    env.offline = true;
    assert.equal((await fetchEvent(env, get('pkg/aniimax_bg.wasm'))).response.type, 'error');
    assert.equal((await fetchEvent(env, navigation())).response.body, '<html>B</html>');
});

test('test_the_pages_own_version_fetch_also_rotates', async () => {
    const page = fakeClient(SCOPE);
    const env = loadWorker({ clients: [page], routes: { [`${SCOPE}version.json`]: stamp('aaa1111') } });
    await lifecycle(env, 'install');
    env.routes[`${SCOPE}version.json`] = stamp('ccc3333');
    const { response } = await fetchEvent(env, get('version.json'));
    assert.equal(JSON.parse(response.body).commit, 'ccc3333');
    assert.deepEqual(cacheNames(env), ['aniimax-ccc3333']);
    assert.equal(JSON.parse(cached(env, 'aniimax-ccc3333', 'version.json').body).commit, 'ccc3333');
    assert.deepEqual(page.messages, [{ type: 'aniimax-updated', commit: 'ccc3333' }]);

    // A version.json without a usable commit, or a failed one, never rotates.
    env.routes[`${SCOPE}version.json`] = fakeResponse('{"appVersion":"0.17.1"}');
    await fetchEvent(env, get('version.json'));
    env.routes[`${SCOPE}version.json`] = fakeResponse('down', { ok: false, status: 503 });
    await fetchEvent(env, navigation());
    assert.deepEqual(cacheNames(env), ['aniimax-ccc3333']);
    assert.equal(page.messages.length, 1);
});

test('test_warm_saves_core_files_and_the_pages_files_but_not_bypassed_ones', async () => {
    const routes = {
        [`${SCOPE}version.json`]: stamp('dev'),
        [SCOPE]: fakeResponse('<html></html>'),
        [`${SCOPE}worker.js`]: fakeResponse('worker'),
        [`${SCOPE}worker.js?load=5`]: fakeResponse('worker'),
        [`${SCOPE}pkg/aniimax.js`]: fakeResponse('js'),
        [`${SCOPE}pkg/aniimax_bg.wasm`]: fakeResponse('wasm'),
        [`${SCOPE}vendor/highs/highs.wasm`]: fakeResponse('highs'),
        [`${SCOPE}app.js?v=1`]: fakeResponse('app'),
        [`${SCOPE}reading.json`]: fakeResponse('{}'),
    };
    const env = loadWorker({ routes });
    await lifecycle(env, 'install');
    await lifecycle(env, 'message', {
        type: 'aniimax-warm',
        urls: [`${SCOPE}?sw=on`, `${SCOPE}app.js?v=1`, `${SCOPE}reading.json`, MATHJAX, `${SCOPE}worker.js?load=5`, 42],
    });
    const keys = [...env.caches.stores.get('aniimax-dev').keys()].sort();
    assert.deepEqual(keys, [SCOPE, `${SCOPE}app.js?v=1`, `${SCOPE}pkg/aniimax.js`, `${SCOPE}pkg/aniimax_bg.wasm`,
        `${SCOPE}vendor/highs/highs.wasm`, `${SCOPE}version.json`, `${SCOPE}worker.js`].sort());
    assert.equal(env.fetched.some((call) => call.url.endsWith('reading.json') || call.url === MATHJAX), false);

    // Warming again fetches only what is still missing.
    const before = env.fetched.length;
    await lifecycle(env, 'message', { type: 'aniimax-warm', urls: [`${SCOPE}app.js?v=1`] });
    assert.equal(env.fetched.filter((call, i) => i >= before && call.url.endsWith('app.js?v=1')).length, 0);
});

test('test_kill_switch_deletes_caches_unregisters_and_reloads_controlled_tabs', async () => {
    assert.equal(SOURCE.split('const KILL_SWITCH = false;').length, 2, 'the switch is one line the runbook can point at');
    const source = SOURCE.replace('const KILL_SWITCH = false;', 'const KILL_SWITCH = true;');
    const controlled = fakeClient(`${SCOPE}?config=1`);
    const fresh = fakeClient(SCOPE, { controlled: false });
    const env = loadWorker({ source, clients: [controlled, fresh], routes: { [`${SCOPE}app.js`]: fakeResponse('app') } });
    for (const name of ['aniimax-aaa1111', 'aniimax-bbb2222', 'another-site-cache']) await env.caches.open(name);
    await lifecycle(env, 'install');
    assert.equal(env.skipped, 1);
    await lifecycle(env, 'activate');
    assert.deepEqual(cacheNames(env), ['another-site-cache']);
    assert.equal(env.unregistered, 1);
    assert.equal(env.claimed, 0, 'no claim, so a page that registers it again is not reloaded in a loop');
    assert.deepEqual(controlled.navigated, [`${SCOPE}?config=1`]);
    assert.deepEqual(fresh.navigated, []);
    assert.equal((await fetchEvent(env, get('app.js'))).responded, false);
});

test('test_kill_switch_falls_back_to_a_reload_message', async () => {
    const source = SOURCE.replace('const KILL_SWITCH = false;', 'const KILL_SWITCH = true;');
    const tab = fakeClient(SCOPE);
    tab.navigate = async () => { throw new TypeError('not allowed'); };
    const env = loadWorker({ source, clients: [tab] });
    await lifecycle(env, 'activate');
    assert.deepEqual(tab.messages, [{ type: 'aniimax-reload' }]);
});

for (const [label, options] of [
    ['a caches getter that throws', { cachesGetter: () => { throw new Error('SecurityError'); } }],
    ['cache methods that reject', {
        caches: {
            open: async () => { throw new Error('SecurityError'); },
            keys: async () => { throw new Error('SecurityError'); },
            delete: async () => { throw new Error('SecurityError'); },
        },
    }],
]) {
    test(`test_${label.replaceAll(' ', '_')}_does_not_break_the_site`, async () => {
        const page = fakeClient(SCOPE);
        const env = loadWorker({
            ...options,
            clients: [page],
            routes: {
                [SCOPE]: fakeResponse('<html></html>'),
                [`${SCOPE}version.json`]: stamp('aaa1111'),
                [`${SCOPE}style.css`]: fakeResponse('css'),
                [`${SCOPE}worker.js?load=1`]: fakeResponse('worker'),
            },
        });
        await lifecycle(env, 'install');
        await lifecycle(env, 'activate');
        assert.equal((await fetchEvent(env, navigation())).response.body, '<html></html>');
        assert.equal((await fetchEvent(env, get('style.css'))).response.body, 'css');
        assert.equal((await fetchEvent(env, get('worker.js?load=1'))).response.body, 'worker');
        env.routes[`${SCOPE}version.json`] = stamp('bbb2222');
        await fetchEvent(env, get('version.json'));
        await lifecycle(env, 'message', { type: 'aniimax-warm', urls: [`${SCOPE}style.css`] });
        env.offline = true;
        assert.equal((await fetchEvent(env, get('style.css'))).response.type, 'error');
        assert.equal((await fetchEvent(env, navigation())).response.type, 'error');
    });
}
