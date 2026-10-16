// Turns on offline support (the service worker in sw.js) and shows its two small messages.
//
// - On the published site it registers ./sw.js, which saves the site's files as they load so the
//   next visit works without internet. See docs/runbooks/offline.md.
// - On a local dev server (localhost, 127.0.0.1, [::1]) it does nothing unless the URL has
//   ?sw=on, so the files you are editing and the watcher's live files are never served from a
//   saved copy. A worker left over from an earlier ?sw=on test is switched off again.
// - Opening any page of the site with ?nosw switches offline support off in this browser: it
//   unregisters the worker, deletes the saved copies, and removes ?nosw from the address bar.
// - An unregistered worker keeps controlling the tab it was removed from (and would save files
//   again), so after switching off the page reloads once; a sessionStorage flag stops a loop.
// - When the worker sees that a new build was deployed, it sends 'aniimax-updated' and this shows
//   "Site updated." with a Reload button.
//
// No imports, and the pure helpers are exported so tests/sw_register.test.mjs can check them in
// Node without a browser.

const CACHE_PREFIX = 'aniimax-';
const TOAST_ID = 'aniimax-sw-toast';
const RELOAD_FLAG = 'aniimax-sw-reloaded';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

function params(search) {
    return new URLSearchParams(String(search || '').replace(/^\?/, ''));
}

// True for a local development server.
export function isLocalHost(hostname) {
    return LOCAL_HOSTS.includes(String(hostname || '').toLowerCase());
}

// True when the URL asks to switch offline support off (?nosw).
export function switchOffRequested(location) {
    return Boolean(location) && params(location.search).has('nosw');
}

// True when this page should register the service worker: never with ?nosw, on a local server
// only with ?sw=on, everywhere else yes.
export function shouldRegister(location) {
    if (!location || switchOffRequested(location)) return false;
    if (isLocalHost(location.hostname)) return params(location.search).get('sw') === 'on';
    return true;
}

// `search` ('?a=1&nosw') without the parameter `name`, keeping the others exactly as written.
export function withoutParam(search, name) {
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
}

// True when a page that just switched the worker off must reload once to be free of it: it is
// still controlled, it has not just reloaded for this, and sessionStorage works (without it the
// flag that prevents a reload loop cannot be kept, so it never reloads).
export function needsReload({ controlled, justReloaded, storageWorks }) {
    return Boolean(controlled) && !justReloaded && Boolean(storageWorks);
}

// Same-origin URLs from `urls` (what the page loaded), for the worker to save.
export function sameOriginUrls(urls, pageUrl) {
    const origin = new URL(pageUrl).origin;
    const out = [];
    for (const url of urls) {
        try {
            if (typeof url === 'string' && new URL(url).origin === origin && !out.includes(url)) out.push(url);
        } catch (_) { /* not a URL */ }
    }
    return out;
}

// The toast box: `text`, plus a Reload button when `onClick` is given, plus a dismiss button.
// Styled inline with the page's own colour variables (web/style.css :root and .light), with the
// dark theme's colours as fallbacks, so style.css needs no change.
export function toastElement(text, onClick, doc = globalThis.document) {
    const box = doc.createElement('div');
    box.id = TOAST_ID;
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:1.25rem', 'transform:translateX(-50%)', 'z-index:10000',
        'display:flex', 'align-items:center', 'gap:0.75rem', 'max-width:calc(100vw - 2rem)',
        'padding:0.65rem 0.75rem 0.65rem 1rem', 'box-sizing:border-box',
        'background:var(--surface-2, #1e2229)', 'color:var(--text, #e9eaec)',
        'border:1px solid var(--border, #2a2f37)', 'border-radius:var(--radius, 12px)',
        'box-shadow:0 6px 24px rgba(0, 0, 0, 0.35)',
        'font-family:var(--font-body, system-ui, sans-serif)', 'font-size:0.95rem', 'line-height:1.4',
    ].join(';');

    const label = doc.createElement('span');
    label.textContent = text;
    box.appendChild(label);

    if (typeof onClick === 'function') {
        const reload = doc.createElement('button');
        reload.type = 'button';
        reload.textContent = 'Reload';
        reload.style.cssText = [
            'background:var(--accent, #6cc5a4)', 'color:var(--on-accent, #0e1013)', 'border:0',
            'border-radius:8px', 'padding:0.35rem 0.8rem', 'font:inherit', 'font-weight:600', 'cursor:pointer',
        ].join(';');
        reload.addEventListener('click', onClick);
        box.appendChild(reload);
    }

    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.style.cssText = [
        'background:transparent', 'color:var(--text-muted, #9aa0a8)', 'border:0', 'padding:0 0.25rem',
        'font-size:1.25rem', 'line-height:1', 'cursor:pointer',
    ].join(';');
    close.addEventListener('click', () => box.remove());
    box.appendChild(close);
    return box;
}

// Shows `box`, replacing an earlier toast; removes it after `ms` when given.
function showToast(box, ms = 0) {
    if (!document.body) return;
    const old = document.getElementById(TOAST_ID);
    if (old) old.remove();
    document.body.appendChild(box);
    if (ms > 0) setTimeout(() => box.remove(), ms);
}

// The site folder, e.g. https://gitcodingforme.github.io/aniimax/, which is the worker's scope.
function siteScope() {
    return new URL('./', window.location.href).href;
}

// Unregisters this site's worker (not other sites' on the same origin) and deletes its caches.
// Returns how many registrations were removed.
async function removeWorker() {
    let removed = 0;
    try {
        const scope = siteScope();
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const registration of registrations) {
            if (registration.scope === scope && await registration.unregister()) removed += 1;
        }
    } catch (_) { /* nothing registered */ }
    try {
        if (typeof caches !== 'undefined') {
            const names = await caches.keys();
            await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name)));
        }
    } catch (_) { /* no cache storage (private window) */ }
    return removed;
}

// Reads and clears the reload flag: { justReloaded, storageWorks }.
function takeReloadFlag() {
    try {
        const justReloaded = window.sessionStorage.getItem(RELOAD_FLAG) === '1';
        window.sessionStorage.removeItem(RELOAD_FLAG);
        return { justReloaded, storageWorks: true };
    } catch (_) {
        return { justReloaded: false, storageWorks: false };
    }
}

// Reloads once when the removed worker still controls this tab. Returns true when it reloads.
function reloadIfStillControlled(flag) {
    if (!needsReload({ controlled: navigator.serviceWorker.controller, ...flag })) return false;
    try {
        window.sessionStorage.setItem(RELOAD_FLAG, '1');
    } catch (_) {
        return false;
    }
    window.location.reload();
    return true;
}

// ?nosw: switch off, reload once if the old worker still controls the tab (keeping ?nosw, so the
// reloaded page cleans up again instead of registering), then clean the address bar and say so.
async function switchOff(flag) {
    await removeWorker();
    if (reloadIfStillControlled(flag)) return;
    const url = new URL(window.location.href);
    window.history.replaceState(window.history.state, '', url.pathname + withoutParam(url.search, 'nosw') + url.hash);
    showToast(toastElement('Offline mode switched off', null), 6000);
}

// Asks the worker to save what this page loaded (the first visit loads before the worker runs).
function warmUp(registration) {
    const worker = registration && registration.active;
    if (!worker) return;
    let loaded = [];
    try {
        loaded = performance.getEntriesByType('resource').map((entry) => entry.name);
    } catch (_) { /* no performance entries */ }
    const urls = sameOriginUrls([window.location.href, ...loaded], window.location.href);
    worker.postMessage({ type: 'aniimax-warm', urls });
}

async function turnOn() {
    try {
        await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
        warmUp(await navigator.serviceWorker.ready);
    } catch (error) {
        // Not available here (an insecure address, a private window, a blocked worker): the site
        // works as before, just without offline copies.
        console.debug('Offline support is not available:', error && error.message);
    }
}

function onMessage(event) {
    const data = event && event.data;
    if (!data) return;
    if (data.type === 'aniimax-updated') {
        showToast(toastElement('Site updated.', () => window.location.reload()));
    } else if (data.type === 'aniimax-reload') {
        window.location.reload();
    }
}

function start() {
    const flag = takeReloadFlag();
    if (switchOffRequested(window.location)) return switchOff(flag);
    if (shouldRegister(window.location)) return turnOn();
    // A local dev server without ?sw=on: make sure no worker from an earlier test is left, and
    // reload once if it was still serving this page from saved copies.
    if (isLocalHost(window.location.hostname)) {
        return removeWorker().then((removed) => {
            if (reloadIfStillControlled(flag)) return;
            if (removed) console.info('Offline support switched off on this local server (add ?sw=on to test it).');
        });
    }
    return undefined;
}

if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', onMessage);
    try {
        navigator.serviceWorker.startMessages();
    } catch (_) { /* messages start on their own after load */ }
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
}
