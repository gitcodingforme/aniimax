import assert from 'node:assert/strict';
import test from 'node:test';

import { applyChanges, parseReading, proposeChanges, questionsSummary, verificationSummary } from '../web/screenshot-import.js';

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

test('test_a_facility_read_from_its_panel_keeps_the_count_the_setup_has', () => {
    const panelReading = { setup: { facilityTiers: { Farmland: [{ count: null, level: 3 }], Mine: [{ count: null, level: 1 }], Well: [{ count: null, level: 2 }] } } };
    const changes = proposeChanges(current, panelReading);
    const byId = Object.fromEntries(changes.map(c => [c.id, c]));
    assert.equal(`${byId['facility:Farmland'].before} -> ${byId['facility:Farmland'].after}`, '4×Lv.2 -> 4×Lv.3');
    assert.match(byId['facility:Farmland'].what, /does not show the count/);
    assert.equal(byId['facility:Mine'], undefined, 'same level, no change');
    assert.equal(`${byId['facility:Well'].before} -> ${byId['facility:Well'].after}`, 'none -> 1×Lv.2');
    const { setup } = applyChanges(current, {}, changes, ['facility:Farmland', 'facility:Well']);
    assert.deepEqual(setup.facilityTiers, { Farmland: [{ count: 4, level: 3 }], Mine: [{ count: 1, level: 1 }], Well: [{ count: 1, level: 2 }] });
});

test('test_verification_summary_is_one_line_with_the_counts_and_the_report', () => {
    const data = { format: 'aniimax-verification', version: 1, updatedAt: '2026-10-15T12:00:00Z', observations: 9, agree: 7, disagree: 1, unknown: 1, report: 'screenshots/verification.md' };
    assert.equal(verificationSummary(data), 'Verified against 9 observations from the watcher: 7 agree, 1 disagree, 1 unknown (report: screenshots/verification.md)');
    assert.match(verificationSummary({ ...data, observations: 1, agree: 1, disagree: 0, unknown: 0, report: undefined }), /^Verified against 1 observation from the watcher: 1 agree, 0 disagree, 0 unknown \(report: screenshots\/verification\.md\)$/);
});

test('test_verification_summary_ignores_bad_data', () => {
    for (const bad of [null, undefined, 'text', 5, {}, { format: 'other', observations: 3, agree: 3, disagree: 0, unknown: 0 },
        { format: 'aniimax-verification', observations: '3', agree: 3, disagree: 0, unknown: 0 },
        { format: 'aniimax-verification', observations: 3, agree: -1, disagree: 0, unknown: 0 },
        { format: 'aniimax-verification', observations: 0, agree: 0, disagree: 0, unknown: 0 },
        { format: 'aniimax-verification', observations: 3, agree: 3 }]) {
        assert.equal(verificationSummary(bad), '');
    }
});

test('test_verification_summary_mentions_unclear_only_when_the_file_carries_a_count', () => {
    const data = { format: 'aniimax-verification', version: 1, observations: 9, agree: 6, disagree: 1, unknown: 1, report: 'screenshots/verification.md' };
    assert.equal(verificationSummary({ ...data, unclear: 1 }), 'Verified against 9 observations from the watcher: 6 agree, 1 disagree, 1 unknown, 1 unclear (report: screenshots/verification.md)');
    assert.match(verificationSummary({ ...data, unclear: 0 }), /1 unknown, 0 unclear \(report: /);
    // No count, or one that is not a whole number: the line is exactly what it was before.
    const before = 'Verified against 9 observations from the watcher: 6 agree, 1 disagree, 1 unknown (report: screenshots/verification.md)';
    for (const odd of [undefined, null, '2', -1, 1.5, NaN]) {
        assert.equal(verificationSummary({ ...data, unclear: odd }), before);
    }
});

test('test_questions_summary_is_one_plain_sentence_from_counts', () => {
    const verification = { format: 'aniimax-verification', questions: { total: 19, answered: 3, evidence: 4, open: 12 } };
    assert.equal(questionsSummary(verification), '3 of 19 game questions answered, 4 waiting for you to check');
    // Works on the questions block alone inside any object, and says "question" for a single one.
    assert.equal(questionsSummary({ questions: { total: 1, answered: 0, evidence: 1, open: 0 } }), '0 of 1 game question answered, 1 waiting for you to check');
    assert.equal(questionsSummary({ questions: { total: 19, answered: 0, evidence: 0, open: 19 } }), '0 of 19 game questions answered, 0 waiting for you to check');
    assert.equal(questionsSummary({ questions: { total: 19, answered: 19, evidence: 0, open: 0 } }), '19 of 19 game questions answered, 0 waiting for you to check');
});

test('test_questions_summary_is_empty_for_missing_or_malformed_data', () => {
    const good = { total: 19, answered: 3, evidence: 4, open: 12 };
    for (const bad of [null, undefined, 'text', 5, [], {}, { questions: null }, { questions: 'many' }, { questions: [] },
        { questions: { ...good, total: 0, answered: 0, evidence: 0, open: 0 } },
        { questions: { ...good, total: '19' } },
        { questions: { ...good, answered: 2.5 } },
        { questions: { ...good, evidence: -1 } },
        { questions: { ...good, open: NaN } },
        { questions: { total: 19, answered: 3, evidence: 4 } },
        { questions: { ...good, answered: 20, evidence: 0, open: 0 } },
        { questions: { ...good, answered: 10, evidence: 10, open: 0 } }]) {
        assert.equal(questionsSummary(bad), '');
    }
});

test('test_questions_summary_prints_counts_only', () => {
    // Anything else in the block (a stray question text, a value) must never reach the line.
    const line = questionsSummary({ questions: { total: 19, answered: 3, evidence: 4, open: 12, text: 'Q1 my secret', value: 'Basil 123456' } });
    assert.equal(line, '3 of 19 game questions answered, 4 waiting for you to check');
    assert.doesNotMatch(line, /secret|Basil|123456/);
});
