// Aniimax service worker: offline support for the published site.
//
// What this is: a service worker is a small script the browser keeps next to a website. Once it is
// installed, every request the page makes (HTML, scripts, data files, the solver) passes through
// the `fetch` handler below first, and this file decides whether to answer from the network, from
// a saved copy (the "cache"), or both. That is what lets the site open and solve with no internet.
//
// How it is turned on: web/sw-register.js registers this file on the published site only (never
// on localhost unless the URL has ?sw=on). Opening the site with ?nosw switches it off again.
//
// The three routes (see `routeFor`):
//   bypass         The service worker stays out of the way; the browser fetches as if it did not
//                  exist and nothing is saved. Used for anything that must always be live or is
//                  not ours: other websites (MathJax, api.github.com, ntfy.sh), POSTs, the
//                  watcher's personal files (reading.json, coins.json, verification.json), and
//                  requests the page marked `cache: 'no-store'`.
//   network-first  Ask the network first and save what comes back; if the network fails, or takes
//                  longer than 6 seconds and a saved copy exists, use the saved copy. Used for the
//                  page itself, every .json data file, the workers and the solver (pkg/*), because
//                  these must be as fresh as possible. The solver set (worker.js, layout-worker.js,
//                  layout.js, pkg/*) never uses the saved copy just because the network is slow,
//                  only when it fails: one file from the network and the next from the cache could
//                  pair a new pkg/aniimax.js with an old aniimax_bg.wasm.
//   swr            "Stale-while-revalidate": answer at once from the saved copy if there is one,
//                  and fetch a fresh copy in the background for next time. Used for everything
//                  else (scripts tagged with ?v=, the style sheet, icons, the HiGHS solver files),
//                  which change rarely and whose URLs change when they do.
//
// One cache per build: saved copies live in a cache named `aniimax-<commit>`, where the commit
// comes from version.json (written by the deploy workflow; "dev" when it is missing). When a
// fetched version.json names a different commit, a new empty cache is started, every older
// `aniimax-*` cache is deleted, and open tabs get a "Site updated. Reload" message. So copies from
// two different builds are never mixed (pkg/aniimax.js and pkg/aniimax_bg.wasm must match).
// Nothing is saved, and no saved copy is preferred over the network, until a version check has
// succeeded since this worker started: until then a file might belong to another build than the
// cache. (Saved copies are still used when the network fails.)
//
// Everything is in plain functions on the `SW` object so tests/sw.test.mjs can load this file in
// Node and call them directly; the event listeners at the bottom only exist inside a browser.

'use strict';

// Emergency off switch. If a deploy ever leaves visitors stuck on a broken saved version, change
// this to true and deploy: the next time any visitor loads the site, this worker deletes its
// caches, unregisters itself and reloads the open tabs, so they get the plain live site. (Never
// delete this file instead: a missing sw.js leaves the old worker running.) The owner's runbook
// is docs/runbooks/offline.md in the workspace, not in this repository.
const KILL_SWITCH = false;

// A marker `withTimeout` returns when the time ran out first.
const TIMED_OUT = Symbol('timed out');

const SW = {
    KILL_SWITCH,
    TIMED_OUT,
    // Every cache this worker makes starts with this, so it never touches other sites' caches
    // (all of gitcodingforme.github.io shares one origin, and so one set of caches).
    CACHE_PREFIX: 'aniimax-',
    // How long network-first waits before using a saved copy. Tests shorten it.
    NETWORK_TIMEOUT_MS: 6000,
    // After a failed version check, saving does not start another one for this long.
    CHECK_RETRY_MS: 10000,
    // The local watcher's personal files: never saved, always live.
    NEVER_CACHE: /(reading|coins|verification)\.json$/,
    // Files (relative to the site folder) that are network-first besides HTML, *.json and pkg/*.
    // With pkg/* they are the solver set (see `isSolverFile`).
    NETWORK_FIRST_FILES: ['worker.js', 'layout-worker.js', 'layout.js'],
    // The files a page starts its workers with. Requesting one starts a version check, so a tab
    // left open across a deploy saves the new build's solver into the new build's cache.
    WORKER_ENTRY_FILES: ['worker.js', 'layout-worker.js'],
    // Files the page's workers load, which the page itself cannot list (see `warm`). Saved in the
    // background after the first visit so the solver works offline without a solve first.
    CORE_FILES: [
        './', 'worker.js', 'layout-worker.js', 'layout.js',
        'pkg/aniimax.js', 'pkg/aniimax_bg.wasm', 'vendor/highs/highs.mjs', 'vendor/highs/highs.wasm',
    ],
    // What this worker remembers while it runs. The browser stops idle workers, so nothing here is
    // relied on for long: the active cache name is re-read from the cache list after a restart.
    // `checking` is the version check in flight; `pending` the latest one (reads and saves wait
    // for it); `verified` turns true once a check succeeded; `lastCheckEnd` is when one last ended.
    state: { cacheName: null, naming: null, pending: null, checking: null, verified: false, lastCheckEnd: 0 },
};
self.SW = SW;

// --- Where a request goes -------------------------------------------------------------------

// The site folder this worker looks after, e.g. https://gitcodingforme.github.io/aniimax/.
SW.scope = function () {
    return self.registration.scope;
};

// A file in the site folder as a full URL.
SW.scopeFile = function (name) {
    return new URL(name, SW.scope()).href;
};

// The request's path inside the site folder ('' for the folder itself, 'pkg/aniimax.js', ...),
// or null when it is another website or another folder on the same website.
SW.relativePath = function (url, scopeUrl) {
    const target = new URL(url);
    const scope = new URL(scopeUrl);
    if (target.origin !== scope.origin) return null;
    if (!target.pathname.startsWith(scope.pathname)) return null;
    return target.pathname.slice(scope.pathname.length);
};

function acceptsHtml(request) {
    try {
        const accept = request.headers && typeof request.headers.get === 'function' ? request.headers.get('accept') : '';
        return typeof accept === 'string' && accept.includes('text/html');
    } catch (_) {
        return false;
    }
}

// True for the page itself: a navigation, or a request for HTML.
SW.isPage = function (request, rel) {
    return request.mode === 'navigate'
        || request.destination === 'document'
        || rel === ''
        || rel.endsWith('/')
        || rel.endsWith('.html')
        || acceptsHtml(request);
};

// 'bypass' | 'network-first' | 'swr'. See the top of this file for what each means.
SW.routeFor = function (request, scopeUrl) {
    if (!request || request.method !== 'GET') return 'bypass';
    if (request.cache === 'no-store') return 'bypass';
    let rel;
    try {
        rel = SW.relativePath(request.url, scopeUrl);
    } catch (_) {
        return 'bypass';
    }
    if (rel === null) return 'bypass';
    if (SW.NEVER_CACHE.test(rel)) return 'bypass';
    // The worker's own file: the browser checks it for updates itself, never through here.
    if (rel === 'sw.js') return 'bypass';
    if (SW.isPage(request, rel)) return 'network-first';
    if (rel.endsWith('.json')) return 'network-first';
    if (SW.isSolverFile(rel)) return 'network-first';
    return 'swr';
};

// The solver set: the workers, layout.js and the wasm package. These must all come from one build.
SW.isSolverFile = function (rel) {
    return typeof rel === 'string' && (SW.NETWORK_FIRST_FILES.includes(rel) || rel.startsWith('pkg/'));
};

// `search` ('?a=1&load=2') without the parameter `name`, keeping the others exactly as written.
SW.dropParam = function (search, name) {
    const kept = String(search || '').replace(/^\?/, '').split('&').filter((part) => {
        if (part === '') return false;
        const raw = part.split('=')[0];
        let decoded = raw;
        try {
            decoded = decodeURIComponent(raw.replace(/\+/g, ' '));
        } catch (_) { /* keep it as written */ }
        return decoded !== name;
    });
    return kept.length ? `?${kept.join('&')}` : '';
};

// The name a response is saved under. The page starts its workers as worker.js?load=<time>, and
// they pass that on to pkg/aniimax.js and layout.js, so those URLs differ on every page load.
// Saving under the full URL would never find a saved copy again and would grow forever, so
// `load` is dropped. `v` (the cache tag on scripts) is kept: a new tag means a new file.
SW.cacheKey = function (url) {
    const u = new URL(url);
    return u.origin + u.pathname + SW.dropParam(u.search, 'load');
};

// The page is saved once, without its query (?sw=on and the like do not change the HTML), and
// /aniimax/index.html is the same page as /aniimax/.
SW.pageKey = function (url) {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/index\.html$/, '');
};

SW.keyFor = function (request, scopeUrl) {
    const rel = SW.relativePath(request.url, scopeUrl);
    return rel !== null && SW.isPage(request, rel) ? SW.pageKey(request.url) : SW.cacheKey(request.url);
};

// Only complete, successful answers from this site are saved: not errors (404, 500), not other
// websites' answers (type 'cors' or 'opaque'), and not redirects.
SW.isCacheable = function (response) {
    return Boolean(response) && response.ok === true && response.type === 'basic' && !response.redirected;
};

// Resolves with the promise's value, or with TIMED_OUT if `ms` passes first.
SW.withTimeout = function (promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(TIMED_OUT), ms);
        Promise.resolve(promise).then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); },
        );
    });
};

// --- The cache for this build ---------------------------------------------------------------
// Every cache call is wrapped in try/catch: in some browsers (Safari private windows) the cache
// storage throws, and the site must then still work, just without offline copies.

SW.safeCommit = function (commit) {
    return typeof commit === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(commit) ? commit : 'dev';
};

SW.cacheNameFor = function (commit) {
    return SW.CACHE_PREFIX + SW.safeCommit(commit);
};

SW.cacheNames = async function () {
    try {
        return Array.from(await self.caches.keys());
    } catch (_) {
        return [];
    }
};

// The commit in the live version.json, or null when it is missing or the network is down.
SW.fetchCommit = async function () {
    try {
        const response = await SW.withTimeout(self.fetch(SW.scopeFile('version.json'), { cache: 'no-store' }), SW.NETWORK_TIMEOUT_MS);
        if (response === TIMED_OUT || !response.ok) return null;
        const stamp = await response.json();
        return stamp && typeof stamp.commit === 'string' ? stamp.commit : null;
    } catch (_) {
        return null;
    }
};

// The name of the cache in use: remembered, else the newest `aniimax-*` cache, else (first run)
// named from the live version.json, or 'aniimax-dev' when there is none.
SW.activeCacheName = async function () {
    if (SW.state.cacheName) return SW.state.cacheName;
    if (!SW.state.naming) {
        SW.state.naming = (async () => {
            const ours = (await SW.cacheNames()).filter((name) => name.startsWith(SW.CACHE_PREFIX));
            // The cache list keeps creation order, so the last one is the newest.
            if (ours.length) return ours[ours.length - 1];
            return SW.cacheNameFor(await SW.fetchCommit());
        })().then((name) => {
            if (!SW.state.cacheName) SW.state.cacheName = name;
            SW.state.naming = null;
            return SW.state.cacheName;
        });
    }
    return SW.state.naming;
};

SW.openActive = async function () {
    return self.caches.open(await SW.activeCacheName());
};

// The saved copy for `key`, or null. Waits for a version check a navigation started, so a page
// of a new build is never answered with a saved file of the old one.
SW.match = async function (key) {
    try {
        if (SW.state.pending) await SW.state.pending;
        const cache = await SW.openActive();
        return (await cache.match(key, { ignoreVary: true })) || null;
    } catch (_) {
        return null;
    }
};

// Writes a copy into the active cache, no questions asked (only the version check uses this).
SW.store = async function (key, response) {
    try {
        const cache = await SW.openActive();
        await cache.put(key, response);
        return true;
    } catch (_) {
        return false;
    }
};

// Saves a copy, but only into a cache confirmed to be this build's: waits for a running version
// check, starts one if none has succeeded yet (at most every CHECK_RETRY_MS after a failure), and
// skips the save when there is still no successful check. Returns true when saved.
SW.put = async function (key, response) {
    try {
        if (SW.state.pending) await SW.state.pending;
        if (!SW.state.verified && Date.now() - SW.state.lastCheckEnd >= SW.CHECK_RETRY_MS) await SW.startCheck();
        if (!SW.state.verified) return false;
        return await SW.store(key, response);
    } catch (_) {
        return false;
    }
};

// Deletes every `aniimax-*` cache except `keep` (all of them when `keep` is null).
SW.deleteOurCaches = async function (keep = null) {
    try {
        if (keep) await self.caches.open(keep);
        const doomed = (await SW.cacheNames()).filter((name) => name.startsWith(SW.CACHE_PREFIX) && name !== keep);
        await Promise.all(doomed.map((name) => self.caches.delete(name)));
    } catch (_) { /* nothing to clean, or no cache storage */ }
};

// Open tabs of this site (not other sites on the same origin).
SW.windowClients = async function (includeUncontrolled) {
    try {
        const scope = SW.scope();
        const list = await self.clients.matchAll({ type: 'window', includeUncontrolled });
        return Array.from(list).filter((client) => typeof client.url === 'string' && client.url.startsWith(scope));
    } catch (_) {
        return [];
    }
};

SW.tellClients = async function (message) {
    for (const client of await SW.windowClients(true)) {
        try {
            client.postMessage(message);
        } catch (_) { /* tab already closed */ }
    }
};

// Reads a fetched version.json: 'unusable' (no commit in it), 'same' (the active cache is this
// build's), or 'rotated': it named another commit, so the worker switched to a new cache for that
// build, deleted the old ones and told open tabs to offer a reload. Rotation always happens
// before anything of the new build is saved. A usable answer counts as a successful check.
SW.noteVersion = async function (response) {
    let commit;
    try {
        const stamp = await response.json();
        commit = stamp && stamp.commit;
    } catch (_) {
        return 'unusable';
    }
    if (typeof commit !== 'string' || commit === '') return 'unusable';
    const next = SW.cacheNameFor(commit);
    await SW.activeCacheName();
    if (SW.state.cacheName === next) {
        SW.state.verified = true;
        return 'same';
    }
    // Set before any other await, so every later save goes into the new build's cache.
    SW.state.cacheName = next;
    await SW.deleteOurCaches(next);
    SW.state.verified = true;
    await SW.tellClients({ type: 'aniimax-updated', commit: SW.safeCommit(commit) });
    return 'rotated';
};

// Starts a version check unless one is already running, and returns it.
SW.startCheck = function () {
    if (!SW.state.checking) {
        SW.state.checking = SW.checkVersion().finally(() => { SW.state.checking = null; });
        SW.state.pending = SW.state.checking;
    }
    return SW.state.checking;
};

// Fetches the live version.json (bypassing the browser's own short-term cache) and acts on it.
// Started by every page navigation and every worker start (see `startCheck`); never rejects.
// A timeout or a failed fetch is not a success, so nothing is saved until a later check works.
// A 404 counts only while the active cache is 'aniimax-dev' (a local build has no version.json).
SW.checkVersion = async function () {
    try {
        const url = SW.scopeFile('version.json');
        const response = await SW.withTimeout(self.fetch(url, { cache: 'no-store' }), SW.NETWORK_TIMEOUT_MS);
        if (response === TIMED_OUT) return false;
        if (response.status === 404 && (await SW.activeCacheName()) === SW.cacheNameFor(null)) {
            SW.state.verified = true;
            return false;
        }
        if (!SW.isCacheable(response)) return false;
        const forCache = response.clone();
        const result = await SW.noteVersion(response);
        if (result === 'unusable') return false;
        // Rotate first (above), then store this build's version.json in this build's cache.
        await SW.store(SW.cacheKey(url), forCache);
        return result === 'rotated';
    } catch (_) {
        return false;
    } finally {
        SW.state.lastCheckEnd = Date.now();
    }
};

// --- The two caching routes -----------------------------------------------------------------

// Fetches from the network and saves a copy when it is worth saving. `waitUntil` keeps the worker
// alive until the copy is written.
SW.fetchAndStore = async function (request, key, waitUntil) {
    const response = await self.fetch(request);
    if (SW.isCacheable(response)) {
        if (key === SW.scopeFile('version.json')) {
            const forCheck = response.clone();
            const forCache = response.clone();
            // Rotate first if it names a new build, then store it (in the new build's cache).
            waitUntil(SW.noteVersion(forCheck).then(() => SW.put(key, forCache)));
        } else {
            waitUntil(SW.put(key, response.clone()));
        }
    }
    return response;
};

// `timeout: false` (the solver set) waits for the network however long it takes and uses the
// saved copy only when the network fails.
SW.networkFirst = function (request, key, waitUntil, { timeout = true } = {}) {
    const network = SW.fetchAndStore(request, key, waitUntil);
    waitUntil(network);
    return (async () => {
        try {
            const first = timeout ? await SW.withTimeout(network, SW.NETWORK_TIMEOUT_MS) : await network;
            if (first !== TIMED_OUT) return first;
            // Slow network: use the saved copy if there is one and this build's cache is
            // confirmed (the fetch carries on in the background and refreshes it), else keep
            // waiting for the network.
            if (SW.state.pending) await SW.state.pending;
            const saved = SW.state.verified ? await SW.match(key) : null;
            return saved || await network;
        } catch (_) {
            // No network: the saved copy, or the browser's normal offline error.
            return (await SW.match(key)) || Response.error();
        }
    })();
};

SW.staleWhileRevalidate = function (request, key, waitUntil) {
    const fresh = SW.fetchAndStore(request, key, waitUntil);
    waitUntil(fresh);
    return (async () => {
        // Until a version check succeeded the saved copy may be another build's: use the network.
        if (SW.state.pending) await SW.state.pending;
        const saved = SW.state.verified ? await SW.match(key) : null;
        if (saved) return saved;
        try {
            return await fresh;
        } catch (_) {
            return (await SW.match(key)) || Response.error();
        }
    })();
};

// --- Saving the files a visit needs ---------------------------------------------------------
// The first visit is loaded before this worker takes over, so nothing from it was saved.
// sw-register.js sends the list of files the page loaded (performance entries); this saves the
// ones not saved yet, plus CORE_FILES that only the page's workers load.
SW.warm = async function (urls) {
    const scope = SW.scope();
    const extra = Array.isArray(urls) ? urls.slice(0, 300) : [];
    const list = SW.CORE_FILES.map((name) => new URL(name, scope).href).concat(extra);
    const seen = new Set();
    let saved = 0;
    for (const url of list) {
        if (typeof url !== 'string') continue;
        const request = { method: 'GET', url, mode: 'same-origin', destination: '', cache: 'default' };
        let key;
        try {
            if (SW.routeFor(request, scope) === 'bypass') continue;
            key = SW.keyFor(request, scope);
        } catch (_) {
            continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        if (await SW.match(key)) continue;
        try {
            const response = await self.fetch(url, { cache: 'no-cache', credentials: 'same-origin' });
            if (SW.isCacheable(response) && await SW.put(key, response)) saved += 1;
        } catch (_) { /* offline or missing: try again next visit */ }
    }
    return saved;
};

// --- The emergency off switch ---------------------------------------------------------------
// Deletes this site's caches, unregisters, and reloads the tabs this worker controls so they load
// the live site. Only controlled tabs are reloaded (and the worker does not claim new ones), so a
// page that registers the switched-off worker again is not reloaded in a loop.
SW.shutDown = async function () {
    await SW.deleteOurCaches(null);
    try {
        await self.registration.unregister();
    } catch (_) { /* already gone */ }
    for (const client of await SW.windowClients(false)) {
        try {
            await client.navigate(client.url);
        } catch (_) {
            try {
                client.postMessage({ type: 'aniimax-reload' });
            } catch (_) { /* tab already closed */ }
        }
    }
};

// --- Event handlers -------------------------------------------------------------------------

// Wraps `event.waitUntil` so a late or failed call never breaks the response.
SW.keeper = function (event) {
    return (promise) => {
        try {
            event.waitUntil(Promise.resolve(promise).catch(() => {}));
        } catch (_) { /* the event is already over */ }
    };
};

SW.onInstall = function (event) {
    // Take over from an older version right away instead of waiting for every tab to close.
    event.waitUntil((async () => {
        try {
            await self.skipWaiting();
        } catch (_) { /* not supported */ }
        if (!KILL_SWITCH) {
            try {
                await self.caches.open(await SW.activeCacheName());
            } catch (_) { /* no cache storage: the site still works online */ }
        }
    })());
};

SW.onActivate = function (event) {
    // `claim` makes the already open tabs use this worker without a reload.
    event.waitUntil(KILL_SWITCH ? SW.shutDown() : Promise.resolve().then(() => self.clients.claim()).catch(() => {}));
};

SW.onFetch = function (event) {
    if (KILL_SWITCH) return;
    const request = event.request;
    let route;
    let key;
    let rel;
    try {
        const scope = SW.scope();
        route = SW.routeFor(request, scope);
        if (route !== 'bypass') {
            key = SW.keyFor(request, scope);
            rel = SW.relativePath(request.url, scope);
        }
    } catch (_) {
        return;
    }
    // Not calling respondWith lets the browser fetch normally, as if this worker did not exist.
    if (route === 'bypass') return;
    const waitUntil = SW.keeper(event);
    if (request.mode === 'navigate' || SW.WORKER_ENTRY_FILES.includes(rel)) waitUntil(SW.startCheck());
    event.respondWith(route === 'network-first'
        ? SW.networkFirst(request, key, waitUntil, { timeout: !SW.isSolverFile(rel) })
        : SW.staleWhileRevalidate(request, key, waitUntil));
};

SW.onMessage = function (event) {
    if (KILL_SWITCH) return;
    const data = event && event.data;
    if (!data || data.type !== 'aniimax-warm') return;
    const work = SW.warm(data.urls).catch(() => 0);
    if (typeof event.waitUntil === 'function') event.waitUntil(work);
};

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
    self.addEventListener('install', SW.onInstall);
    self.addEventListener('activate', SW.onActivate);
    self.addEventListener('fetch', SW.onFetch);
    self.addEventListener('message', SW.onMessage);
}
