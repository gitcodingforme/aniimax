import assert from 'node:assert/strict';
import test from 'node:test';

import { applyStructureOverrides } from '../web/overrides.js';

function constants() {
    return {
        FACILITIES: [
            { name: 'Farmland', counts: [4, 6, 8], unlocks: { 1: 1, 2: 2 } },
            { name: 'Well', counts: [0, 0, 1], unlocks: { 1: 3 } },
        ],
        LEVEL_UP_COSTS: {
            2: { coins: 140, items: [['wood_block', 3]] },
            3: { coins: 800, items: [['wood_block', 25]] },
        },
        MODULE_MAX_LEVELS: { ecological_module: [0, 0, 1], kitchen_module: [0, 1, 1] },
    };
}

test('test_structure_overrides_patch_constants_in_place', () => {
    const c = constants();
    const { applied, problems } = applyStructureOverrides({
        _comment: 'ignored',
        facilities: { Well: { counts: [0, 1, 2, 2], unlocks: { 1: 2, 2: 5 } } },
        levelUpCosts: { 3: { coins: 900, items: [['wood_block', 30], ['mineral_sand', 10]] } },
        moduleMaxLevels: { kitchen_module: [0, 1, 2] },
    }, c);
    assert.deepEqual(problems, []);
    assert.deepEqual(applied, ['Well counts', 'Well unlocks', 'RV 3 coins', 'RV 3 items', 'kitchen_module max levels']);
    assert.deepEqual(c.FACILITIES[1], { name: 'Well', counts: [0, 1, 2, 2], unlocks: { 1: 2, 2: 5 } });
    assert.deepEqual(c.FACILITIES[0], constants().FACILITIES[0]);
    assert.deepEqual(c.LEVEL_UP_COSTS[3], { coins: 900, items: [['wood_block', 30], ['mineral_sand', 10]] });
    assert.deepEqual(c.LEVEL_UP_COSTS[2], constants().LEVEL_UP_COSTS[2]);
    assert.deepEqual(c.MODULE_MAX_LEVELS.kitchen_module, [0, 1, 2]);
});

test('test_structure_overrides_ignore_bad_entries_and_say_why', () => {
    const c = constants();
    const { applied, problems } = applyStructureOverrides({
        facilities: { Castle: { counts: [1] }, Farmland: { counts: [1, -1], unlocks: { a: 1 } } },
        levelUpCosts: { 9: { coins: 1 }, 2: { coins: 'lots', items: [['wood_block']] } },
        moduleMaxLevels: { laser_module: [1], ecological_module: 3 },
    }, c);
    assert.deepEqual(applied, []);
    assert.equal(problems.length, 8, problems.join('; '));
    assert.deepEqual(c, constants());
    assert.deepEqual(applyStructureOverrides(null, c).problems.length, 1);
    assert.deepEqual(applyStructureOverrides({ facilities: {}, levelUpCosts: {}, moduleMaxLevels: {} }, c), { applied: [], problems: [] });
});


test('test_structure_overrides_patch_output_caps', () => {
    const c = { ...constants(), OUTPUT_CAPS: { Farmland: [null, 10, 15], Well: [null, 300] } };
    const { applied, problems } = applyStructureOverrides({
        facilities: { Farmland: { outputCaps: [5, 10, 15] }, Well: { outputCaps: [260, -1] } },
    }, c);
    assert.deepEqual(applied, ['Farmland output caps']);
    assert.deepEqual(problems, ['Well outputCaps must be a list of whole numbers (or null), one per facility level']);
    assert.deepEqual(c.OUTPUT_CAPS, { Farmland: [5, 10, 15], Well: [null, 300] });
    // Without a caps table the patch is reported, not applied.
    const bare = constants();
    assert.deepEqual(applyStructureOverrides({ facilities: { Farmland: { outputCaps: [5] } } }, bare).problems, ['Farmland outputCaps: this page has no output-cap table to override']);
});
