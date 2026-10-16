import assert from 'node:assert/strict';
import test from 'node:test';

import { FACILITIES, FACILITY_UPGRADE_COSTS, upgradeCost } from '../web/facility-config.js';

test('test_upgrade_costs_cover_the_84_wiki_rows', () => {
    const entries = Object.values(FACILITY_UPGRADE_COSTS).reduce((sum, levels) => sum + Object.keys(levels).length, 0);
    assert.equal(entries, 84);
});

test('test_upgrade_costs_name_real_facilities_and_levels', () => {
    for (const [name, levels] of Object.entries(FACILITY_UPGRADE_COSTS)) {
        const facility = FACILITIES.find(f => f.name === name);
        assert.ok(facility, `${name} is not in FACILITIES`);
        for (const [level, coins] of Object.entries(levels)) {
            assert.ok(level in facility.unlocks, `${name} has no level ${level} in its unlocks`);
            assert.ok(Number(level) >= 2, `${name} level ${level}: building a new facility has no listed cost`);
            assert.ok(Number.isInteger(coins) && coins > 0, `${name} level ${level} costs ${coins}`);
        }
    }
});

test('test_upgrade_cost_sums_the_steps_or_says_it_does_not_know', () => {
    // Farmland: 60 to level 2, 700 to level 3, 6,200 to level 4.
    assert.equal(upgradeCost('Farmland', 1, 2), 60);
    assert.equal(upgradeCost('Farmland', 1, 4), 60 + 700 + 6200);
    assert.equal(upgradeCost('Farmland', 3, 4), 6200);
    assert.equal(upgradeCost('Crafting Table', 7, 8), 1450000);
    assert.equal(upgradeCost('Farmland', '2', '3'), 700, 'numbers typed into an input still work');
    assert.equal(upgradeCost('Farmland', 0, 2), null, 'building one has no listed cost');
    assert.equal(upgradeCost('Farmland', 6, 8), null, 'Farmland has no level 8');
    assert.equal(upgradeCost('Farmland', 3, 3), null);
    assert.equal(upgradeCost('Farmland', 4, 2), null);
    assert.equal(upgradeCost('Heat Furnace', 1, 2), null, 'no levels, no costs');
    assert.equal(upgradeCost('Castle', 1, 2), null);
    assert.equal(upgradeCost('Farmland', 1.5, 3), null);
});
