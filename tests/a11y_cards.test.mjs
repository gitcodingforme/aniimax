// Accessibility checks for the compare, coverage, goal-mode, roadmap, roster-advisor and what-if
// cards: the markup each card writes when it mounts, and the sources that write the rest of it
// later (tables are only drawn after a solve, which these tests do not run). There is no browser
// here, so these read strings: a caption on every table, a scope on every header cell, a label on
// every field, a role on every status line, and no style that removes the keyboard focus ring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    ANIIMO_MAX, ANIIPOD_TIERS, FACILITIES, FACILITY_CATEGORIES, FACILITY_UPGRADE_COSTS, LEVEL_UP_CHAINS, LEVEL_UP_COSTS, MAX_HOME_LEVEL,
    MODULE_MAX_LEVELS, OUTPUT_CAPS, SEASON, SPECIAL_RECIPES, simpleSetup, upgradeCost,
} from '../web/facility-config.js';
import { fakeContainer, fakeDocument, installGlobals, memoryStorage } from './helpers/fake-dom.mjs';

const CARDS = ['compare', 'coverage', 'goal-mode', 'roadmap', 'roster-advisor', 'what-if'];
const read = path => readFileSync(new URL(`../web/${path}`, import.meta.url), 'utf8');
// Whole-line comments are left out.
const code = source => source.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every file that writes one of these cards' markup (coverage's tables come from web/coverage.js).
const SOURCES = [...CARDS.map(name => `cards/${name}.js`), 'coverage.js'];

test('test_every_table_has_a_caption_and_every_header_cell_a_scope', () => {
    for (const path of SOURCES) {
        const source = code(read(path));
        const tables = [...source.matchAll(/<table\b/g)].length;
        const captions = [...source.matchAll(/<caption class="visually-hidden">/g)].length;
        assert.equal(captions, tables, `${path}: ${tables} tables, ${captions} captions`);
        for (const m of source.matchAll(/<table\b[\s\S]*?<\/table>/g)) {
            assert.match(m[0], /^<table[^>]*>\s*<caption/, `${path}: the caption is the first thing in the table`);
        }
        for (const m of source.matchAll(/<th\b[^>]*>/g)) {
            assert.match(m[0], /\bscope="(col|row)"/, `${path}: ${m[0]} has no scope`);
        }
    }
});

test('test_the_compare_table_names_its_empty_corner_cell', () => {
    const source = read('cards/compare.js');
    assert.doesNotMatch(source, /<th[^>]*><\/th>/, 'no empty header cell');
    assert.match(source, /<th scope="col">Setting<\/th>/);
});

test('test_each_card_stylesheet_defines_the_screen_reader_only_class', () => {
    for (const name of CARDS) {
        assert.match(read(`css/${name}.css`), /\.visually-hidden\s*\{[^}]*clip:/, `css/${name}.css hides captions visually only`);
    }
});

test('test_no_card_stylesheet_removes_the_focus_outline_and_each_styles_focus_visible', () => {
    for (const name of CARDS) {
        const css = read(`css/${name}.css`);
        for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
            assert.doesNotMatch(m[2], /outline\s*:\s*(none|0)\b/, `css/${name}.css removes an outline in "${m[1].trim()}"`);
        }
        assert.match(css, /:focus-visible\s*[,{]/, `css/${name}.css styles :focus-visible`);
    }
});

test('test_what_if_takes_the_top_aniimo_level_from_shared_js', () => {
    const source = code(read('cards/what-if.js'));
    assert.match(source, /import \{ MAX_ANIIMO_LEVEL \} from '\.\.\/shared\.js\?v=fork-m10-2'/);
    assert.doesNotMatch(source, /MAX_ABILITY_LEVEL/);
    assert.doesNotMatch(code(read('what-if.js')), /MAX_ABILITY_LEVEL/);
});

// --- the markup each card writes on mount ---------------------------------------------------

const config = {
    FACILITIES, FACILITY_CATEGORIES, OUTPUT_CAPS, LEVEL_UP_COSTS, LEVEL_UP_CHAINS, MODULE_MAX_LEVELS, MAX_HOME_LEVEL,
    ANIIMO_MAX, SPECIAL_RECIPES, SEASON, ANIIPOD_TIERS, FACILITY_UPGRADE_COSTS, upgradeCost, simpleSetup,
    abilities: [], modules: Object.keys(MODULE_MAX_LEVELS), moduleNames: {},
};
const ctx = {
    config,
    on: () => () => {},
    last: () => undefined,
    getSetup: () => ({}),
    getRoster: () => [],
    getHistory: () => [],
    isSimple: () => false,
    homeLevel: () => 5,
    items: () => Promise.resolve([]),
    solver: {},
    format: {
        number: n => String(n), duration: s => `${s}s`, item: n => String(n), escape: t => String(t), perHour: n => String(n),
    },
    addStylesheet: () => {},
};

async function markupOf(name, t) {
    t.after(installGlobals({ localStorage: memoryStorage(), document: fakeDocument() }));
    const { mount } = await import(`../web/cards/${name}.js`);
    const el = fakeContainer('section');
    await mount(el, ctx);
    return el.innerHTML;
}

for (const name of CARDS) {
    test(`test_card_${name.replace(/-/g, '_')}_labels_its_fields_and_buttons_and_marks_its_status_lines`, async (t) => {
        const html = await markupOf(name, t);
        assert.ok(html.length > 0);
        // Every field has a label that points at it, wraps it, or an aria-label.
        for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
            const attrs = m[2];
            if (/type="hidden"/.test(attrs)) continue;
            const id = attrs.match(/\bid="([^"]+)"/)?.[1];
            const wrapped = new RegExp(`<label\\b[^>]*>(?:(?!</label>)[\\s\\S])*${escapeRegExp(m[0])}`).test(html);
            const labelled = /\baria-label="[^"]+"/.test(attrs) || wrapped
                || (id && new RegExp(`<label[^>]*\\bfor="${escapeRegExp(id)}"`).test(html));
            assert.ok(labelled, `${name}: ${m[0]} has no label`);
        }
        // Every button has text or an aria-label.
        for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
            assert.ok(/\baria-label="[^"]+"/.test(m[1]) || m[2].replace(/<[^>]*>/g, '').trim(), `${name}: a button with no text`);
        }
        // Every status line is a live region.
        for (const m of html.matchAll(/<p\b[^>]*\bid="[^"]*status"[^>]*>/g)) {
            assert.match(m[0], /role="(status|alert)"/, `${name}: ${m[0]}`);
        }
    });
}

test('test_the_results_regions_of_the_solving_cards_start_not_busy', async (t) => {
    const regions = {
        compare: 'compare-results', 'goal-mode': 'goal-mode-results', roadmap: 'roadmap-table',
        'roster-advisor': 'roster-advisor-table', 'what-if': 'what-if-result', coverage: 'coverage-body',
    };
    for (const [name, id] of Object.entries(regions)) {
        const html = await markupOf(name, t);
        assert.match(html, new RegExp(`id="${id}"[^>]*aria-busy="false"`), `${name}: #${id} announces when it is busy`);
    }
});

test('test_the_cards_run_their_busy_state_through_aria_busy', () => {
    for (const [name, pattern] of [
        ['compare', /resultsEl\.setAttribute\('aria-busy', 'true'\)/],
        ['goal-mode', /resultsEl\.setAttribute\('aria-busy', running \? 'true' : 'false'\)/],
        ['roadmap', /tableEl\.setAttribute\('aria-busy', running \? 'true' : 'false'\)/],
        ['roster-advisor', /tableEl\.setAttribute\('aria-busy', running \? 'true' : 'false'\)/],
        ['what-if', /resultEl\.setAttribute\('aria-busy', 'true'\)/],
        ['coverage', /body\.setAttribute\('aria-busy', 'true'\)/],
    ]) {
        assert.match(code(read(`cards/${name}.js`)), pattern, `${name} sets aria-busy while it works`);
    }
});

test('test_error_text_is_announced_as_an_alert', () => {
    assert.match(code(read('cards/what-if.js')), /class="what-if-fail" role="alert"/);
    assert.match(code(read('cards/goal-mode.js')), /class="goal-mode-bad" role="alert"/);
    for (const name of ['compare', 'what-if']) {
        assert.match(code(read(`cards/${name}.js`)), /setAttribute\('role', isError \? 'alert' : 'status'\)/, name);
    }
});
