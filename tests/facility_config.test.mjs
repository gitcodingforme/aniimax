import assert from 'node:assert/strict';
import test from 'node:test';

import { EMODE, FACILITIES, OUTPUT_CAPS, emodeBudget, emodeGeneratorsAllowed, simpleSetup } from '../web/facility-config.js';

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


test('output caps cover every leveled producing facility, one entry per level', () => {
    for (const [name, caps] of Object.entries(OUTPUT_CAPS)) {
        const facility = FACILITIES.find(f => f.name === name);
        assert.ok(facility, `${name} is a facility`);
        const levels = Object.keys(facility.unlocks || {}).length;
        assert.equal(caps.length, levels, `${name} has one cap per facility level`);
        assert.ok(caps.every(c => c === null || (Number.isInteger(c) && c > 0)), `${name} caps are whole numbers or null`);
    }
    assert.equal(OUTPUT_CAPS.Farmland[6], 35);
    assert.equal(OUTPUT_CAPS['Carousel Mill'][0], 20);
});

test("EMODE has the solver's shape (the values themselves are checked against src/emode.rs by cargo test)", () => {
    assert.ok(Object.isFrozen(EMODE) && Object.isFrozen(EMODE.generatorCapacity) && Object.isFrozen(EMODE.facilities));
    assert.equal(EMODE.generatorCapacity.length, 5);
    assert.ok(EMODE.generatorCapacity.every((w, i, all) => Number.isInteger(w) && (i === 0 || w > all[i - 1])));
    assert.equal(EMODE.drawPerLevel, 15);
    assert.equal(EMODE.boostRate, 1.2);
    assert.equal(EMODE.facilities.length, 12);
    const names = new Set(FACILITIES.map(f => f.name));
    for (const name of [...EMODE.facilities, ...EMODE.doubleDraw]) assert.ok(names.has(name), `${name} is a facility`);
    for (const name of EMODE.doubleDraw) assert.ok(!EMODE.facilities.includes(name), `${name} has no E-mode switch`);
    for (const name of EMODE.facilities) {
        assert.equal(FACILITIES.find(f => f.name === name).category, 'Materials Processing', `${name} is a processor`);
    }
    assert.equal(EMODE.minHomeLevel, 12);
    assert.deepEqual({ ...EMODE.maxGenerators }, { 12: 1, 15: 2, 18: 3 });
});

test("emodeBudget follows the solver's rule: all the watts at 100%, capacity / 1.2 rounded down at 120%", () => {
    assert.deepEqual(emodeBudget({ generators: [{ level: 1, count: 1 }], supply: '100' }), { budget: 600, rate: 1 });
    assert.deepEqual(emodeBudget({ generators: [{ level: 1, count: 1 }], supply: '120' }), { budget: 500, rate: 1.2 });
    assert.deepEqual(emodeBudget({ generators: [{ level: 3, count: 1 }], supply: '120' }), { budget: 833, rate: 1.2 });
    assert.deepEqual(emodeBudget({ generators: [{ level: 5, count: 3 }], supply: '120' }), { budget: 3750, rate: 1.2 });
    assert.deepEqual(emodeBudget({ generators: [{ level: 2, count: 2 }, { level: 4, count: 1 }] }), { budget: 2800, rate: 1 });
    assert.deepEqual(emodeBudget({ generators: [{ level: 1, count: 0 }], supply: '120' }), { budget: 0, rate: 1.2 });
    assert.deepEqual(emodeBudget({ generators: [{ level: 6, count: 1 }, { level: 1, count: 1.5 }] }), { budget: 0, rate: 1 });
    assert.deepEqual(emodeBudget(), { budget: 0, rate: 1 });
    // Every level and supply: the floor rule never loses a watt to rounding noise.
    for (const [i, watts] of EMODE.generatorCapacity.entries()) {
        for (let count = 1; count <= 3; count++) {
            const { budget } = emodeBudget({ generators: [{ level: i + 1, count }], supply: '120' });
            assert.equal(budget, Math.floor((watts * count * 5) / 6), `level ${i + 1} x ${count}`);
        }
    }
});

test('emodeGeneratorsAllowed: none below RV 12, then 1, 2 and 3', () => {
    assert.deepEqual([11, 12, 14, 15, 17, 18, 20].map(emodeGeneratorsAllowed), [0, 1, 1, 2, 2, 3, 3]);
});
