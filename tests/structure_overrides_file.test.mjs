// Runs the real data/overrides/structure.json (the game structure verified in game, patched over
// web/facility-config.js when the page loads) through applyStructureOverrides against the page's
// own constants. A bad row is ignored on the page with only a console warning, so an edit that
// does nothing (a misspelt facility, a negative count) would go unnoticed without this test.
// The function itself is tested in tests/overrides.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { FACILITIES, FACILITY_UPGRADE_COSTS, LEVEL_UP_COSTS, MODULE_MAX_LEVELS, OUTPUT_CAPS } from '../web/facility-config.js';
import { applyStructureOverrides } from '../web/overrides.js';

const overrides = JSON.parse(readFileSync(new URL('../data/overrides/structure.json', import.meta.url), 'utf8'));

// Copies, so patching them leaves the page's constants as other tests in this process expect.
const constants = () => structuredClone({ FACILITIES, LEVEL_UP_COSTS, MODULE_MAX_LEVELS, OUTPUT_CAPS, FACILITY_UPGRADE_COSTS });

// What applyStructureOverrides reads from each section. It ignores any other key without a word,
// so a misspelt one ("outputcaps") would look like success.
const SECTIONS = ['facilities', 'levelUpCosts', 'moduleMaxLevels', 'upgradeCosts'];
const FACILITY_FIELDS = ['counts', 'unlocks', 'outputCaps'];
const LEVEL_UP_FIELDS = ['coins', 'items'];

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

test('test_the_structure_overrides_file_is_one_object_with_known_sections', () => {
    assert.ok(isObject(overrides), 'structure.json is a JSON object');
    const unknown = Object.keys(overrides).filter(key => !SECTIONS.includes(key) && !key.startsWith('_'));
    assert.deepEqual(unknown, [], 'keys the page does not read (a misspelt section name)');
    for (const section of SECTIONS) {
        if (section in overrides) assert.ok(isObject(overrides[section]), `${section} is an object`);
    }
    const unknownFields = [];
    for (const [facility, patch] of Object.entries(overrides.facilities || {})) {
        for (const key of Object.keys(isObject(patch) ? patch : {})) if (!FACILITY_FIELDS.includes(key)) unknownFields.push(`facilities.${facility}.${key}`);
    }
    for (const [level, patch] of Object.entries(overrides.levelUpCosts || {})) {
        for (const key of Object.keys(isObject(patch) ? patch : {})) if (!LEVEL_UP_FIELDS.includes(key)) unknownFields.push(`levelUpCosts.${level}.${key}`);
    }
    assert.deepEqual(unknownFields, [], 'fields the page does not read (a misspelt field name)');
});

test('test_the_structure_overrides_file_applies_to_the_page_constants_without_problems', () => {
    const patched = constants();
    const { applied, problems } = applyStructureOverrides(overrides, patched);
    assert.deepEqual(problems, []);

    // Everything the file says was taken: one entry per facility field, level-up field, module
    // and upgrade-cost facility (an empty file applies nothing and expects nothing).
    const expected = Object.values(overrides.facilities || {}).reduce((n, p) => n + FACILITY_FIELDS.filter(k => k in p).length, 0)
        + Object.values(overrides.levelUpCosts || {}).reduce((n, p) => n + LEVEL_UP_FIELDS.filter(k => k in p).length, 0)
        + Object.keys(overrides.moduleMaxLevels || {}).length
        + Object.keys(overrides.upgradeCosts || {}).length;
    assert.equal(applied.length, expected, `applied: ${applied.join('; ') || 'nothing'}`);
});
