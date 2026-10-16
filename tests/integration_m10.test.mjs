// Milestone 10, wave 3: the page wiring for E-mode, the food reminder settings, the coins topic, the
// open game questions line, the health card, the Outlook links and the accessibility fixes. The page
// functions are sliced out of web/app.js (see helpers/app-source.mjs) and run with stubs; the
// markup is read from web/index.html as text, since there is no browser here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as facilityConfig from '../web/facility-config.js';
import * as shared from '../web/shared.js';
import * as setupInput from '../web/setup-input.js';
import { DEFAULT_ASSUMPTIONS, SETTINGS_KEY, WATERING_POINTS, outlookCalendarUrl } from '../web/reminders.js';
import { coinSeries } from '../web/history.js';
import { questionsSummary, verificationSummary } from '../web/screenshot-import.js';
import { CARDS } from '../web/panels.js';
import { appFunctions, appSource, declaration, plain } from './helpers/app-source.mjs';

const read = path => readFileSync(new URL(`../web/${path}`, import.meta.url), 'utf8');
const HTML = read('index.html');
// Whole-line comments are left out.
const code = source => source.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
// The opening tag of the element with this id.
const tagOf = id => HTML.match(new RegExp(`<[a-z0-9]+\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] || '';

// --- E-mode -----------------------------------------------------------------------------------

test('test_the_emode_inputs_are_in_the_advanced_setup_with_their_choices', () => {
    const advanced = HTML.slice(HTML.indexOf('<div id="advanced-config">'), HTML.indexOf('<div class="strategy">'));
    for (const id of ['emode-on', 'emode-generator-level', 'emode-generator-count', 'emode-supply']) {
        assert.ok(advanced.includes(`id="${id}"`), `#${id} sits in #advanced-config`);
    }
    assert.ok(advanced.indexOf('id="emode-on"') > advanced.indexOf('class="modules-grid"'), 'after the modules grid');
    assert.match(tagOf('emode-on'), /type="checkbox"/);
    assert.doesNotMatch(tagOf('emode-on'), /\bchecked\b/, 'E-mode is off by default');
    const options = id => [...HTML.slice(HTML.indexOf(`id="${id}"`)).split('</select>')[0].matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
    assert.deepEqual(options('emode-generator-level'), ['1', '2', '3', '4', '5']);
    assert.deepEqual(options('emode-supply'), ['100', '120']);
    assert.match(tagOf('emode-generator-count'), /type="number"[^>]*min="0" max="3"/);
    assert.match(advanced, /Experimental: E-mode times and power numbers are fan data, not verified in game\./);
    assert.match(tagOf('plan-power'), /class="hint" hidden/);
    assert.ok(HTML.indexOf('id="plan-power"') > HTML.indexOf('id="plan-explored-hint"'), 'beside the explored hint');
});

test('test_the_emode_fields_are_saved_and_the_cards_config_has_emode', () => {
    const app = appFunctions(['getPersistedFieldIds', 'pageConfigMemo', 'pageConfig', 'ABILITIES', 'MODULE_NAMES'], { ...facilityConfig });
    const ids = plain(app.getPersistedFieldIds());
    assert.deepEqual(ids.slice(-4), ['emode-on', 'emode-generator-level', 'emode-generator-count', 'emode-supply']);
    assert.equal(app.pageConfig().EMODE, facilityConfig.EMODE, 'the same frozen object facility-config.js exports');
});

test('test_emode_input_asks_the_shared_rule_and_adds_no_key_of_its_own', () => {
    assert.match(declaration('emodeInput').text, /return getPlanInputValues\(\)\.emode;/);
    assert.doesNotMatch(code(declaration('getPlanInputValues').text), /emode/, 'planInputFromSetup adds the key; the page adds no second copy');
    // planInputFromSetup on a saved setup with the four fields, as currentConfig() writes them.
    const config = { ...facilityConfig, abilities: [], modules: Object.keys(facilityConfig.MODULE_MAX_LEVELS) };
    const advanced = { 'mode-simple': false, 'mode-advanced': true, 'emode-on': true, 'emode-generator-level': '2', 'emode-generator-count': '1', 'emode-supply': '120' };
    assert.deepEqual(plain(setupInput.planInputFromSetup(advanced, config).emode), { generators: [{ level: 2, count: 1 }], supply: '120' });
    for (const off of [{ ...advanced, 'emode-on': false }, { ...advanced, 'emode-generator-count': '0' }, { ...advanced, 'mode-simple': true, 'mode-advanced': false }]) {
        assert.ok(!('emode' in setupInput.planInputFromSetup(off, config)));
    }
});

test('test_the_power_line_reads_the_plans_power_report', () => {
    const app = appFunctions(['powerLine'], { formatNumber: n => String(n) });
    assert.equal(app.powerLine({ used: 255, budget: 600, supply: 100, units: [{ facility: 'Mill', level: 2, count: 2, draw: 30 }, { facility: 'Kiln', level: 1, count: 1, draw: 15 }] }),
        'E-mode: 255 W of 600 W used at 100% supply; 3 electric units');
    assert.equal(app.powerLine({ used: 0, budget: 500, supply: 120, units: [] }), 'E-mode: 0 W of 500 W used at 120% supply; 0 electric units');
    assert.equal(app.powerLine({ used: 15, budget: 600, supply: 100, units: [{ count: 1 }] }), 'E-mode: 15 W of 600 W used at 100% supply; 1 electric unit');
    assert.equal(app.powerLine(undefined), '');
    assert.equal(app.powerLine({ used: 0, budget: 0, supply: 100, units: [] }), '');
    const display = declaration('displayPlan').text;
    assert.match(display, /getElementById\('plan-power'\)/);
    assert.match(display, /The backup planner does not use E-mode/);
});

test('test_electric_rows_get_the_e_tag_and_no_aniimo', () => {
    const app = appFunctions(['planRows', 'aniimoLabel', 'unverifiedRowKeys'], {
        prettyItem: n => n, prettyReason: r => r, FACILITIES: [], abilityDot: (a, l) => `${a}${l}`,
    });
    const html = app.planRows([
        { facility: 'Mill', facility_count: 1, item_name: 'flour', status: 'producing', electric: true, reason: 'sells; E-mode, no Aniimo' },
        { facility: 'Mill', facility_count: 1, item_name: 'flour', status: 'producing', aniimo: { ability: 'Wind', level: 1 }, reason: 'sells' },
    ]);
    assert.equal([...html.matchAll(/<span class="tag emode" title="E-mode: runs on electric power, no Aniimo">E<\/span>/g)].length, 1);
    assert.match(html, /none \(E-mode\)/);
    const css = read('style.css');
    assert.match(css, /\.tag\.emode\s*\{[^}]*var\(--accent\)/, 'coloured from the theme variables, so both themes');
});

test('test_turn_jobs_get_the_plans_power_report', () => {
    assert.match(declaration('homelandPieces').text, /allocateTurnFacilities\([^;]*takesTurns, plan\?\.power\)/);
    assert.match(declaration('renderFacilityPlan').text, /takesTurns,\s*(\/\/[^\n]*\s*)?plan\.power\s*\)/);
});

test('test_a_setup_without_the_emode_fields_leaves_emode_off', () => {
    assert.match(declaration('loadInputsFromStorage').text, /if \(!\(id in data\)\) \{\s*if \(id === 'emode-on'\) el\.checked = false;/);
});

test('test_electric_reminder_rows_say_e_mode_in_the_making_cell', () => {
    assert.match(declaration('renderReminders').text, /\$\{escapeText\(prettyItem\(r\.item\)\)\}\$\{r\.electric \? ' <span class="hint small">\(E-mode\)<\/span>' : ''\}/);
});

// --- food ------------------------------------------------------------------------------------

test('test_the_food_settings_sit_beside_the_watering_assumption', () => {
    assert.match(tagOf('assume-workers-fed'), /type="checkbox"[^>]*\bchecked\b/);
    assert.match(tagOf('assume-food-energy'), /type="number"/);
    assert.ok(HTML.includes('Workers are kept fed (no food cost is subtracted)'));
    assert.ok(HTML.includes('Food energy in the bowl now (optional, for a refill reminder)'));
    assert.ok(HTML.indexOf('id="assume-workers-fed"') > HTML.indexOf('id="assume-watering"'));
    assert.match(tagOf('reminders-food-note'), /hidden/);
});

test('test_the_reminder_settings_carry_workers_fed_and_food_energy', () => {
    const saved = new Map();
    const app = appFunctions(['readReminderSettings', 'foodEnergyOf'], {
        localStorage: { getItem: key => saved.get(key) ?? null }, DEFAULT_ASSUMPTIONS, WATERING_POINTS, SETTINGS_KEY,
    });
    assert.deepEqual([app.readReminderSettings().assumptions.workersFed, app.readReminderSettings().assumptions.foodEnergy], [true, null]);
    saved.set(SETTINGS_KEY, JSON.stringify({ assumptions: { workersFed: false, foodEnergy: '1200' } }));
    assert.deepEqual([app.readReminderSettings().assumptions.workersFed, app.readReminderSettings().assumptions.foodEnergy], [false, 1200]);
    saved.set(SETTINGS_KEY, JSON.stringify({ assumptions: { foodEnergy: -5 } }));
    assert.equal(app.readReminderSettings().assumptions.foodEnergy, null);
    for (const [value, want] of [['', null], ['abc', null], [0, null], [3.5, 3.5], [null, null]]) assert.equal(app.foodEnergyOf(value), want);
});

test('test_the_reminders_pass_the_bowl_snapshot_to_build_events', () => {
    let seen = null;
    const app = appFunctions(['reminderEvents'], {
        readTimers: () => null, readReminderSettings: () => ({ assumptions: { ...DEFAULT_ASSUMPTIONS } }), OUTPUT_CAPS: {},
        buildEvents: (rows, options) => { seen = options; return []; },
    });
    app.reminderEvents({ rows: [], startedAt: '2026-10-16T10:00:00Z', workers: 4, foodEnergy: 2400 });
    assert.equal(seen.workers, 4);
    assert.equal(seen.foodEnergy, 2400);
    const setUp = declaration('setUpPerPlan').text;
    assert.match(setUp, /workers: workingAniimo\(rows, \{ setup: selectedAniimoSetup\(\), tab: selectedSetupTab\(\), roster \}\)/);
    assert.match(setUp, /foodEnergy: assumptions\.foodEnergy/);
    const render = declaration('renderReminders').text;
    assert.match(render, /foodNote\(settings\)/);
    assert.match(code(appSource()), /\['assume-workers-fed', 'workersFed'\]/);
});

// --- coins, questions, Outlook -----------------------------------------------------------------

test('test_the_coins_poll_publishes_the_series_only_when_it_changed', async () => {
    const published = [];
    const body = { format: 'aniimax-coin-log', points: [{ t: '2026-10-16T10:00:00Z', coins: 100 }, { t: '2026-10-16T11:00:00Z', coins: 160 }] };
    const app = appFunctions(['LOCAL_COINS_URL', 'coinSeriesPoints', 'checkLocalCoins'], {
        fetch: async () => ({ ok: true, status: 200, json: async () => body }),
        coinSeries, renderCoinChart: () => {}, publish: (topic, value) => published.push([topic, value]),
    });
    assert.equal(await app.checkLocalCoins(), true);
    assert.equal(await app.checkLocalCoins(), true);
    assert.equal(published.length, 1, 'the second poll found no change');
    assert.equal(published[0][0], 'coins');
    assert.ok(Array.isArray(published[0][1]) && published[0][1].length === 2);
    assert.equal(published[0][1], app.coinSeriesPoints);
});

function fakeLines() {
    const els = { 'verification-line': { hidden: true, textContent: '' }, 'questions-line': { hidden: true, textContent: '' } };
    return { els, document: { getElementById: id => els[id] ?? null } };
}

test('test_the_questions_line_comes_from_the_same_verification_file', async () => {
    const { els, document } = fakeLines();
    let fetches = 0;
    const file = { format: 'aniimax-verification', observations: 4, agree: 3, disagree: 1, unknown: 0, questions: { total: 8, answered: 1, evidence: 2, open: 5 } };
    const app = appFunctions(['LOCAL_VERIFICATION_URL', 'checkLocalVerification'], {
        document, verificationSummary, questionsSummary,
        fetch: async () => { fetches++; return { ok: true, status: 200, json: async () => file }; },
    });
    assert.equal(await app.checkLocalVerification(), true);
    assert.equal(fetches, 1);
    assert.equal(els['questions-line'].textContent, '1 of 8 game questions answered, 2 waiting for you to check');
    assert.equal(els['questions-line'].hidden, false);
    assert.equal(els['verification-line'].hidden, false);
    assert.match(tagOf('questions-line'), /class="hint" hidden/);
    assert.ok(HTML.indexOf('id="questions-line"') > HTML.indexOf('id="verification-line"'));
});

test('test_a_missing_verification_file_hides_both_lines', async () => {
    const { els, document } = fakeLines();
    els['verification-line'].hidden = false;
    els['questions-line'].hidden = false;
    const app = appFunctions(['LOCAL_VERIFICATION_URL', 'checkLocalVerification'], {
        document, verificationSummary, questionsSummary, fetch: async () => ({ ok: false, status: 404 }),
    });
    assert.equal(await app.checkLocalVerification(), false);
    assert.equal(els['verification-line'].hidden, true);
    assert.equal(els['questions-line'].hidden, true);
});

test('test_each_reminder_has_an_outlook_link_beside_the_google_one', () => {
    const app = appFunctions(['outlookCalendarLink', 'escapeText'], { escapeHtml: shared.escapeHtml, outlookCalendarUrl });
    const event = { at: Date.parse('2026-10-16T12:00:00Z'), title: 'Collect <Mill>', body: 'b' };
    const link = app.outlookCalendarLink(event);
    assert.match(link, /^ <a href="https:\/\/outlook\.live\.com\/[^"]*" target="_blank" rel="noopener" class="hint small"[^>]*>Outlook<\/a>$/);
    assert.doesNotMatch(link, /<Mill>/);
    assert.equal(app.outlookCalendarLink({ title: 'no time' }), '');
    assert.match(declaration('renderReminders').text, /\$\{googleCalendarLink\(e\)\}\$\{outlookCalendarLink\(e\)\}/);
});

// --- health card ---------------------------------------------------------------------------------

test('test_the_health_card_container_follows_the_history_card', () => {
    assert.ok(CARDS.includes('health'));
    const after = HTML.slice(HTML.indexOf('id="history-card"'));
    const next = after.slice(after.indexOf('</section>') + '</section>'.length).trimStart();
    assert.ok(next.startsWith('<section class="card production-steps feature-card" id="health-card" hidden></section>'), next.slice(0, 120));
    assert.match(HTML, /<strong>Is everything working\?<\/strong>: shows the build, offline mode, storage, last snapshot and backup, watcher, reminders, notifications and open game questions, one line each with what to do; it only reads and changes nothing\./);
    const header = read('panels.js');
    assert.match(header, /upstream-check\.js, food\.js/);
});

test('test_the_help_has_emode_and_food_entries', () => {
    const help = HTML.slice(HTML.indexOf('id="helpModal"'));
    assert.match(help, /<strong>E-mode<\/strong>[^<]*\(experimental/);
    assert.match(help, /<strong>Food reminder<\/strong>/);
    const entry = name => help.slice(help.indexOf(`<strong>${name}</strong>`)).split('</li>')[0];
    for (const name of ['E-mode', 'Food reminder']) assert.match(entry(name), /fan (sites|data)/, `${name} says it is fan data`);
});

// --- accessibility --------------------------------------------------------------------------------

test('test_the_modals_are_labelled_dialogs_with_named_close_buttons', () => {
    for (const [modal, heading] of [['facilitiesModal', 'facilities-modal-title'], ['mathModal', 'math-modal-title'], ['helpModal', 'help-modal-title']]) {
        const tag = tagOf(modal);
        assert.match(tag, /role="dialog"/, modal);
        assert.match(tag, /aria-modal="true"/, modal);
        assert.match(tag, new RegExp(`aria-labelledby="${heading}"`), modal);
        assert.match(HTML, new RegExp(`<h2 id="${heading}">`));
    }
    assert.equal([...HTML.matchAll(/<button type="button" class="close-button" onclick="close\w+\(\)" aria-label="Close">/g)].length, 3);
});

test('test_modals_take_and_give_back_focus_and_close_on_escape', () => {
    const script = HTML.slice(HTML.indexOf('const modalOpeners'), HTML.indexOf('<script type="module" src="app.js'));
    assert.match(script, /modalOpeners\[id\] = document\.activeElement/);
    assert.match(script, /target\.focus\(\)/);
    assert.match(script, /opener\.focus\(\)/);
    assert.match(script, /e\.key === 'Escape'[\s\S]*closeModal\(open\.id\)/);
    assert.match(script, /e\.key !== 'Tab'/);
    for (const fn of ['showHelp', 'showMath']) assert.match(script, new RegExp(`window\\.${fn} = function\\(\\) \\{\\s*openModal\\(`));
    const source = code(appSource());
    assert.match(source, /window\.openModal\('facilitiesModal'\)/);
    assert.match(source, /window\.closeModal\('facilitiesModal'\)/);
});

test('test_errors_tips_theme_and_tier_buttons_are_accessible', () => {
    assert.match(tagOf('error-message'), /role="alert"/);
    assert.match(tagOf('themeToggle'), /aria-pressed="false"/);
    assert.doesNotMatch(tagOf('themeToggle'), /aria-label/, 'the visible word names it');
    assert.match(HTML, /button\.setAttribute\('aria-pressed', String\(light\)\)/);
    for (const [where, source] of [['index.html', HTML], ['app.js', appSource()]]) {
        const icons = [...source.matchAll(/<span class="info-icon"[^>]*>/g)].map(m => m[0]);
        assert.ok(icons.length >= 4, `${where} has info icons`);
        for (const icon of icons) assert.match(icon, /tabindex="0"/, `${where}: ${icon.slice(0, 60)}`);
    }
    assert.match(read('style.css'), /\[data-tooltip\]:focus-visible::after/);
    assert.match(declaration('renderTierRows').text, /class="tier-remove-btn"[^>]*aria-label="\$\{escapeText\(`Remove \$\{name\} level \$\{tier\.level\}`\)\}"/);
});

test('test_the_insight_and_session_tables_have_captions_and_column_scopes', () => {
    for (const path of ['cards/insight.js', 'cards/session.js']) {
        const source = code(read(path));
        const tables = [...source.matchAll(/<table\b[\s\S]*?<\/table>/g)].map(m => m[0]);
        assert.ok(tables.length >= 1, path);
        for (const table of tables) assert.match(table, /^<table[^>]*>\s*<caption class="visually-hidden">[^<]+<\/caption>/, path);
        for (const m of source.matchAll(/<th\b[^>]*>/g)) assert.match(m[0], /\bscope="(col|row)"/, `${path}: ${m[0]}`);
    }
    assert.match(read('css/features.css'), /\.visually-hidden\s*\{[^}]*clip:/);
});
