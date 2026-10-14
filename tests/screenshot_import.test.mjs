import assert from 'node:assert/strict';
import test from 'node:test';

import { applyChanges, parseReading, proposeChanges } from '../web/screenshot-import.js';

const current = {
    facilityTiers: { Farmland: [{ count: 4, level: 2 }], Mine: [{ count: 1, level: 1 }] },
    levelUpStock: { wood_block: 40 },
    roster: [],
    'home-level': '5',
    'ecological-module-level': '1',
    'kitchen-module-level': '1',
    'resource-detector-level': '0',
    'crafting-module-level': '0',
    'rate-unit': 'hour',
};

const reading = {
    format: 'aniimax-screenshot-reading', version: 1, readAt: '2026-10-14T21:00:00Z', model: 'qwen2.5vl:7b',
    screens: [{ file: 'rv-1.png', kind: 'rv', fields: { rv: 7, coins: 123456 } }, { file: 'facility-x.png', kind: 'facility', error: 'timeout' }],
    setup: {
        'home-level': '7',
        'kitchen-module-level': '2',
        'resource-detector-level': '0',
        facilityTiers: { Farmland: [{ count: 6, level: 2 }], Well: [{ count: 1, level: 1 }], Mine: [{ count: 1, level: 1 }] },
        levelUpStock: { wood_block: 10, rough_lumber: 5 },
        roster: [{ name: 'Spark', count: 1, abilities: { Fire: 3 }, personalities: ['Playful'] }],
    },
    actual: { rv: 7, coins: 123456 },
    notes: ['facility-x.png facility: read "Moon Base", which matches nothing the site knows; left out'],
};

test('test_parse_reading_validates_the_file', () => {
    const parsed = parseReading(JSON.stringify(reading));
    assert.equal(parsed.model, 'qwen2.5vl:7b');
    assert.equal(parsed.screens, 2);
    assert.equal(parsed.failed, 1);
    assert.equal(parsed.notes.length, 1);
    assert.deepEqual(parsed.setup, reading.setup);
    assert.throws(() => parseReading('{oops'), /not valid JSON/);
    assert.throws(() => parseReading(JSON.stringify({ format: 'aniimax-profile', version: 1 })), /not a screenshot reading/);
    assert.throws(() => parseReading(JSON.stringify({ format: 'aniimax-screenshot-reading', version: 2, setup: {} })), /version 2/);
    assert.deepEqual(parseReading(JSON.stringify({ format: 'aniimax-screenshot-reading', version: 1 })).setup, {});
});

test('test_propose_changes_lists_only_real_differences_in_words', () => {
    const changes = proposeChanges(current, { ...parseReading(JSON.stringify(reading)), currentCoins: 99 });
    const byId = Object.fromEntries(changes.map(c => [c.id, `${c.what}: ${c.before} -> ${c.after}`]));
    assert.equal(byId['home-level'], 'RV level: 5 -> 7');
    assert.equal(byId['kitchen-module-level'], 'Kitchen Module: 1 -> 2');
    assert.equal(byId['resource-detector-level'], undefined, 'same value, no change');
    assert.equal(byId['ecological-module-level'], undefined, 'not in the reading, left alone');
    assert.equal(byId['facility:Farmland'], 'Farmland: 4×Lv.2 -> 6×Lv.2');
    assert.equal(byId['facility:Well'], 'Well: none -> 1×Lv.1');
    assert.equal(byId['facility:Mine'], undefined);
    assert.equal(byId['stock:wood_block'], 'Stock: Wood Block: 40 -> 10');
    assert.equal(byId['stock:rough_lumber'], 'Stock: Rough Lumber: 0 -> 5');
    assert.equal(byId['roster'], 'Aniimo roster: none -> Spark (Fire 3)');
    assert.equal(byId['coins'], 'Coins on hand (profile): 99 -> 123456');
    assert.equal(changes.length, 8);
    assert.deepEqual(proposeChanges(current, { setup: {}, actual: {} }), []);
});

test('test_apply_changes_applies_only_the_ticked_ones_without_mutating_inputs', () => {
    const parsed = parseReading(JSON.stringify(reading));
    const changes = proposeChanges(current, parsed);
    const before = JSON.stringify(current);
    const meta = { note: 'x', coins: 99 };
    const { setup, meta: nextMeta, applied } = applyChanges(current, meta, changes, ['home-level', 'facility:Well', 'stock:rough_lumber', 'coins']);
    assert.equal(applied, 4);
    assert.equal(setup['home-level'], '7');
    assert.equal(setup['kitchen-module-level'], '1');
    assert.deepEqual(setup.facilityTiers, { Farmland: [{ count: 4, level: 2 }], Mine: [{ count: 1, level: 1 }], Well: [{ count: 1, level: 1 }] });
    assert.deepEqual(setup.levelUpStock, { wood_block: 40, rough_lumber: 5 });
    assert.deepEqual(setup.roster, []);
    assert.equal(setup['rate-unit'], 'hour');
    assert.equal(nextMeta.coins, 123456);
    assert.equal(nextMeta.note, 'x');
    assert.equal(meta.coins, 99);
    assert.equal(JSON.stringify(current), before);
    const all = applyChanges(current, null, changes, changes.map(c => c.id));
    assert.equal(all.applied, changes.length);
    assert.equal(all.meta, null);
    assert.deepEqual(all.setup.roster, reading.setup.roster);
    assert.equal(applyChanges(current, meta, changes, []).applied, 0);
});
