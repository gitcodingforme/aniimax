import assert from 'node:assert/strict';
import test from 'node:test';

import {
    bestShare, homeCapFor, measureFor, neededAbilities, rankRows, requirementsFromItems, rosterCandidates, stopsCheck, weakestLink,
} from '../web/roster-advisor.js';

// A small made-up config in ctx.config's shape.
const config = {
    abilities: ['Fire', 'Grass', 'Water', 'Earth', 'Ice', 'Dark', 'Hauling', 'Perfumery'],
    FACILITIES: [
        { name: 'Farmland' },
        { name: 'Mine', ability: 'Earth' },
        { name: 'Claw Game Cooker', ability: 'Fire' },
        { name: 'Phonolfactory Table', ability: 'Perfumery' },
        { name: 'Heat Furnace' },
    ],
    ANIIMO_MAX: [null, 8, 11],
};

const base = {
    currency: 'coins',
    priorities: ['coins'],
    exclude: ['locked_stew'],
    facilities: {
        Farmland: [{ count: 2, level: 1 }],
        Mine: [{ count: 1, level: 1 }],
        'Claw Game Cooker': [{ count: 1, level: 1 }],
        'Phonolfactory Table': [{ count: 0, level: 1 }],
        'Cooling Unit': [{ count: 1, level: 1 }],
    },
    aniimo: 'roster',
    aniimo_levels: {},
    roster: {
        members: [
            { count: 2, abilities: { Grass: 2, Dark: 4 }, personalities: ['Instinctive'] },
            { count: 1, abilities: { Earth: 3, Hauling: 3 }, personalities: [] },
            { count: 1, abilities: { Hauling: 2 }, personalities: [] },
        ],
        residents: [],
        environment: { 'Heat Furnace': 'Fire', 'Cooling Unit': 'Ice' },
        personalities: {},
    },
};

test('test_requirements_and_needed_abilities', () => {
    const rows = requirementsFromItems([
        { name: 'wheat', facility: 'Farmland', facility_level: 1, aniimo: null, jobs: [['Sowing', 'Grass', 1], ['Reaping', 'Dark', 1]] },
        { name: 'rock', facility: 'Mine', facility_level: 1, aniimo: ['Earth', 1], jobs: [] },
        { name: 'gem', facility: 'Mine', facility_level: 6, aniimo: ['Fire', 3], jobs: [] },
        { name: 'locked_stew', facility: 'Claw Game Cooker', facility_level: 1, aniimo: ['Ice', 1], jobs: [] },
        { name: 'perfume', facility: 'Phonolfactory Table', facility_level: 1, aniimo: ['Perfumery', 1] },
    ]);
    assert.deepEqual(rows.filter(r => r.name === 'wheat').map(r => r.ability), ['Grass', 'Dark', 'Water']);
    assert.deepEqual(rows.find(r => r.name === 'rock'), { name: 'rock', facility: 'Mine', facility_level: 1, season: false, ability: 'Earth', min_level: 1 });
    // A Mine at level 1 can't make gems, the excluded stew doesn't count, the Claw Game Cooker has
    // a row so its own ability isn't added, and the unowned table adds nothing. The Cooling Unit
    // brings Ice from the roster's environment map.
    assert.deepEqual([...neededAbilities(base, config, rows)], ['Grass', 'Water', 'Earth', 'Ice', 'Dark']);
    // A fake requirements table, and with none the facilities' own abilities stand in.
    const fake = [{ facility: 'Mine', ability: 'Earth', min_level: 1 }, { facility: 'Claw Game Cooker', ability: 'Fire', min_level: 2 }];
    assert.deepEqual([...neededAbilities(base, config, fake)], ['Fire', 'Earth', 'Ice']);
    assert.deepEqual([...neededAbilities(base, config, [])], ['Fire', 'Earth', 'Ice']);
    assert.deepEqual([...neededAbilities({ facilities: {} }, config, fake)], []);
});

test('test_candidates_for_a_roster_with_missing_abilities', () => {
    const needed = ['Fire', 'Grass', 'Earth', 'Dark', 'Perfumery'];
    const list = rosterCandidates(base, { neededAbilities: needed, homeCap: 4, names: ['', 'Rocky', ''] });
    // Reference, two removes (the Hauling-only Aniimo isn't tried), two levels, then Fire at 1 and 4
    // and Perfumery at 1 and its top, 3.
    assert.deepEqual(list.map(c => c.id), [
        'best', 'remove:0', 'remove:1', 'level:0', 'level:1', 'add:Fire:1', 'add:Fire:4', 'add:Perfumery:1', 'add:Perfumery:3',
    ]);
    assert.deepEqual(list.map(c => c.label), [
        'Best team (reference)',
        'One fewer Grass 2, Dark 4 Aniimo (of 2)',
        'Without Rocky',
        'One Grass 2, Dark 4 Aniimo a level higher (Grass 2 to 3)',
        'Rocky a level higher (Earth 3 to 4)',
        'New Fire Aniimo Lv.1', 'New Fire Aniimo Lv.4', 'New Perfumery Aniimo Lv.1', 'New Perfumery Aniimo Lv.3',
    ]);
    const byId = Object.fromEntries(list.map(c => [c.id, c]));
    assert.deepEqual(byId['remove:0'].input.roster.members.map(m => m.count), [1, 1, 1]);
    assert.equal(byId['remove:1'].input.roster.members.length, 2);
    const trained = byId['level:0'].input.roster.members;
    assert.deepEqual(trained.map(m => m.count), [1, 1, 1, 1]);
    assert.deepEqual(trained[3].abilities, { Grass: 3, Dark: 4 });
    assert.deepEqual(byId['level:1'].input.roster.members[1].abilities, { Earth: 4, Hauling: 3 });
    assert.deepEqual(byId['add:Fire:4'].input.roster.members.at(-1), { count: 1, abilities: { Fire: 4 }, personalities: [] });
    // Four on the roster and room for four: every new one is over the cap; none of the others are.
    assert.ok(list.filter(c => c.kind === 'add').every(c => c.overCap));
    assert.ok(list.filter(c => c.kind !== 'add').every(c => !c.overCap));
    assert.equal(rosterCandidates(base, { neededAbilities: needed, homeCap: 5 }).some(c => c.overCap), false);
    // The reference is the Best team, without the roster.
    const reference = JSON.parse(JSON.stringify(list[0].input));
    assert.equal(reference.aniimo, 'best');
    assert.equal('roster' in reference, false);
    assert.deepEqual(reference.aniimo_levels, {});
    assert.deepEqual(reference.facilities, base.facilities);
    // The base is never changed.
    assert.equal(base.roster.members.length, 3);
    assert.equal(base.roster.members[0].count, 2);
    // Capped: reference first, then removes, then levels.
    assert.deepEqual(rosterCandidates(base, { neededAbilities: needed, maxCandidates: 4 }).map(c => c.id), ['best', 'remove:0', 'remove:1', 'level:0']);
});

test('test_rank_rows_for_coins', () => {
    const candidates = [{ id: 'best', kind: 'best' }, { id: 'a', kind: 'remove', label: 'A' }, { id: 'b', kind: 'add', label: 'B', overCap: true },
        { id: 'c', kind: 'remove', label: 'C' }, { id: 'd', kind: 'level', label: 'D' }, { id: 'e', kind: 'level', label: 'E' }];
    const results = [{ top: 2 }, { top: 0.5, proven: true }, { top: 1.2, proven: false }, { top: 1 }, null, undefined];
    const rows = rankRows(candidates, 1, results, 'coins');
    // The reference and the unanswered one are left out; no plan sorts last.
    assert.deepEqual(rows.map(r => r.id), ['b', 'c', 'a', 'd']);
    assert.ok(Math.abs(rows[0].delta - 720) < 1e-9);
    assert.equal(rows[0].proven, false);
    assert.equal(rows[0].overCap, true);
    assert.equal(rows[0].coinsPerHour, 1.2 * 3600);
    assert.equal(rows[1].note, 'not needed by this plan');
    assert.equal(rows[1].flat, true);
    assert.equal(rows[2].delta, -1800);
    assert.equal(rows[3].status, 'none');
    assert.equal(rows[3].note, '');
    assert.equal(weakestLink(rows).id, 'c');
    // An unproven base makes every answer unproven.
    assert.equal(rankRows(candidates, { top: 1, proven: false }, results, 'coins')[1].proven, false);
});

test('test_rank_rows_for_a_level_up_pace', () => {
    const candidates = [{ id: 'best', kind: 'best' }, { id: 'a', kind: 'level', label: 'A' }, { id: 'b', kind: 'remove', label: 'B' },
        { id: 'c', kind: 'remove', label: 'C' }];
    // Pace is level-ups per day: 1 a day is 24 h, 2 a day is 12 h.
    const results = [{ top: 3 }, { top: 2, proven: true }, { top: 1, coins: { base: 0.5, value: 0.4 } }, { top: null }];
    const rows = rankRows(candidates, { measure: 'level_up', objective: 1, proven: true }, results, 'level_up');
    assert.deepEqual(rows.map(r => r.id), ['a', 'b', 'c']);
    assert.equal(rows[0].levelUpSeconds, 43200);
    assert.equal(rows[0].hoursSaved, 12);
    assert.equal(rows[0].delta, 12);
    assert.equal(rows[0].coinsPerHour, null);
    // The pace stays, so the Home Coins tiebreak shows.
    assert.equal(rows[1].flat, true);
    assert.equal(rows[1].hoursSaved, 0);
    assert.ok(Math.abs(rows[1].coinsDelta + 360) < 1e-9);
    assert.ok(Math.abs(rows[1].coinsPerHour - 1440) < 1e-9);
    assert.equal(rows[1].note, '');
    assert.equal(rows[2].status, 'none');
    assert.equal(rows[2].note, 'no plan without it');
    assert.equal(weakestLink(rows).id, 'b');
    assert.deepEqual(rankRows(candidates, 1, [], 'level_up'), []);
});

test('test_best_share_measure_and_cap', () => {
    assert.equal(bestShare(1, 4), 25);
    assert.equal(bestShare({ objective: 3 }, { top: 4 }), 75);
    assert.equal(bestShare(1, 0), null);
    assert.equal(bestShare(null, 4), null);
    assert.equal(measureFor({ priorities: ['aniimo_exp'] }, { levelUp: true, ready: true }), 'aniimo_exp');
    assert.equal(measureFor({ priorities: [] }, { levelUp: true }), 'level_up');
    assert.equal(measureFor({}, null), 'coins');
    assert.equal(homeCapFor({ config, simple: true, homeLevel: 3 }), 11);
    assert.equal(homeCapFor({ config, simple: true, homeLevel: 1 }), null);
    assert.equal(homeCapFor({ config, simple: true, homeLevel: 9 }), 11);
    assert.equal(homeCapFor({ config, simple: false, homeLevel: 3 }), null);
    assert.equal(homeCapFor({ config, simple: false, context: { levelUp: true, target: 3 } }), 8);
});

test('test_a_running_check_stops_on_another_setup_or_a_new_solve', () => {
    const checked = { tab: 'custom', setup: 'roster:1', setupHash: 'h1' };
    assert.equal(stopsCheck(checked, { tab: 'best', setup: 'best:x', setupHash: 'h1' }), true);
    assert.equal(stopsCheck(checked, { tab: 'minimum', setup: 'minimum', setupHash: 'h1' }), true);
    assert.equal(stopsCheck(checked, { tab: 'custom', setup: 'roster:1', setupHash: 'h2' }), true);
    // The same inputs, a roster edit on them, or a setup still solving keep it going.
    assert.equal(stopsCheck(checked, { tab: 'custom', setup: 'roster:1', setupHash: 'h1' }), false);
    assert.equal(stopsCheck(checked, { tab: 'custom', setup: 'roster:2', setupHash: 'h1' }), false);
    assert.equal(stopsCheck(checked, null), false);
    assert.equal(stopsCheck(null, { tab: 'best' }), false);
});
