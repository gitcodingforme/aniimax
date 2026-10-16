// Mounts every feature card in web/panels.js CARDS the way the page does, in Node, with a fake
// container and a stand-in for ctx (the contract is in web/panels.js and
// docs/plans/card-contract.md). It cannot see the screen, but it catches the failures that keep a
// card hidden on the live page: a missing import or export, a lookup of an element the card never
// wrote, a stylesheet that does not exist, a solve that starts without a click, a console.error,
// a card that does not survive blocked storage. Then it feeds the cards a plan, a history, running
// reminders and no plan at all, and checks that each card reacts and stays quiet.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
    ANIIMO_MAX, ANIIPOD_TIERS, FACILITIES, FACILITY_CATEGORIES, FACILITY_UPGRADE_COSTS, LEVEL_UP_CHAINS, LEVEL_UP_COSTS, MAX_HOME_LEVEL,
    MODULE_MAX_LEVELS, OUTPUT_CAPS, SEASON, SPECIAL_RECIPES, simpleSetup, upgradeCost,
} from '../web/facility-config.js';
import { makeSnapshot, predictionFrom, setupHash } from '../web/history.js';
import { CARDS } from '../web/panels.js';
import { DEFAULT_ASSUMPTIONS, planRows } from '../web/reminders.js';
import { planInputFromSetup } from '../web/setup-input.js';
import { blockedStorage, fakeContainer, fakeDocument, installGlobals, memoryStorage } from './helpers/fake-dom.mjs';

// --- the context a card is given ------------------------------------------------------------

// The keys of the card contract (web/panels.js header). The test below fails when a card reaches
// for a key that is not on these lists, which is the cue to update the contract and this file.
const CONTEXT_KEYS = [
    'config', 'on', 'last', 'getSetup', 'getRoster', 'getRecipes', 'getHistory', 'getCoinSeries', 'getTimers', 'getReminderSettings',
    'isSimple', 'homeLevel', 'items', 'saveSnapshot', 'solver', 'format', 'addStylesheet',
];
const SOLVER_KEYS = ['findPlan', 'rank', 'timeOver', 'timeTo'];
const FORMAT_KEYS = ['number', 'duration', 'item', 'escape', 'perHour'];

// app.js's ABILITIES (names only, the page's order) and MODULE_NAMES: the names featureContext hands out.
const ABILITY_NAMES = ['Fire', 'Grass', 'Water', 'Earth', 'Lightning', 'Ice', 'Wind', 'Dark', 'Light', 'Hauling', 'Artisanship', 'Leisure', 'Perfumery'];
const MODULE_NAMES = {
    ecological_module: 'Ecological Module',
    kitchen_module: 'Kitchen Module',
    resource_detector: 'Resource Detector',
    crafting_module: 'Crafting Module',
};

// ctx.config as featureContext builds it in app.js.
const pageConfig = {
    FACILITIES, FACILITY_CATEGORIES, OUTPUT_CAPS, LEVEL_UP_COSTS, LEVEL_UP_CHAINS, MODULE_MAX_LEVELS, MAX_HOME_LEVEL,
    ANIIMO_MAX, SPECIAL_RECIPES, SEASON, ANIIPOD_TIERS, FACILITY_UPGRADE_COSTS, upgradeCost, simpleSetup,
    abilities: [...ABILITY_NAMES],
    modules: Object.keys(MODULE_MAX_LEVELS),
    moduleNames: { ...MODULE_NAMES },
};
const CONFIG_KEYS = Object.keys(pageConfig);

// ctx.format, as small as the page's own (formatNumber, formatDuration, prettyItem, escapeHtml, perHour).
const format = {
    number: n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }),
    duration: (seconds) => {
        const minutes = Math.ceil(seconds / 60);
        const days = Math.floor(minutes / 1440);
        const hours = Math.floor((minutes % 1440) / 60);
        if (days > 0) return `${days}d ${hours}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        return `${minutes % 60}m`;
    },
    item: name => (name ? String(name).split('_').map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ') : name),
    escape: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    perHour: (perSecond) => {
        const hourly = perSecond * 3600;
        return hourly < 10 ? hourly.toFixed(1) : Math.round(hourly).toLocaleString('en-US');
    },
};

// --- fixtures -------------------------------------------------------------------------------

// A local afternoon in the middle of the game's life; mocked clocks start here.
const NOW = new Date(2026, 9, 16, 9, 0, 0).getTime();
const HOUR = 3_600_000;

// What currentConfig() in app.js saves for an advanced-mode player levelling up to RV 6.
const SETUP = {
    facilityTiers: { Farmland: [{ count: 9, level: 3 }], Mine: [{ count: 2, level: 3 }], 'Carousel Mill': [{ count: 1, level: 2 }] },
    levelUpStock: { coins: 1200, rice: 10, rock: 10 },
    skippedRecipes: ['quick_potato'],
    unlockedSpecial: [],
    priorities: [{ target: 'coins', on: true }],
    aniimoLevels: { Earth: 2, Fire: 3 },
    roster: [{ name: 'Mochi', count: 2, abilities: { Earth: 4, Grass: 3 }, personalities: [] }],
    'strategy-level-up': true, 'strategy-priorities': false, 'level-up-target': '6',
    'mode-simple': false, 'mode-advanced': true, 'home-level': '5',
    'ecological-module-level': '1', 'kitchen-module-level': '2', 'resource-detector-level': '0', 'crafting-module-level': '0',
    'season-on': false, 'season-currency-per-day': '', 'aniimo-best': true, 'aniimo-minimum': false, 'aniimo-custom': false,
};

// The planner's answer (JsProductionPlan in src/wasm.rs), reduced to what the cards read.
const PLAN = {
    success: true,
    rate_per_second: 0.9,
    proven_optimal: true,
    measure_top: { measure: 'coins', objective: 3240, proven: true },
    coin_items: [
        { item_name: 'rice', facility: 'Farmland', facility_count: 9, status: 'producing', is_grower: true, cycle_time: 7200, busy_units: 9 },
        { item_name: 'rock', facility: 'Mine', facility_count: 2, status: 'producing', is_grower: true, cycle_time: 600, busy_units: 1.5 },
        { item_name: 'milled_rice', facility: 'Carousel Mill', facility_count: 1, status: 'producing', is_grower: false, cycle_time: 600, busy_units: 1 },
        { item_name: null, facility: 'Well', facility_count: 1, status: 'idle', is_grower: true, cycle_time: null },
    ],
    income_streams: [{ item_name: 'milled_rice', lead_time_seconds: 2000 }],
    level_up: { seconds: 25200, requirements: [
        { name: 'rice', need: 40, have: 10, per_second: 0.01, seconds: 3000 },
        { name: 'rock', need: 10, have: 10, per_second: 0.01, seconds: 0 },
        { name: 'coins', need: 5000, have: 1200, per_second: 1, seconds: 3800 },
    ] },
};
const PLAN_CONTEXT = { levelUp: true, target: 6, ready: false, unavailable: null, aniipod: null, hasPolisher: false, skipped: ['quick_potato'], simple: false };
const RECIPES = [
    { name: 'rice', facility: 'Farmland', yield_amount: 18, facility_level: 3 },
    { name: 'rock', facility: 'Mine', yield_amount: 6, facility_level: 1 },
    { name: 'milled_rice', facility: 'Carousel Mill', yield_amount: 1, facility_level: 2 },
];

// The same player in Simple mode: everything RV 5 allows, nothing typed in.
const SIMPLE_SETUP = { ...SETUP, 'mode-simple': true, 'mode-advanced': false };

// The 'plan' topic's value (app.js planSnapshot): the input is the real one for SETUP (or, with
// `simple`, for the same player in Simple mode).
function planValue({ tab = 'best', simple = false } = {}) {
    const setup = simple ? SIMPLE_SETUP : SETUP;
    return structuredClone({
        plan: PLAN,
        input: planInputFromSetup(setup, pageConfig, { aniimoTab: tab }),
        setup: tab === 'custom' ? `roster:${JSON.stringify(ROSTER.map(({ name, ...aniimo }) => aniimo))}` : 'best:Earth2,Fire3',
        tab,
        context: { ...PLAN_CONTEXT, simple },
        setupHash: setupHash(setup),
        solvedAt: NOW - 60_000,
    });
}

// Two snapshots a day apart, the first with a prediction, and a few of the watcher's coin points.
const HISTORY = [
    makeSnapshot({ setup: SETUP, actual: { rv: 4, coins: 800 }, predicted: predictionFrom(PLAN, PLAN_CONTEXT), now: new Date(NOW - 40 * HOUR) }),
    makeSnapshot({ setup: SETUP, actual: { rv: 5, coins: 9000 }, predicted: predictionFrom(PLAN, PLAN_CONTEXT), now: new Date(NOW - 16 * HOUR) }),
];
const COIN_SERIES = [
    { t: NOW - 40 * HOUR, coins: 800 },
    { t: NOW - 30 * HOUR, coins: 4000 },
    { t: NOW - 16 * HOUR, coins: 9000 },
    { t: NOW - 2 * HOUR, coins: 12000 },
];
const ROSTER = [{ name: 'Mochi', count: 2, abilities: { Earth: 4, Grass: 3 }, personalities: [] }];

// Running reminders for PLAN, started an hour ago (reminders.js planRows is the page's own).
function timersValue() {
    const facilities = { Farmland: [{ count: 9, level: 3 }], Mine: [{ count: 2, level: 3 }], 'Carousel Mill': [{ count: 1, level: 2 }] };
    return {
        startedAt: new Date(NOW - HOUR).toISOString(), planHash: 'h', rows: planRows(PLAN, { recipes: RECIPES, facilities }),
        levelUpSeconds: 25200, levelUpTarget: 6, sent: [], sentTopic: null,
    };
}

// --- the stand-ins --------------------------------------------------------------------------

// A bus like web/bus.js, but private to one test (the real one keeps its values for the whole
// process). A listener that throws is warned about, as the real one does.
function localBus() {
    const values = new Map();
    const listeners = new Map();
    return {
        publish(topic, value) {
            values.set(topic, value);
            for (const entry of [...(listeners.get(topic) || [])]) {
                try {
                    entry.fn(value);
                } catch (error) {
                    console.warn(`A listener for "${topic}" failed:`, error);
                }
            }
        },
        on(topic, fn, { replay = true } = {}) {
            if (typeof fn !== 'function') throw new TypeError('on() needs a listener function');
            const entry = { fn };
            if (!listeners.has(topic)) listeners.set(topic, new Set());
            listeners.get(topic).add(entry);
            if (replay && values.has(topic)) {
                try {
                    fn(values.get(topic));
                } catch (error) {
                    console.warn(`A listener for "${topic}" failed:`, error);
                }
            }
            return () => listeners.get(topic).delete(entry);
        },
        last: topic => values.get(topic),
    };
}

// The solver ctx hands out, minus the workers: every call is recorded and, unless `respond` is set
// to a function, never answers. A card that solves without a click shows up in `calls`.
function recordingSolver() {
    const solver = { calls: [], respond: null };
    for (const kind of SOLVER_KEYS) {
        solver[kind] = (...args) => {
            solver.calls.push({ kind, args });
            return solver.respond ? Promise.resolve(solver.respond(kind, args)) : new Promise(() => {});
        };
    }
    return solver;
}

// Everything a mounted card can be given, with `fixtures` the getters read from, so a test can
// change what they return between steps.
function makeContext() {
    const bus = localBus();
    bus.publish('plan', null);
    bus.publish('history', []);
    bus.publish('timers', null);
    const solver = recordingSolver();
    const fixtures = { timers: null, history: structuredClone(HISTORY) };
    const stylesheets = [];
    const snapshots = [];
    const ctx = {
        config: pageConfig,
        on: bus.on,
        last: bus.last,
        getSetup: () => structuredClone(SETUP),
        getRoster: () => structuredClone(ROSTER),
        getRecipes: () => structuredClone(RECIPES),
        getHistory: () => structuredClone(fixtures.history),
        getCoinSeries: () => structuredClone(COIN_SERIES),
        getTimers: () => structuredClone(fixtures.timers),
        getReminderSettings: () => ({ tab: false, ntfyTopic: '', assumptions: { ...DEFAULT_ASSUMPTIONS } }),
        isSimple: () => false,
        homeLevel: () => 5,
        items: () => Promise.resolve([]),
        saveSnapshot: (note) => { snapshots.push(note); return null; },
        solver,
        format,
        addStylesheet: (href) => { stylesheets.push(href); },
    };
    return { ctx, bus, solver, fixtures, stylesheets, snapshots };
}

// Globals, clocks and console for one test, all put back when it ends. Returns what was recorded.
function startEnvironment(t, { storage = memoryStorage() } = {}) {
    const errors = [];
    const warnings = [];
    // Node's own warnings (Node 22 prints "ExperimentalWarning: The MockTimers API..." through
    // console.error) are not a card's errors.
    const fromNode = (args) => args.some((a) => /ExperimentalWarning|--trace-warnings/.test(String(a)));
    t.mock.method(console, 'error', (...args) => { if (!fromNode(args)) errors.push(args); });
    t.mock.method(console, 'warn', (...args) => { if (!fromNode(args)) warnings.push(args); });
    // daily's card sets an interval to turn lines overdue; the mock keeps it from holding the process.
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: NOW });
    t.after(installGlobals({ localStorage: storage, document: fakeDocument() }));
    return { errors, warnings };
}

// Lets promises and zero-delay callbacks settle (setImmediate is not mocked).
async function settle() {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}

const importCard = name => import(new URL(`../web/cards/${name}.js`, import.meta.url).href);
const piece = (el, selector) => {
    const node = el.found.get(selector);
    assert.ok(node, `the card never looked up ${selector}`);
    return node;
};
const lines = list => list.map(args => args.map(a => (a instanceof Error ? a.stack : String(a))).join(' ')).join('\n');

// What each card should show once it has the plan, the history and the reminders: proof that the
// topics reach it and are drawn, not only that nothing threw.
const REACTIONS = {
    daily: (el) => {
        assert.match(piece(el, '#daily-groups').innerHTML, /daily-item/, 'a list of lines for today');
        assert.match(piece(el, '#daily-count').textContent, /\d+ of \d+ done/);
    },
    roadmap: (el) => {
        assert.match(piece(el, '#roadmap-status').textContent, /Checks up to/, 'ready to check');
        assert.equal(piece(el, '#roadmap-check').disabled, false, 'a plan is on screen, so Check upgrades is on');
    },
    coverage: (el) => {
        assert.match(el.innerHTML, /coverage-details/);
    },
    'goal-mode': (el) => {
        assert.equal(piece(el, '#goal-mode-run').disabled, false, 'a plan is on screen, so Work it out is on');
        assert.notEqual(piece(el, '#goal-mode-rv').value, '', 'the target RV is filled in');
    },
    'what-if': (el) => {
        assert.match(piece(el, '#what-if-form').innerHTML, /Farmland/, 'the form is filled from the plan');
        assert.equal(piece(el, '#what-if-try').disabled, false);
    },
    'roster-advisor': (el) => {
        assert.equal(piece(el, '#roster-advisor-hint').hidden, true, 'the My Aniimo hint goes away on the My Aniimo tab');
        assert.equal(piece(el, '#roster-advisor-run').disabled, false);
    },
    session: (el) => {
        assert.match(piece(el, '#session-status').textContent, /press Plan it/);
        assert.equal(piece(el, '#session-run').disabled, false);
    },
    insight: (el) => {
        assert.match(piece(el, '#insight-status').textContent, /stretch/, 'two snapshots make one stretch to compare');
        assert.match(piece(el, '#insight-table').innerHTML, /<table/);
    },
    streaks: (el) => {
        assert.match(piece(el, '#streaks-body').innerHTML, /feature-chips/, 'streak chips from the snapshots');
    },
    compare: (el) => {
        assert.match(piece(el, '#compare-snapshot').innerHTML, /<option value="[^"]+">/, 'the snapshots are listed');
    },
};

// Brings a card up in a fresh environment and returns it with the checks to run as the page publishes.
// `expectQuiet: false` lets a card warn (it does when it meets blocked storage); errors never pass.
async function mountAndFollow(name, t, { storage, expectQuiet = true } = {}) {
    const env = startEnvironment(t, { storage });
    const { ctx, bus, solver, fixtures, stylesheets, snapshots } = makeContext();
    const mod = await importCard(name);
    assert.equal(typeof mod.mount, 'function', `cards/${name}.js exports mount(el, ctx)`);
    const el = fakeContainer('section');
    el.setAttribute('hidden', '');
    await mod.mount(el, ctx);
    await settle();

    const quiet = (when) => {
        assert.equal(env.errors.length, 0, `console.error ${when}:\n${lines(env.errors)}`);
        if (expectQuiet) assert.equal(env.warnings.length, 0, `console.warn ${when}:\n${lines(env.warnings)}`);
        assert.deepEqual(solver.calls.map(c => c.kind), [], `a solve started ${when} without a click`);
        assert.deepEqual(snapshots, [], `a snapshot was saved ${when} without a click`);
        assert.ok(el.innerHTML.length > 0, `the card still has content ${when}`);
    };
    return { el, ctx, bus, solver, fixtures, stylesheets, env, quiet, mod };
}

// --- tests ----------------------------------------------------------------------------------

test('test_the_test_context_has_every_contract_key', () => {
    const { ctx } = makeContext();
    assert.deepEqual(Object.keys(ctx).sort(), [...CONTEXT_KEYS].sort());
    assert.deepEqual(Object.keys(ctx.config).sort(), [...CONFIG_KEYS].sort());
    assert.deepEqual(Object.keys(ctx.solver).filter(k => SOLVER_KEYS.includes(k)).sort(), [...SOLVER_KEYS].sort());
    assert.deepEqual(Object.keys(ctx.format).sort(), [...FORMAT_KEYS].sort());
    // Every plain key of the contract's config block is really there (not undefined).
    for (const key of ['config', 'on', 'last', 'solver', 'format']) assert.ok(ctx[key], key);
    for (const key of CONFIG_KEYS) assert.ok(ctx.config[key] !== undefined, `ctx.config.${key}`);
    assert.equal(ctx.config.abilities.length, 13);
    assert.deepEqual(ctx.config.modules, Object.keys(ctx.config.moduleNames));
});

test('test_cards_only_reach_for_keys_the_contract_lists', () => {
    const problems = [];
    for (const name of CARDS) {
        // Whole-line comments are left out: they may name keys on purpose.
        const source = readFileSync(new URL(`../web/cards/${name}.js`, import.meta.url), 'utf8')
            .split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
        const add = (what, listed, found) => {
            for (const key of new Set(found)) if (!listed.includes(key)) problems.push(`cards/${name}.js uses ${what}${key}`);
        };
        add('ctx.', CONTEXT_KEYS, [...source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
        add('ctx.config.', CONFIG_KEYS, [...source.matchAll(/\bctx\.config\??\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
        add('ctx.solver.', SOLVER_KEYS, [...source.matchAll(/\bctx\.solver\??\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
        add('ctx.format.', FORMAT_KEYS, [...source.matchAll(/\bctx\.format\??\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
        for (const m of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*ctx\.format\b/g)) {
            add('ctx.format.', FORMAT_KEYS, m[1].split(',').map(s => s.split(':')[0].trim()).filter(Boolean));
        }
        // `const cfg = ctx.config;` is how what-if.js names it.
        const alias = source.match(/const\s+(\w+)\s*=\s*ctx\.config\s*;/)?.[1];
        if (alias) add(`${alias}. (ctx.config) `, CONFIG_KEYS, [...source.matchAll(new RegExp(`\\b${alias}\\??\\.([A-Za-z_$][\\w$]*)`, 'g'))].map(m => m[1]));
    }
    assert.deepEqual(problems, []);
});

for (const name of CARDS) {
    test(`test_card_${name.replace(/-/g, '_')}_mounts_quietly_and_follows_the_topics`, async (t) => {
        const run = await mountAndFollow(name, t);
        const { el, bus, fixtures, stylesheets, solver, quiet } = run;

        // Mounted: markup written, stylesheet asked for and present, nothing started.
        assert.ok(stylesheets.includes(`css/${name}.css`), `cards/${name}.js asks for css/${name}.css through ctx.addStylesheet (asked for: ${stylesheets.join(', ') || 'nothing'})`);
        assert.ok(existsSync(new URL(`../web/css/${name}.css`, import.meta.url)), `web/css/${name}.css exists`);
        assert.ok(el.hasAttribute('hidden'), 'mount leaves showing the card to panels.js');
        quiet('after mount');

        // Every #id the card looked up is in the markup it wrote (the fake hands out a node for any
        // selector, a browser would give null and the card would throw).
        const missing = el.queried.filter(s => /^#[\w-]+$/.test(s)).filter(s => !new RegExp(`\\bid="${s.slice(1)}"`).test(el.innerHTML));
        assert.deepEqual(missing, [], 'selectors for ids the markup does not contain');

        // The page publishes a plan (My Aniimo tab), then reminders and history.
        bus.publish('plan', planValue({ tab: 'custom' }));
        await settle();
        quiet('after a plan');
        fixtures.timers = timersValue();
        bus.publish('timers', fixtures.timers);
        bus.publish('history', fixtures.history);
        await settle();
        quiet('after reminders and history');
        REACTIONS[name]?.(el);

        // A minute passes (daily's refresh), a different plan arrives, then none.
        t.mock.timers.tick(60_000);
        await settle();
        quiet('after a minute');
        bus.publish('plan', planValue({ tab: 'best' }));
        await settle();
        quiet('after a plan on another tab');
        bus.publish('plan', planValue({ tab: 'minimum', simple: true }));
        await settle();
        quiet('after a Simple mode plan');
        bus.publish('plan', null);
        await settle();
        quiet('after the plan was cleared');
        bus.publish('timers', null);
        fixtures.timers = null;
        bus.publish('history', []);
        await settle();
        quiet('after reminders and history were cleared');
        assert.equal(solver.calls.length, 0);
    });
}

test('test_every_card_survives_blocked_local_storage', async (t) => {
    for (const name of CARDS) {
        await t.test(name, async (sub) => {
            // Reading the global itself throws, so every storage access in a card has to be guarded.
            const run = await mountAndFollow(name, sub, { storage: blockedStorage(), expectQuiet: false });
            const { el, bus, fixtures, solver, quiet } = run;
            quiet('after mount with blocked storage');
            bus.publish('plan', planValue());
            fixtures.timers = timersValue();
            bus.publish('timers', fixtures.timers);
            await settle();
            quiet('after a plan with blocked storage');

            // Touch every control the card looked up: each 'change' and 'input' listener, and the
            // daily card's two buttons (they write the ticks). None of these may throw or solve.
            const touched = [];
            const visit = (node, depth = 0) => {
                for (const [type, fn] of node.added) {
                    if (type === 'change' || type === 'input' || type === 'toggle' || (name === 'daily' && type === 'click')) {
                        touched.push(type);
                        fn({ target: node, key: '', preventDefault() {} });
                    }
                }
                if (depth < 3) for (const child of node.found?.values() ?? []) visit(child, depth + 1);
            };
            visit(el);
            await settle();
            assert.equal(run.env.errors.length, 0, `console.error after touching the controls:\n${lines(run.env.errors)}`);
            assert.equal(solver.calls.length, 0, 'touching the controls solved something');
            assert.ok(el.innerHTML.length > 0);
            sub.diagnostic(`${run.env.warnings.length} warning(s) logged, ${touched.length} listener(s) touched`);
        });
    }
});
