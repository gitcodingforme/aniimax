// Feature cards: loads each card's module and mounts it into its hidden container in index.html.
// Tested in tests/panels.test.mjs. The same contract, with the plan topic's shape, is in
// docs/plans/card-contract.md.
//
// CARD CONTRACT
// A card is web/cards/<name>.js exporting `mount(el, ctx)` (may be async). `el` is the card's
// container, `<section class="card production-steps feature-card" id="<name>-card" hidden>`; it is
// shown only after mount() returns without throwing. A card that fails to load or throws stays
// hidden, and the other cards still mount.
// Pure logic lives in web/<name>.js, styles in web/css/<name>.css loaded with
// ctx.addStylesheet('css/<name>.css'), tests in tests/<name>.test.mjs (node:test, assert/strict).
// Logic modules import only pure modules (reminders.js, history.js, profile.js, plan-summary.js,
// share-config.js, setup-input.js, and shared.js, the one copy of each rule the page and the
// worker use too) and take data and solver functions as arguments. facility-config.js is NOT
// imported: use ctx.config, which holds the copies with data/overrides/structure.json applied
// (a second import would be a second, unpatched copy). Never import app.js, i18n.js or bus.js
// either: use ctx.on / ctx.last.
// Every relative import carries the same ?v= tag as app.js (today ?v=fork-m10-1); from
// web/cards/ that is e.g. `import { summarizePlan } from '../plan-summary.js?v=fork-m10-1';`.
// Ids and input names inside a card are prefixed with the card name (`roadmap-target`).
// Every localStorage access sits in try/catch. Never start a solve without a click; on a new
// 'plan' value mark results stale, do not re-solve. Write plain English: the page translates
// what it knows and leaves the rest as it is; add no locale keys. Build markup with
// ctx.format.escape around anything that is not your own fixed text.
//
// ctx = {
//   config: { FACILITIES, FACILITY_CATEGORIES, OUTPUT_CAPS, LEVEL_UP_COSTS, LEVEL_UP_CHAINS,
//     MODULE_MAX_LEVELS, MAX_HOME_LEVEL, ANIIMO_MAX, SPECIAL_RECIPES, SEASON, ANIIPOD_TIERS,
//     FACILITY_UPGRADE_COSTS, upgradeCost(facility, from, to), simpleSetup(rv),
//     abilities: [ability names], modules: [module ids], moduleNames: { id: display name } }
//     (the page's own, override-patched objects: read them, never change them),
//   on(topic, fn, { replay = true }) -> unsubscribe, last(topic),
//   getSetup() (a JSON copy of the saved inputs, currentConfig() in app.js), getRoster(),
//   getRecipes() (the recipe index the reminders use), getHistory() (snapshots, oldest first),
//   getCoinSeries() (watcher coin points), getTimers() (running reminders or null),
//   getReminderSettings(), isSimple(), homeLevel() (the RV level input),
//   items() (Promise of the worker's get_all_items, parsed), saveSnapshot(note) -> snapshot|null,
//   solver: createSolver({ workerUrl }) from solve.js, shared by every card and the page's own
//     Opportunities ranking (two plan and ranking workers at most, queued beyond that, the page's
//     background ranking behind the cards' requests, plus one time_to_reach helper of its own that
//     never waits for them and is stopped after 60 s idle):
//     findPlan(input, { onProgress, timeoutMs = 300000, signal }), rank(measure, base, inputs,
//     { onResult, onBase, baseTop, workers, timeoutMs = 300000, signal, background }),
//     timeOver(plan, seconds, { timeoutMs = 60000, signal }),
//     timeTo(plan, target, current, { timeoutMs = 60000, signal }); a timed-out or cancelled time
//     request rejects with Error('timed out') or Error('cancelled') and replaces the helper,
//   format: { number, duration (seconds -> '1h 5m'), item (snake_case -> 'Quick Wheat'),
//     escape (text -> safe for innerHTML), perHour (per second -> per hour text) },
//   addStylesheet(href),
// }
// Topics: 'plan' is { plan, input, setup, tab, context, setupHash, solvedAt } or null (no plan
// on screen, or the solve failed); 'history' is the snapshot list; 'timers' the reminders or
// null. Each has a value from startup, so on() with replay always calls back at once.

// The page's own ?v= tag (from how app.js imported this file), passed on to cards and styles.
const tag = new URL(import.meta.url).search;

export const CARDS = ['daily', 'roadmap', 'coverage', 'goal-mode', 'what-if', 'roster-advisor', 'session', 'insight', 'streaks', 'compare'];

// Mounts every card whose container is on the page. Resolves with the names that mounted.
export async function mountCards(ctx, {
    importCard = name => import(`./cards/${name}.js${tag}`),
    getElement = id => document.getElementById(id),
} = {}) {
    const mounted = await Promise.all(CARDS.map(async (name) => {
        const el = getElement(`${name}-card`);
        if (!el) return null;
        try {
            const mod = await importCard(name);
            if (typeof mod?.mount !== 'function') throw new Error(`cards/${name}.js has no mount(el, ctx) export`);
            await mod.mount(el, ctx);
            el.removeAttribute('hidden');
            return name;
        } catch (err) {
            console.warn(`card ${name} not loaded`, err);
            return null;
        }
    }));
    return mounted.filter(Boolean);
}

const stylesheets = new Map();

// Adds `<link rel="stylesheet" href="<href>?v=...">` to the page once per href (later calls get
// the same element). `href` is relative to index.html, e.g. 'css/roadmap.css'.
export function addStylesheet(href, { doc = globalThis.document } = {}) {
    if (stylesheets.has(href)) return stylesheets.get(href);
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = tag && href.includes('?') ? `${href}&${tag.slice(1)}` : `${href}${tag}`;
    doc.head.appendChild(link);
    stylesheets.set(href, link);
    return link;
}
