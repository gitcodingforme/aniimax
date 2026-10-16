import assert from 'node:assert/strict';
import test from 'node:test';

import {
    applyEdits, buildableFacilities, coveringHomeLevel, editsFromForm, homeLevelFor, sideBySide, slugOf, warnings,
} from '../web/what-if.js';

// A plan input in the shape the 'plan' topic carries (app.js getPlanInputValues + aniimoInput).
const base = {
    currency: 'coins',
    exclude: ['rose_shortbread'],
    facilities: {
        Farmland: [{ count: 4, level: 2 }, { count: 1, level: 3 }],
        Mine: [{ count: 2, level: 1 }],
        'Heat Furnace': [{ count: 1, level: 1 }],
    },
    modules: { ecological_module: 1, kitchen_module: 2 },
    aniimo: 'best',
    aniimo_levels: { Earth: 4, Perfumery: 3 },
};
const rosterBase = {
    ...base,
    aniimo: 'roster',
    aniimo_levels: {},
    roster: {
        members: [
            { count: 2, abilities: { Earth: 2, Water: 3 }, personalities: ['Playful', 'Faithful'] },
            { count: 1, abilities: { Fire: 1 }, personalities: ['Judicious', 'Nimble'] },
        ],
        residents: ['Mine'],
    },
};

// A small made-up config in ctx.config's shape.
const config = {
    FACILITIES: [
        { name: 'Farmland', unlocks: { 1: 1, 2: 2, 3: 5, 4: 7 }, counts: [4, 6, 8, 10, 12] },
        { name: 'Mine', unlocks: { 1: 3, 2: 6 }, counts: [0, 0, 2, 2, 3] },
        { name: 'Heat Furnace', hasLevels: false, unlocks: { 1: 4 }, counts: [0, 0, 0, 1, 2] },
        { name: 'Well', unlocks: { 1: 4, 2: 8 }, counts: [0, 0, 0, 1] },
    ],
    MODULE_MAX_LEVELS: { ecological_module: [0, 0, 1, 1, 1, 2], kitchen_module: [0, 1, 1, 2, 2, 3] },
    moduleNames: { ecological_module: 'Ecological Module' },
    ANIIMO_MAX: [null, 8, 11, 14],
};

test('test_apply_edits_copies_deeply_and_changes_only_what_is_named', () => {
    const before = structuredClone(base);
    const edited = applyEdits(base, {
        facilities: { Mine: [{ count: 3, level: 2 }] },
        modules: { kitchen_module: 3 },
        aniimoLevels: { Earth: 2 },
    });
    assert.deepEqual(base, before, 'the base is left alone');
    assert.notEqual(edited, base);
    assert.notEqual(edited.facilities.Farmland, base.facilities.Farmland);
    assert.deepEqual(edited.facilities.Mine, [{ count: 3, level: 2 }]);
    assert.deepEqual(edited.facilities.Farmland, base.facilities.Farmland);
    assert.deepEqual(edited.modules, { ecological_module: 1, kitchen_module: 3 });
    assert.deepEqual(edited.aniimo_levels, { Earth: 2, Perfumery: 3 });
    edited.facilities.Farmland[0].count = 99;
    assert.equal(base.facilities.Farmland[0].count, 4);
    assert.deepEqual(applyEdits(base, {}), base);
    assert.deepEqual(applyEdits(base), base);
});

test('test_apply_edits_sets_a_roster_members_ability_level', () => {
    const before = structuredClone(rosterBase);
    const edited = applyEdits(rosterBase, { rosterLevels: { 0: { Water: 4 }, 1: { Fire: 2 }, 7: { Fire: 4 } } });
    assert.deepEqual(rosterBase, before);
    assert.deepEqual(edited.roster.members[0].abilities, { Earth: 2, Water: 4 });
    assert.deepEqual(edited.roster.members[1].abilities, { Fire: 2 });
    assert.equal(edited.roster.members.length, 2, 'a member that does not exist is skipped');
    assert.deepEqual(edited.roster.members[0].personalities, ['Playful', 'Faithful']);
    assert.deepEqual(edited.roster.residents, ['Mine']);
});

test('test_warnings_flag_each_limit_and_never_throw', () => {
    assert.deepEqual(warnings(base, config, null), [], 'no RV level: only the game-wide limits apply');
    const over = applyEdits(rosterBase, {
        facilities: { Farmland: [{ count: 9, level: 4 }], 'Heat Furnace': [{ count: 3, level: 1 }] },
        modules: { ecological_module: 2, kitchen_module: 9 },
        rosterLevels: {},
    });
    over.roster.members[0].count = 12;
    assert.deepEqual(warnings(over, config, 3), [
        'Farmland: 9 is more than RV 3 has room for (8).',
        'Farmland: level 4 needs RV 7, above RV 3.',
        'Heat Furnace: 3 is more than RV 3 has room for (0).',
        'Ecological Module: level 2 is more than RV 3 allows (1).',
        'Kitchen Module: level 9 is above the highest level known (3).',
        'Aniimo: 13 is more than RV 3 has room for (11).',
    ]);
    // Past the end of a per-RV list, the last value holds; a level above every unlock is the game's top.
    assert.deepEqual(warnings({ facilities: { Farmland: [{ count: 13, level: 5 }] } }, config, 9), [
        'Farmland: 13 is more than RV 9 has room for (12).',
        'Farmland: level 5 is above the highest level known (4).',
    ]);
    assert.deepEqual(warnings({ aniimo: 'roster', roster: { members: [{ count: 5 }, { count: 4 }] } }, config, 2), ['Aniimo: 9 is more than RV 2 has room for (8).']);
    assert.deepEqual(warnings({ aniimo: 'roster', roster: { members: [{ count: 50 }] } }, config, 1), [], 'RV 1 has no known limit');
    assert.deepEqual(warnings(null, config, 3), []);
    assert.deepEqual(warnings(base, {}, 3), []);
});

const planOf = (rate, seconds, rows) => ({
    success: true,
    rate_per_second: rate,
    proven_optimal: true,
    level_up: seconds === null ? null : { seconds },
    coin_items: rows.map(([facility, item_name, facility_count]) => ({ facility, item_name, facility_count, status: 'producing', cycle_time: 60 })),
});

test('test_side_by_side_gives_deltas_and_changed_rows', () => {
    const a = planOf(1, 7200, [['Farmland', 'rice', 4], ['Mine', 'rock', 2]]);
    const b = planOf(1.5, 5400, [['Farmland', 'rice', 6], ['Mine', 'rock', 2], ['Well', 'well_water', 1]]);
    const cmp = sideBySide(a, b);
    assert.equal(cmp.a.coinsPerHour, 3600);
    assert.equal(cmp.b.coinsPerHour, 5400);
    assert.equal(cmp.deltaCoinsPerHour, 1800);
    assert.equal(cmp.deltaLevelUpSeconds, -1800);
    assert.deepEqual(cmp.rows.map(r => [r.key, r.before, r.after]), [['Farmland:rice', 4, 6], ['Well:well_water', 0, 1]]);
    // No level-up on one side: no time delta. A failed plan: no deltas and no rows.
    assert.equal(sideBySide(a, planOf(1, null, [])).deltaLevelUpSeconds, null);
    const failed = sideBySide(a, { success: false, error: 'no plan' });
    assert.equal(failed.b.ok, false);
    assert.deepEqual([failed.deltaCoinsPerHour, failed.deltaLevelUpSeconds, failed.rows], [null, null, []]);
});

test('test_edits_from_form_reads_flat_values', () => {
    assert.equal(slugOf('Tidewhisper Sandcastle'), 'tidewhisper-sandcastle');
    const edits = editsFromForm({
        'facility|Farmland|0|count': '6', 'facility|Farmland|0|level': '3',
        'facility|Farmland|1|count': 1, 'facility|Farmland|1|level': '3',
        'facility|Mine|0|count': '2',
        'facility|Well|0|count': '', 'facility|Well|0|level': '1',
        'module|kitchen_module': '4',
        'ability|Earth': 3,
        'roster|1|Fire': '2',
        'ability|Water': 'x',
        'unknown|thing': '5',
    });
    assert.deepEqual(edits, {
        facilities: { Farmland: [{ count: 6, level: 3 }, { count: 1, level: 3 }] },
        modules: { kitchen_module: 4 },
        aniimoLevels: { Earth: 3 },
        rosterLevels: { 1: { Fire: 2 } },
    });
    assert.deepEqual(editsFromForm(), { facilities: {}, modules: {}, aniimoLevels: {}, rosterLevels: {} });
    // The result is what applyEdits takes.
    assert.equal(applyEdits(base, edits).facilities.Farmland[0].count, 6);
});

test('test_facilities_you_could_build_are_unowned_unlocked_ones_with_room', () => {
    const own = { facilities: { Farmland: [{ count: 4, level: 1 }], Mine: [{ count: 0, level: 1 }] } };
    assert.deepEqual(buildableFacilities(own, config, 2), []);
    assert.deepEqual(buildableFacilities(own, config, 3), ['Mine']);
    assert.deepEqual(buildableFacilities(own, config, 4), ['Mine', 'Heat Furnace', 'Well']);
    assert.deepEqual(buildableFacilities(base, config, 9), ['Well'], 'owned ones are left out; the last count holds past the list');
    assert.deepEqual(buildableFacilities(own, config, null), []);
});

test('test_home_level_is_the_simple_one_or_the_lowest_covering_what_is_owned', () => {
    assert.equal(coveringHomeLevel(base, config), 5, 'Farmland level 3 needs RV 5');
    assert.equal(coveringHomeLevel({ facilities: {} }, config), 1);
    assert.equal(coveringHomeLevel({ facilities: { Farmland: [{ count: 99, level: 1 }] } }, config), 20);
    assert.equal(homeLevelFor(base, config, { simple: true, homeLevel: '8', target: 7 }), 6, 'a level-up target less one');
    assert.equal(homeLevelFor(base, config, { simple: true, homeLevel: '8' }), 8);
    assert.equal(homeLevelFor(base, config, { simple: true }), 20);
    assert.equal(homeLevelFor(base, config, { simple: false, homeLevel: 12 }), 5);
});

test('test_a_count_zero_facility_is_edited_like_any_other', () => {
    const owned = { facilities: { Farmland: [{ count: 1, level: 1 }], Well: [{ count: 0, level: 1 }] }, modules: {} };
    const edits = editsFromForm({ 'facility|Well|0|count': '2', 'facility|Well|0|level': '1' });
    const edited = applyEdits(owned, edits);
    assert.deepEqual(edited.facilities.Well, [{ count: 2, level: 1 }]);
    assert.deepEqual(owned.facilities.Well, [{ count: 0, level: 1 }]);
    assert.deepEqual(applyEdits({ facilities: {} }, edits).facilities, { Well: [{ count: 2, level: 1 }] });
    assert.deepEqual(warnings(edited, config, 4), ['Well: 2 is more than RV 4 has room for (1).']);
});
