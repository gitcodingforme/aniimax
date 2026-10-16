import assert from 'node:assert/strict';
import test from 'node:test';

import { FACILITIES, OUTPUT_CAPS, simpleSetup } from '../web/facility-config.js';

const countAt = (homeLevel, facility) => simpleSetup(homeLevel).facilities[facility][0].count;

test('RV 14 applies the confirmed facility count increases', () => {
    const expected = {
        Well: 3,
        'Tidewhisper Sandcastle': 2,
        'Woodworking Bench': 3,
        'Chimney Kiln': 3,
        'Joy Wheel Loom': 2,
    };

    for (const [facility, count] of Object.entries(expected)) {
        assert.equal(countAt(13, facility), count - 1, `${facility} should keep its RV 13 count`);
        assert.equal(countAt(14, facility), count, `${facility} should increase at RV 14`);
        assert.equal(countAt(15, facility), count, `${facility} should keep its RV 14 count at RV 15`);
    }
});

test('later RV levels apply confirmed maximum facility counts', () => {
    const expectedByLevel = {
        15: { 'Blazing Stove': 2, 'Pickling Jar': 2 },
        16: { 'Nimbus Bed': 2 },
        17: { 'Cooling Unit': 3, 'Dewy House': 2, 'Heat Furnace': 3 },
        18: { 'Chimney Kiln': 4, 'Starfall Hammock': 2, 'Woodworking Bench': 4 },
        19: { Sunlamp: 3, Well: 4 },
    };

    for (const [levelText, facilities] of Object.entries(expectedByLevel)) {
        const level = Number(levelText);
        for (const [facility, count] of Object.entries(facilities)) {
            assert.equal(countAt(level - 1, facility), count - 1, `${facility} should keep its previous maximum through RV ${level - 1}`);
            assert.equal(countAt(level, facility), count, `${facility} should increase at RV ${level}`);
            assert.equal(countAt(20, facility), count, `${facility} should keep its confirmed maximum afterward`);
        }
    }
});

test('RV 20 keeps the RV 19 grower limits', () => {
    assert.equal(countAt(19, 'Farmland'), 40);
    assert.equal(countAt(20, 'Farmland'), 40);
    assert.equal(countAt(19, 'Woodland'), 20);
    assert.equal(countAt(20, 'Woodland'), 20);
});

// OUTPUT_CAPS is fan-sourced and not verified in game, so these tests check its shape, not the
// numbers: they stop a typo, a missing level or a forgotten facility from slipping in.
const highestUnlockLevel = facility => Math.max(...Object.keys(facility.unlocks).map(Number));

test('output caps have one entry per facility level', () => {
    for (const [name, caps] of Object.entries(OUTPUT_CAPS)) {
        const facility = FACILITIES.find(f => f.name === name);
        assert.ok(facility, `${name} is a facility in FACILITIES`);
        assert.equal(caps.length, highestUnlockLevel(facility), `${name} has one cap per facility level`);
    }
});

test('every output cap is a positive whole number', () => {
    for (const [name, caps] of Object.entries(OUTPUT_CAPS)) {
        caps.forEach((cap, i) => {
            assert.ok(Number.isInteger(cap) && cap > 0, `${name} level ${i + 1} cap ${cap} is a positive integer`);
        });
    }
});

test('output caps never shrink as a facility levels up', () => {
    for (const [name, caps] of Object.entries(OUTPUT_CAPS)) {
        caps.forEach((cap, i) => {
            if (i > 0) assert.ok(cap >= caps[i - 1], `${name} level ${i + 1} cap is not below level ${i}`);
        });
    }
});

test('every facility that levels up has output caps', () => {
    for (const facility of FACILITIES) {
        if (facility.hasLevels === false) continue;
        assert.ok(OUTPUT_CAPS[facility.name], `${facility.name} has an OUTPUT_CAPS entry`);
    }
});
