import assert from 'node:assert/strict';
import test from 'node:test';

import {
    allTicked, checklistHash, checklistRows, doneCount, readState, tickAll, toggle, untickAll, writeState,
} from '../web/checklist.js';

const plan = {
    success: true,
    coin_items: [
        { item_name: 'rice', facility: 'Farmland', facility_count: 4, status: 'producing', environment: 'Cool', cycle_time: 1800, crew: 1,
          aniimo: null },
        { item_name: 'coarse_sifted_ore', facility: 'Chimney Kiln', facility_count: 1, status: 'producing', environment: null, cycle_time: 2,
          aniimo: { ability: 'Fire', level: 2, personality_bonus: true }, crew: 0 },
        { item_name: 'rock', facility: 'Mine', facility_count: 2, status: 'producing', aniimo: { ability: 'Earth', level: 1, personality_bonus: false }, crew: 7 },
        { item_name: null, facility: 'Well', facility_count: 1, status: 'idle' },
        { item_name: 'wheat', facility: 'Farmland', facility_count: 0, status: 'producing' },
        { item_name: 'jam', facility: 'Jam Press', facility_count: 1, status: 'nothing_available' },
    ],
    environment_assignments: [
        { building: 'Cooling Unit', mode: 'Cool', units: 1, covered: [{ facility: 'Farmland', count: 4 }], layouts: [] },
    ],
};
const roster = [{ name: 'Ember' }, { name: '  ' }];

test('test_rows_cover_producing_rows_and_environment_buildings', () => {
    const rows = checklistRows(plan, roster);
    assert.deepEqual(rows.map(r => r.id), [
        'Farmland|rice', 'Chimney Kiln|coarse_sifted_ore', 'Mine|rock', 'env|Cooling Unit|Cool|0',
    ]);
    assert.equal(rows[0].text, 'Farmland x4: Rice, needs Cool (under a Cooling Unit), worked by Aniimo 2');
    assert.equal(rows[1].text, 'Chimney Kiln x1: Coarse Sifted Ore, Fire Aniimo level 2 with personality bonus, worked by Ember');
    // A crew index outside the roster says nothing about who works it.
    assert.equal(rows[2].text, 'Mine x2: Rock, Earth Aniimo level 1');
    assert.equal(rows[3].text, 'Cooling Unit (Cool): covers 4 Farmland');
    assert.equal(rows[3].kind, 'environment');
    assert.deepEqual(checklistRows(null), []);
    assert.equal(checklistRows(plan)[0].text, 'Farmland x4: Rice, needs Cool (under a Cooling Unit)');
});

test('test_duplicate_rows_keep_distinct_ids', () => {
    const twice = { coin_items: [
        { item_name: 'rice', facility: 'Farmland', facility_count: 2, status: 'producing' },
        { item_name: 'rice', facility: 'Farmland', facility_count: 3, status: 'producing' },
    ] };
    assert.deepEqual(checklistRows(twice).map(r => r.id), ['Farmland|rice', 'Farmland|rice#2']);
});

test('test_state_resets_when_the_plan_changes', () => {
    const rows = checklistRows(plan, roster);
    const hash = checklistHash('abc12345', rows);
    let state = readState(null, hash);
    assert.deepEqual(state, { planHash: hash, ticked: [] });
    state = toggle(state, 'Farmland|rice', true);
    const raw = writeState(state);
    assert.deepEqual(readState(raw, hash).ticked, ['Farmland|rice']);
    // A new setup hash, or different rows for the same setup, ignores the saved ticks.
    assert.deepEqual(readState(raw, checklistHash('zzz', rows)).ticked, []);
    assert.notEqual(checklistHash('abc12345', rows.slice(1)), hash);
    // A different Aniimo setup tab, a different count or a different worker is a different plan.
    assert.notEqual(checklistHash('abc12345', rows, 'minimum'), checklistHash('abc12345', rows, 'best'));
    assert.notEqual(checklistHash('abc12345', [{ ...rows[0], count: 5 }]), checklistHash('abc12345', [rows[0]]));
    assert.notEqual(checklistHash('abc12345', [{ ...rows[0], crew: 0 }]), checklistHash('abc12345', [rows[0]]));
    assert.notEqual(checklistHash('abc12345', [{ ...rows[1], aniimo: { ability: 'Fire', level: 3 } }]), checklistHash('abc12345', [rows[1]]));
    // Bad storage never throws.
    assert.deepEqual(readState('{not json', hash).ticked, []);
    assert.deepEqual(readState('{"planHash":"x","ticked":"no"}', 'x').ticked, []);
    assert.deepEqual(readState('null', hash).ticked, []);
});

test('test_toggle_and_all_ticked', () => {
    const rows = checklistRows(plan, roster);
    let state = readState(null, 'h');
    assert.equal(allTicked(state, rows), false);
    state = toggle(state, rows[0].id, true);
    state = toggle(state, rows[0].id, true);
    assert.equal(doneCount(state, rows), 1);
    state = toggle(state, rows[0].id, false);
    assert.equal(doneCount(state, rows), 0);
    state = tickAll(state, rows);
    assert.equal(allTicked(state, rows), true);
    assert.equal(allTicked(state, []), false);
    assert.equal(allTicked(untickAll(state), rows), false);
    assert.equal(doneCount({ ticked: ['gone', rows[0].id] }, rows), 1);
});

test('test_overlapping_buildings_are_one_row_named_by_zone', () => {
    // Two overlapping buildings come out of the engine as three zones, all named after the first.
    const paired = { coin_items: [
        { item_name: 'cocoa', facility: 'Woodland', facility_count: 1, status: 'producing', environment: 'Scorching' },
        { item_name: 'pearl', facility: 'Tidewhisper Sandcastle', facility_count: 2, status: 'producing', environment: 'Warm' },
        { item_name: 'quick_strawberry', facility: 'Farmland', facility_count: 15, status: 'producing', environment: 'Cool' },
        { item_name: 'rose', facility: 'Farmland', facility_count: 2, status: 'producing', environment: 'Warm' },
    ], environment_assignments: [
        { building: 'Sunlamp', mode: 'Adequate', units: 1, covered: [] },
        { building: 'Heat Furnace', mode: 'Scorching', units: 1, covered: [{ facility: 'Woodland', count: 1 }], partner: ['Cooling Unit', 3, 0], zone: 0, pair_modes: ['Scorching', 'Cool'] },
        { building: 'Heat Furnace', mode: 'Warm', units: 1, covered: [{ facility: 'Tidewhisper Sandcastle', count: 2 }], partner: ['Cooling Unit', 3, 0], zone: 1, pair_modes: ['Scorching', 'Cool'] },
        { building: 'Heat Furnace', mode: 'Cool', units: 1, covered: [{ facility: 'Farmland', count: 15 }], partner: ['Cooling Unit', 3, 0], zone: 2, pair_modes: ['Scorching', 'Cool'] },
    ] };
    const rows = checklistRows(paired);
    assert.deepEqual(rows.map(r => r.text), [
        'Woodland x1: Cocoa, needs Scorching (under a Heat Furnace)',
        'Tidewhisper Sandcastle x2: Pearl, needs Warm (in the overlap of a Heat Furnace (Scorching) and a Cooling Unit (Cool))',
        'Farmland x15: Quick Strawberry, needs Cool (under a Cooling Unit)',
        'Farmland x2: Rose, needs Warm',
        'Sunlamp (Adequate)',
        'Heat Furnace (Scorching) overlapping a Cooling Unit (Cool): Heat Furnace side covers 1 Woodland; overlap (Warm) covers 2 Tidewhisper Sandcastle; Cooling Unit side covers 15 Farmland',
    ]);
    assert.deepEqual(rows.slice(4).map(r => r.id), ['env|Sunlamp|Adequate|0', 'env|Heat Furnace+Cooling Unit|1']);
    assert.equal(checklistRows({ coin_items: [], environment_assignments: [null] }).length, 0);
});
