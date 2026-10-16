// "Is everything working?" card: one plain-words line per thing that can quietly go wrong (the
// build and whether its game data is behind the original, offline mode, browser storage, the last
// snapshot and profile backup, the screenshot watcher, reminders, notifications, the open game
// questions), each with a "what to do" hint. The wording and the decisions are in ../health.js
// (tested in tests/health.test.mjs); this file only reads and draws. It reads only: it never
// solves, never saves a snapshot, and never sends credentials with a request. A missing file is
// normal (reading.json and verification.json exist on the owner's PC only; version.json is
// missing on a local build), so a failed read is not logged. See web/panels.js for the card
// contract.
import {
    HEALTH_KEY, PROFILE_META_KEY, dismissBackup, healthLines, parseHealthState, summaryText,
} from '../health.js?v=fork-m10-2';
import { readCache } from '../upstream-check.js?v=fork-m10-2';

// A read that has not answered by then counts as "no answer", so the button never stays stuck.
const READ_TIMEOUT_MS = 8000;
const LEVEL_LABEL = { ok: 'OK', warn: 'Needs a look', info: 'Note' };
// Lines that depend on the files and browser answers read by refresh(); they wait for the first
// answer so the card never flashes "local build" or "offline mode is off" before it knows.
const READ_LATER = new Set(['build', 'offline', 'storage', 'watcher', 'questions']);

function withTimeout(promise, ms = READ_TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// A small JSON file next to the page, or null (missing, not JSON, offline, or too slow).
async function readJson(path) {
    try {
        if (typeof fetch !== 'function') return null;
        const response = await withTimeout(fetch(path, { cache: 'no-store', credentials: 'omit' }));
        if (!response || !response.ok) return null;
        return await withTimeout(response.json());
    } catch (_) {
        return null;
    }
}

async function readRegistration() {
    try {
        const workers = globalThis.navigator?.serviceWorker;
        if (!workers) return { unsupported: true };
        return (await withTimeout(workers.getRegistration())) || null;
    } catch (_) {
        return null;
    }
}

async function readEstimate() {
    try {
        const storage = globalThis.navigator?.storage;
        if (!storage || typeof storage.estimate !== 'function') return null;
        return (await withTimeout(storage.estimate())) || null;
    } catch (_) {
        return null;
    }
}

// The profile details the page keeps: {} when none are saved yet, null when they cannot be read.
function readMeta() {
    try {
        const raw = localStorage.getItem(PROFILE_META_KEY);
        if (raw === null) return {};
        const meta = JSON.parse(raw);
        return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
    } catch (_) {
        return null;
    }
}

// The page's own saved answer about the original repo (upstream-check.js); null when there is none.
function readUpstream(now) {
    try {
        return readCache(localStorage, now);
    } catch (_) {
        return null;
    }
}

function readPermission() {
    try {
        return typeof Notification === 'undefined' ? undefined : Notification.permission;
    } catch (_) {
        return undefined;
    }
}

const safely = (fn, fallback = null) => {
    try {
        return fn();
    } catch (_) {
        return fallback;
    }
};

export function mount(el, ctx) {
    ctx.addStylesheet('css/health.css');
    const esc = ctx.format.escape;
    el.innerHTML = `
        <div class="card-head">
            <h2>Is everything working?</h2>
            <div class="config-actions">
                <button type="button" id="health-refresh" class="toggle-button small">Check again</button>
            </div>
        </div>
        <p class="hint">A quick look at the site, your saved data and your reminders. It only reads: it never solves a plan or saves a snapshot.</p>
        <p id="health-summary" class="feature-status" role="status" aria-live="polite"></p>
        <ul id="health-lines" class="health-lines"></ul>`;
    const refreshBtn = el.querySelector('#health-refresh');
    const summary = el.querySelector('#health-summary');
    const list = el.querySelector('#health-lines');

    // What needs the network or an async browser call; filled by refresh().
    const net = { version: null, reading: null, verification: null, registration: undefined, estimate: null };
    let loaded = false;
    // The dismissal kept in memory too, so Dismiss still works for this visit when storage is blocked.
    let memoryState = null;

    function readState() {
        if (memoryState) return memoryState;
        try {
            return parseHealthState(localStorage.getItem(HEALTH_KEY));
        } catch (_) {
            return {};
        }
    }

    function dismiss() {
        const next = dismissBackup(readState(), Date.now());
        memoryState = next;
        try {
            localStorage.setItem(HEALTH_KEY, JSON.stringify(next));
        } catch (_) { /* storage blocked or full: the dismissal lasts until the page closes */ }
        render();
    }

    function render() {
        const now = Date.now();
        const all = healthLines({
            version: net.version,
            upstream: readUpstream(now),
            registration: net.registration,
            estimate: net.estimate,
            history: safely(() => ctx.getHistory()),
            meta: readMeta(),
            reading: net.reading,
            timers: safely(() => ctx.getTimers()),
            permission: readPermission(),
            verification: net.verification,
            state: readState(),
        }, now);
        const lines = loaded ? all : all.filter(l => !READ_LATER.has(l.key));
        summary.textContent = loaded ? summaryText(lines) : 'Checking...';
        list.innerHTML = lines.map(l => `
            <li class="health-line health-${l.level}" id="health-line-${l.key}">
                <span class="health-badge">${LEVEL_LABEL[l.level] || LEVEL_LABEL.info}</span>
                <div class="health-body">
                    <span class="health-text">${esc(l.text)}</span>
                    <span class="health-hint">${esc(l.hint)}</span>
                </div>
                ${l.dismissable ? '<button type="button" id="health-dismiss" class="toggle-button small">Dismiss for a week</button>' : ''}
            </li>`).join('');
        const dismissBtn = list.querySelector('#health-dismiss');
        if (dismissBtn) dismissBtn.addEventListener('click', dismiss);
    }

    let latest = 0;
    async function refresh() {
        const mine = ++latest;
        refreshBtn.disabled = true;
        summary.textContent = 'Checking...';
        try {
            const [version, reading, verification, registration, estimate] = await Promise.all([
                readJson('./version.json'), readJson('./reading.json'), readJson('./verification.json'),
                readRegistration(), readEstimate(),
            ]);
            if (mine !== latest) return; // a newer check has started; let it draw
            Object.assign(net, { version, reading, verification, registration, estimate });
            loaded = true;
        } finally {
            if (mine === latest) refreshBtn.disabled = false;
        }
        render();
    }

    refreshBtn.addEventListener('click', () => { refresh().catch(() => {}); });
    render();
    ctx.on('history', render, { replay: false });
    ctx.on('timers', render, { replay: false });
    refresh().catch(() => {});
}
