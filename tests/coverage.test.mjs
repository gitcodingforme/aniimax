import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { WATERING_FACTOR, coverageHtml, coverageRows, countStatuses, facilityFacts, facilitySummary, loadCoverage } from '../web/coverage.js';
import { FACILITIES, FACILITY_UPGRADE_COSTS, LEVEL_UP_COSTS, OUTPUT_CAPS } from '../web/facility-config.js';

// Items shaped like get_all_items (RecipeInfo in src/wasm.rs), trimmed to the fields used here. A
// crop's `time` is after watering, as get_all_items reports it: 0.75 x the CSV and wiki value.
function item(name, facility, { level = 1, time = 0, workload = null, verified = true, season = false } = {}) {
    return { name, facility, facility_level: level, production_time: time, workload, yield_amount: 1, sell_value: 10, verified, season };
}

function wiki(facility, key, column, value, kind = 'recipe') {
    return { kind, facility, key: String(key), column, value, source: 'wikily.gg', url: 'https://wikily.gg/x', checked_on: '2026-10-16' };
}

function local(facility, itemName, column, status, day = '2026-10-15', key = '') {
    return { facility, item: itemName, column, key, status, day };
}

function response(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) };
}

test('test_status_precedence_game_then_game_differs_then_wiki_then_unverified_then_unchecked', () => {
    const items = [
        item('rose', 'Farmland', { level: 4, time: 1800 }),                     // owner row and a wiki match: game wins
        item('wheat', 'Farmland', { time: 180 }),                               // local checks all agree: game
        item('potato', 'Farmland', { level: 2, time: 480 }),                    // a local disagree beats a wiki match
        item('rice', 'Farmland', { level: 3, time: 1800 }),                     // a local conflict
        item('wheatmeal', 'Carousel Mill', { workload: 54 }),                   // wiki match
        item('star', 'Starfall Hammock', { workload: 2700, verified: false }),  // unverified, but the wiki matches: wiki
        item('scales', 'Floral Windmill', { workload: 2700, verified: false }), // unverified, nothing else
        item('tofu', 'Carousel Mill', { level: 2, workload: 54 }),              // nothing at all
    ];
    const sources = {
        web: [wiki('Farmland', 'rose', 'production_time', 2400), wiki('Farmland', 'potato', 'production_time', 640),
            wiki('Carousel Mill', 'wheatmeal', 'workload', 54), wiki('Carousel Mill', 'wheatmeal', 'facility_level', 1),
            wiki('Starfall Hammock', 'star', 'workload', 2700)],
        owner: [{ file: 'farmland.csv', match: 'rose', column: 'production_time', value: 2400, verified_on: '2026-10-14', note: '' }],
    };
    const verification = {
        format: 'aniimax-verification',
        rows: [local('Farmland', 'wheat', 'facility_level', 'agree'), local('Farmland', 'wheat', 'production_time', 'agree', '2026-10-16'),
            local('Farmland', 'potato', 'facility_level', 'agree'), local('Farmland', 'potato', 'production_time', 'disagree'),
            local('Farmland', 'rice', 'production_time', 'conflict'), local('Farmland', 'rose', 'production_time', 'disagree')],
    };
    const rows = coverageRows(items, sources, verification);
    assert.deepEqual(rows.map(r => [r.item, r.status]), [
        ['rose', 'game'], ['wheat', 'game'], ['potato', 'game-differs'], ['rice', 'game-differs'],
        ['wheatmeal', 'wiki'], ['star', 'wiki'], ['scales', 'unverified'], ['tofu', 'unchecked'],
    ]);
    assert.match(rows[0].detail, /checked in game by you on 2026-10-14 \(time; data\/overrides\/values\.csv\)/);
    assert.match(rows[1].detail, /seen in game on 2026-10-16, agreeing \(facility level, time\)/);
    assert.match(rows[2].detail, /time: the game differs from the data/);
    assert.match(rows[3].detail, /sightings disagree with each other/);
    assert.match(rows[4].detail, /matches wikily\.gg \(workload, facility level\), read 2026-10-16/);
    assert.equal(rows[6].verified, false);
});

test('test_a_wiki_value_that_no_longer_matches_the_data_is_wiki_differs', () => {
    const items = [item('grape_juice', 'Bouncy Brew Keg', { level: 3, workload: 243 }), item('rice', 'Farmland', { level: 3, time: 1800 })];
    const sources = { web: [wiki('Bouncy Brew Keg', 'grape_juice', 'workload', 162), wiki('Bouncy Brew Keg', 'grape_juice', 'facility_level', 3),
        wiki('Farmland', 'rice', 'production_time', '2400'), wiki('Farmland', 'rice', 'raw_materials', 'seed')] };
    const [juice, rice] = coverageRows(items, sources, null);
    assert.equal(juice.status, 'wiki-differs');
    assert.equal(juice.detail, 'workload: wiki 162, data 243 (wikily.gg, read 2026-10-16)');
    assert.equal(rice.status, 'wiki', 'a number given as text still matches; a column the page cannot compare is ignored');
});

test('test_a_crop_time_matches_the_wiki_only_after_watering', () => {
    assert.equal(WATERING_FACTOR, 0.75, 'two waterings of 1/8 each (apply_watering in src/models.rs)');
    const items = [
        item('wheat', 'Farmland', { time: 180 }),                    // 240 x 0.75: matches only after watering
        item('quick_wheat', 'Farmland', { level: 2, time: 1200 }),   // the unwatered value: no longer matches
        item('potato', 'Farmland', { level: 2, time: 481 }),         // 640 x 0.75 = 480, within 1 s
        item('willow_wood', 'Woodland', { time: 483 }),              // 3 s off: differs
        item('bread', 'Claw Game Cooker', { time: 108, workload: 108 }), // a worked recipe is never watered
    ];
    const web = [wiki('Farmland', 'wheat', 'production_time', 240), wiki('Farmland', 'wheat', 'facility_level', 1),
        wiki('Farmland', 'quick_wheat', 'production_time', 1200), wiki('Farmland', 'potato', 'production_time', 640),
        wiki('Woodland', 'willow_wood', 'production_time', 640), wiki('Claw Game Cooker', 'bread', 'workload', 108)];
    const rows = coverageRows(items, { web }, null);
    assert.deepEqual(rows.map(r => [r.item, r.status]), [
        ['wheat', 'wiki'], ['quick_wheat', 'wiki-differs'], ['potato', 'wiki'], ['willow_wood', 'wiki-differs'], ['bread', 'wiki'],
    ]);
    assert.match(rows[0].detail, /time: wiki 240 \(180 after watering\), data 180/);
    assert.equal(rows[1].detail, 'time: wiki 1200 (900 after watering), data 1200 (wikily.gg, read 2026-10-16)');
    assert.match(rows[3].detail, /time: wiki 640 \(480 after watering\), data 483/);
    assert.doesNotMatch(rows[4].detail, /watering/);
});

test('test_a_404_or_bad_json_does_not_throw', async () => {
    const items = [item('wheat', 'Farmland', { time: 180 })];
    const calls = [];
    const missing = await loadCoverage({
        getItems: async () => items,
        fetchImpl: async (url, init) => { calls.push([url, init]); return response(404, 'Not found'); },
    });
    assert.deepEqual(calls, [['./data-sources.json', { cache: 'no-cache' }], ['./verification.json', { cache: 'no-store' }]],
        'the wiki file may be kept for offline use; verification.json never is');
    assert.equal(missing.localChecks, false);
    assert.equal(missing.webRows, 0);
    assert.match(missing.notes.join(' '), /data-sources\.json\) could not be loaded/);
    assert.equal(missing.rows[0].status, 'unchecked');

    const broken = await loadCoverage({
        getItems: async () => items,
        fetchImpl: async url => (url.includes('data-sources')
            ? response(200, { format: 'aniimax-data-sources', version: 1, web: [wiki('Farmland', 'wheat', 'production_time', 240)], owner: [] })
            : response(200, '{"format": "aniimax-verif')),
    });
    assert.equal(broken.localChecks, false);
    assert.equal(broken.rows[0].status, 'wiki');
    assert.deepEqual(broken.notes, []);
    const thrown = await loadCoverage({ getItems: async () => items, fetchImpl: async () => { throw new TypeError('offline'); } });
    assert.equal(thrown.localChecks, false);
    const old = await loadCoverage({ getItems: async () => items, fetchImpl: async url => response(200, url.includes('verification')
        ? { format: 'aniimax-verification', version: 1, observations: 3 } : { format: 'something else' }) });
    assert.equal(old.localChecks, true);
    assert.match(old.notes.join(' '), /no per-value rows yet/);
    await assert.rejects(loadCoverage({ getItems: async () => { throw new Error('WASM not ready'); }, fetchImpl: async () => response(404) }), /WASM not ready/);
});

test('test_unknown_facilities_and_items_are_ignored', () => {
    const items = [item('wheat', 'Farmland', { time: 240 })];
    const sources = { web: [wiki('Moon Base', 'wheat', 'production_time', 1), wiki('Farmland', 'moon_cheese', 'production_time', 1),
        wiki('Moon Base', 2, 'needs_rv', 5, 'unlock')] };
    const verification = { rows: [local('Moon Base', 'wheat', 'production_time', 'disagree'), local('Farmland', 'moon_cheese', 'production_time', 'disagree'),
        local('Moon Base', '', 'unlock', 'disagree', '2026-10-15', '2'), { facility: 'Farmland', item: 'wheat', column: 'production_time', status: 'odd' }] };
    const rows = coverageRows(items, sources, verification);
    assert.deepEqual(rows.map(r => [r.facility, r.item, r.status]), [['Farmland', 'wheat', 'unchecked']]);
    assert.deepEqual(facilityFacts(sources.web, { FACILITIES: [{ name: 'Farmland', unlocks: { 2: 2 } }] }, verification), []);
    assert.deepEqual(coverageRows([null, { name: 'x' }, ...items], {}, undefined).length, 1, 'malformed items are skipped');
});

test('test_a_game_placement_disagreement_reaches_the_item_in_its_data_facility', () => {
    const items = [item('wheatmeal', 'Carousel Mill', { workload: 54 })];
    const rows = coverageRows(items, {}, { rows: [local('Farmland', 'wheatmeal', 'recipe', 'disagree')] });
    assert.equal(rows[0].status, 'game-differs');
    assert.match(rows[0].detail, /the game showed it at Farmland/);
});

test('test_owner_rows_match_by_file_and_match_column', () => {
    const items = [item('wheat', 'Farmland', { time: 240 }), item('moondew_radish', 'Farmland', { time: 2400, season: true }),
        item('rose', 'Farmland', { time: 2400 }), item('rose', 'Simmering Pot', { workload: 135 })];
    const owner = [
        { file: 'grower_steps.csv', match: 'name=wheat;step=Sowing', column: 'workload', value: 12, verified_on: '2026-10-15', note: '' },
        { file: 'harvest_moon_festival.csv', match: 'moondew_radish', column: 'production_time', value: 2400, verified_on: '', note: '' },
        { file: 'simmering_pot.csv', match: 'rose', column: 'workload', value: 135, verified_on: '2026-10-15', note: '' },
    ];
    assert.deepEqual(coverageRows(items, { owner }, null).map(r => r.status), ['game', 'game', 'unchecked', 'game']);
});

test('test_names_and_details_are_escaped', () => {
    const items = [item('<img src=x onerror=alert(1)>', '<b>Farm</b>', { workload: 5 })];
    const rows = coverageRows(items, { web: [wiki('<b>Farm</b>', '<img src=x onerror=alert(1)>', 'workload', '<script>')] }, null);
    const model = { rows, counts: countStatuses(rows), facilities: facilitySummary(rows), facts: [], localChecks: false, notes: ['<i>note</i>'] };
    const html = coverageHtml(model, { item: name => name });
    assert.ok(!html.includes('<img'), html);
    assert.ok(!html.includes('<b>Farm'), html);
    assert.ok(!html.includes('<script>') && !html.includes('<i>note'), html);
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(html.includes('wiki &lt;script&gt;, data 5'));
    let escaped = 0;
    coverageHtml(model, { escape: s => { escaped += 1; return String(s).replace(/</g, '&lt;'); }, item: n => `pretty ${n}` });
    assert.ok(escaped >= 3, 'ctx.format.escape is used when given');
    assert.match(html, /Sell values, yields and seed costs: no source checks these yet\./);
    assert.match(html, /Your own in-game checks appear on your local site \(scripts\/verify_data\.py\)/);
    assert.doesNotMatch(coverageHtml({ ...model, localChecks: true }), /appear on your local site/);
});

test('test_facility_summary_counts_by_status', () => {
    const rows = [
        { facility: 'Woodland', status: 'wiki' }, { facility: 'Farmland', status: 'game' }, { facility: 'Farmland', status: 'wiki' },
        { facility: 'Farmland', status: 'wiki' }, { facility: 'Farmland', status: 'unchecked' }, { facility: 'Woodland', status: 'odd' },
    ];
    const summary = facilitySummary(rows);
    assert.deepEqual(summary.map(f => f.facility), ['Farmland', 'Woodland']);
    assert.equal(summary[0].total, 4);
    assert.deepEqual(summary[0].counts, { game: 1, 'game-differs': 0, wiki: 2, 'wiki-differs': 0, unverified: 0, unchecked: 1 });
    assert.deepEqual(summary[1].counts, { game: 0, 'game-differs': 0, wiki: 1, 'wiki-differs': 0, unverified: 0, unchecked: 0 });
    assert.equal(countStatuses(rows).wiki, 3);
});

test('test_facility_level_facts_match_against_a_fake_config', () => {
    const config = {
        FACILITIES: [{ name: 'Farmland', unlocks: { 1: 1, 2: 2, 3: 5 } }, { name: 'Chimney Kiln', unlocks: { 1: 6, 2: 10 } }],
        OUTPUT_CAPS: { Farmland: [5, 10, 15] },
        FACILITY_UPGRADE_COSTS: { Farmland: { 2: 60, 3: 700 } },
        LEVEL_UP_COSTS: { 2: { coins: 140, items: [] }, 3: { coins: 800, items: [] } },
    };
    const web = [
        wiki('Farmland', 2, 'needs_rv', 2, 'unlock'), wiki('Farmland', 3, 'needs_rv', 6, 'unlock'),
        wiki('Farmland', 2, 'output_cap', 10, 'cap'), wiki('Farmland', 3, 'coins', 700, 'upgrade_cost'),
        wiki('Farmland', 4, 'coins', 6200, 'upgrade_cost'), wiki('Chimney Kiln', 2, 'rv_level', 10, 'unlock'),
        wiki('RV', 2, 'coins', 140, 'rv_cost'), wiki('', 3, 'coins', 900, 'rv_cost'), wiki('RV', 3, 'wood_block', 25, 'rv_cost'),
    ];
    const verification = { rows: [local('Chimney Kiln', '', 'unlock', 'agree', '2026-10-15', '2'), local('Chimney Kiln', '', 'unlock', 'conflict', '2026-10-15', '3')] };
    const facts = facilityFacts(web, config, verification);
    assert.deepEqual(facts.map(f => f.facility), ['Farmland', 'Chimney Kiln', 'RV']);
    const [farm, kiln, rv] = facts;
    assert.deepEqual([farm.levels, farm.checks, farm.matching], [3, 5, 3]);
    assert.deepEqual(farm.differs.map(d => [d.kind, d.key, d.wiki, d.data]), [['unlock', 3, 6, 5], ['upgrade_cost', 4, 6200, null]]);
    assert.deepEqual([kiln.checks, kiln.matching, kiln.seen], [1, 1, { agree: 1, differs: 1 }]);
    assert.deepEqual([rv.levels, rv.checks, rv.matching, rv.differs[0].data], [2, 2, 1, 800], 'an item column of an RV cost is not compared');
    const html = coverageHtml({ rows: [], facts, localChecks: true });
    assert.match(html, /Lv\.3 needs RV: wiki 6, data 5/);
    assert.match(html, /RV 3 coin cost: wiki 900, data 800/);
    assert.match(html, /1 agree, 1 differ/);
    assert.deepEqual(facilityFacts(web, null), []);
});

test('test_the_committed_wiki_values_match_the_page_config', async () => {
    const doc = JSON.parse(await readFile(new URL('../web/data-sources.json', import.meta.url), 'utf8'));
    assert.equal(doc.format, 'aniimax-data-sources');
    const facts = facilityFacts(doc.web, { FACILITIES, OUTPUT_CAPS, FACILITY_UPGRADE_COSTS, LEVEL_UP_COSTS });
    assert.equal(facts.reduce((n, f) => n + f.checks, 0), 84 * 3 + 19);
    assert.deepEqual(facts.flatMap(f => f.differs.map(d => `${f.facility} ${d.kind} ${d.key}`)), [], 'run python scripts/build_sources.py after a data change');
});

// A small stand-in for the DOM: just what web/cards/coverage.js touches.
function fakeNode(tag = 'div') {
    const node = {
        tag, children: [], listeners: {}, attributes: {}, open: false, textContent: '', id: '', className: '', type: '',
        _html: '',
        get innerHTML() { return this._html; },
        set innerHTML(v) { this._html = v; this.children = []; },
        appendChild(child) { this.children.push(child); return child; },
        setAttribute(k, v) { this.attributes[k] = v; },
        addEventListener(type, fn) { this.listeners[type] = fn; },
    };
    return node;
}

test('test_the_card_loads_only_when_opened_and_offers_a_retry', async () => {
    const { mount } = await import('../web/cards/coverage.js?v=fork-m9-1');
    const details = fakeNode('details');
    const body = fakeNode();
    const el = { ...fakeNode('section'), querySelector: sel => ({ '#coverage-details': details, '#coverage-body': body })[sel] };
    const sheets = [];
    let asked = 0;
    let ready = false;
    const ctx = {
        addStylesheet: href => sheets.push(href),
        items: async () => { asked += 1; if (!ready) throw new Error('worker not ready'); return [item('wheat', 'Farmland', { time: 240 })]; },
        config: { FACILITIES: [{ name: 'Farmland', unlocks: { 2: 2 } }] },
        format: { escape: s => String(s).replace(/</g, '&lt;'), item: n => n },
    };
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const savedDocument = globalThis.document;
    const savedFetch = globalThis.fetch;
    const savedWarn = console.warn;
    globalThis.document = { createElement: tag => fakeNode(tag) };
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    console.warn = () => {};
    try {
        mount(el, ctx);
        assert.deepEqual(sheets, ['css/coverage.css']);
        assert.match(el.innerHTML, /How sure is this data\?/);
        assert.doesNotMatch(el.innerHTML, /<details[^>]*\bopen\b/, 'closed by default');
        assert.equal(asked, 0, 'nothing loads before the section is opened');
        details.open = true;
        details.listeners.toggle();
        await settle();
        assert.equal(asked, 1);
        const retry = body.children[0]?.children[0];
        assert.equal(retry?.id, 'coverage-retry');
        assert.match(body.children[0].textContent, /not ready yet/);
        ready = true;
        retry.listeners.click();
        await settle();
        assert.equal(asked, 2);
        assert.match(body.innerHTML, /Recipes by facility/);
        assert.match(body.innerHTML, /data-sources\.json\) could not be loaded/);
        details.listeners.toggle();
        await settle();
        assert.equal(asked, 2, 'loaded once');
    } finally {
        globalThis.document = savedDocument;
        globalThis.fetch = savedFetch;
        console.warn = savedWarn;
    }
});
