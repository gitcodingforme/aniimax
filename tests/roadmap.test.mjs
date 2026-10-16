import assert from 'node:assert/strict';
import test from 'node:test';

import {
    emptyRoadmapStatus, homeLevelCovering, nextBatch, remainingCount, roadmapCandidates, roadmapHomeLevel, scoreRoadmap, setupAt, shouldStop, slowerItemThanCoins, upgradeCostOf,
} from '../web/roadmap.js';

// A small made-up config in ctx.config's shape, without the page's upgradeCost and simpleSetup.
const config = {
    MAX_HOME_LEVEL: 20,
    FACILITIES: [
        { name: 'Farmland', unlocks: { 1: 1, 2: 2, 3: 5, 4: 7 }, counts: [4, 6, 8, 10, 12] },
        { name: 'Mine', unlocks: { 1: 3, 2: 4, 3: 9 }, counts: [0, 0, 2, 2, 3] },
        { name: 'Heat Furnace', hasLevels: false, unlocks: { 1: 4 }, counts: [0, 0, 0, 1, 2] },
        { name: 'Well', unlocks: { 1: 4 }, counts: [0, 0, 0, 1] },
    ],
    FACILITY_UPGRADE_COSTS: { Farmland: { 2: 60, 3: 700, 4: 6200 }, Mine: { 2: 4200, 3: 31000 } },
    MODULE_MAX_LEVELS: { kitchen_module: [0, 1, 1, 2, 2, 3] },
    LEVEL_UP_COSTS: { 6: { coins: 32000, items: [['wood_block', 1300], ['mineral_sand', 700]] } },
};

const base = {
    currency: 'coins',
    exclude: ['rose_shortbread'],
    facilities: {
        Farmland: [{ count: 3, level: 2 }, { count: 1, level: 3 }],
        Mine: [{ count: 1, level: 2 }],
        'Heat Furnace': [{ count: 1, level: 1 }],
        Well: [{ count: 0, level: 1 }],
    },
    modules: { kitchen_module: 1 },
};

test('test_candidates_for_two_facility_types_with_costs_and_needs_rv', () => {
    const { candidates, deferred } = roadmapCandidates(base, { config, homeLevel: 5 });
    assert.deepEqual(deferred, []);
    assert.deepEqual(candidates.map(c => [c.label, c.kind, c.cost, c.needsRv]), [
        // Builds have no listed cost and go first; then upgrades, cheapest first; needs-RV last.
        ['+1 Farmland (Lv 1)', 'build', null, null],
        ['+1 Mine (Lv 1)', 'build', null, null],
        ['+1 Heat Furnace', 'build', null, null],
        ['1 Farmland to Lv 3', 'upgrade', 700, null],
        ['3 Farmland (Lv 2) to Lv 3', 'upgrade-all', 2100, null],
        ['Mine to Lv 3', 'upgrade', 31000, 9],
    ]);
    const byLabel = Object.fromEntries(candidates.map(c => [c.label, c]));
    assert.deepEqual(byLabel['1 Farmland to Lv 3'].input.facilities.Farmland, [{ count: 2, level: 2 }, { count: 2, level: 3 }]);
    assert.deepEqual(byLabel['3 Farmland (Lv 2) to Lv 3'].input.facilities.Farmland, [{ count: 4, level: 3 }]);
    assert.deepEqual(byLabel['+1 Mine (Lv 1)'].input.facilities.Mine, [{ count: 1, level: 1 }, { count: 1, level: 2 }]);
    // The rest of the input is kept, and the base is not changed.
    assert.deepEqual(byLabel['+1 Mine (Lv 1)'].input.exclude, ['rose_shortbread']);
    assert.deepEqual(base.facilities.Farmland, [{ count: 3, level: 2 }, { count: 1, level: 3 }]);
    // An upgrade a higher RV unlocks is shown but not solved.
    assert.equal(byLabel['Mine to Lv 3'].input, null);
    // Every unit at the same level reads "All k".
    const even = { ...base, facilities: { Farmland: [{ count: 4, level: 2 }] } };
    const labels = roadmapCandidates(even, { config, homeLevel: 5 }).candidates.map(c => `${c.label} ${c.cost}`);
    assert.deepEqual(labels, ['+1 Farmland (Lv 1) null', '1 Farmland to Lv 3 700', 'All 4 Farmland to Lv 3 2800']);
});

test('test_cap_defers_the_dearest_and_counts_allow_builds', () => {
    const { candidates, deferred } = roadmapCandidates(base, { config, homeLevel: 5, maxCandidates: 4 });
    assert.deepEqual(candidates.map(c => c.id), ['build:Farmland', 'build:Mine', 'build:Heat Furnace', 'upgrade:Farmland:3', 'upgrade:Mine:3']);
    assert.deepEqual(deferred.map(c => c.id), ['upgrade-all:Farmland:3']);
    // At RV 4 one more Mine fits (2 allowed), the Furnace is full (1 allowed), and Farmland Lv 3
    // needs RV 5.
    const atFour = roadmapCandidates(base, { config, homeLevel: 4 }).candidates.map(c => `${c.label}|${c.needsRv}`);
    assert.deepEqual(atFour, ['+1 Farmland (Lv 1)|null', '+1 Mine (Lv 1)|null', '1 Farmland to Lv 3|5', 'Mine to Lv 3|9']);
    // An unknown upgrade cost counts as dearest, and the page's own upgradeCost is preferred.
    const page = { ...config, upgradeCost: (f, from, to) => (f === 'Farmland' ? null : 5 * (to - from)) };
    const ids = roadmapCandidates(base, { config: page, homeLevel: 5, maxCandidates: 3 }).deferred.map(c => `${c.id} ${c.cost}`);
    assert.deepEqual(ids, ['upgrade:Farmland:3 null', 'upgrade-all:Farmland:3 null']);
});

test('test_simple_mode_offers_the_next_rv_level', () => {
    const simpleBase = { ...base, ...setupAt(config, 5) };
    const { candidates } = roadmapCandidates(simpleBase, { config, homeLevel: 5, simple: true, format: { number: n => `#${n}` } });
    const solvable = candidates.filter(c => c.input);
    assert.equal(solvable.length, 1);
    const [next] = solvable;
    assert.equal(next.label, 'Next RV: 6');
    assert.equal(next.kind, 'next-rv');
    assert.equal(next.cost, 32000);
    assert.deepEqual(next.items, [['wood_block', 1300], ['mineral_sand', 700]]);
    assert.match(next.note, /^Also needs #1300 Wood Block and #700 Mineral Sand\./);
    assert.deepEqual(next.input.facilities, setupAt(config, 6).facilities);
    assert.deepEqual(next.input.modules, setupAt(config, 6).modules);
    assert.equal(next.input.modules.kitchen_module, 3);
    // Everything else at RV 5 is already at its cap, so the upgrades wait for a higher RV.
    assert.deepEqual(candidates.filter(c => !c.input).map(c => `${c.label}|${c.needsRv}`), ['1 Farmland to Lv 4|7', '1 Mine to Lv 3|9']);
    // No next level without its cost.
    assert.equal(roadmapCandidates(simpleBase, { config, homeLevel: 6, simple: true }).candidates.some(c => c.kind === 'next-rv'), false);
});

test('test_home_level_follows_the_mode', () => {
    // Farmland Lv 3 needs RV 5.
    assert.equal(homeLevelCovering(base, config), 5);
    assert.equal(homeLevelCovering({ facilities: {}, modules: {} }, config), 1);
    // The rule every card shares (playerHomeLevel in web/plan-summary.js): a level-up plan's target
    // less one, else the saved RV input (in Advanced mode only when it covers what is owned), else
    // the lowest RV covering what is owned.
    assert.equal(roadmapHomeLevel(base, { config, simple: true, homeLevel: 12, context: { levelUp: true, target: 8 } }), 7);
    assert.equal(roadmapHomeLevel(base, { config, simple: true, homeLevel: 12, context: { levelUp: false, target: 8 } }), 12);
    assert.equal(roadmapHomeLevel(base, { config, simple: true, homeLevel: 12 }), 12);
    assert.equal(roadmapHomeLevel(base, { config, context: { levelUp: false, target: 9 } }), 5);
    assert.equal(roadmapHomeLevel(base, { config, context: { levelUp: true, target: 9 } }), 8);
    assert.equal(roadmapHomeLevel(base, { config, homeLevel: 12 }), 12);
    assert.equal(roadmapHomeLevel(base, { config, homeLevel: 3 }), 5);
    assert.equal(upgradeCostOf(config, 'Farmland', 1, 3), 760);
    assert.equal(upgradeCostOf(config, 'Mine', 3, 4), null);
});

const near0 = x => assert.ok(Math.abs(x) < 1e-9);
const cand = (id, cost, extra = {}) => ({ id, label: id, kind: 'upgrade', input: {}, cost, needsRv: null, ...extra });

test('test_scores_sort_by_payback_then_gain_then_the_rest', () => {
    const candidates = [
        cand('A', 100), cand('B', 1000), cand('C', null, { kind: 'build' }), cand('D', 50), cand('E', 31000, { input: null, needsRv: 9 }),
        cand('F', 10), cand('G', 20), cand('H', 10000), cand('I', null, { kind: 'build' }),
    ];
    const results = [
        { top: 1.01, proven: true }, { top: 1.5, proven: true }, { top: 1.2, proven: true }, { top: 1.0005, proven: true },
        undefined, undefined, null, { top: 1.1, proven: false }, { top: 1.4, proven: true },
    ];
    const rows = scoreRoadmap(candidates, 1, results, { coinsPerHour: 3600 });
    assert.deepEqual(rows.map(r => `${r.id}:${r.status}`), [
        'B:gain', 'A:gain', 'H:gain', 'I:gain', 'C:gain', 'F:pending', 'D:no-gain', 'G:failed', 'E:needs-rv',
    ]);
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
    near(byId.A.gainPerHour, 36);
    near(byId.A.paybackHours, 100 / 36);
    near(byId.A.affordInHours, 100 / 3600);
    near(byId.B.paybackHours, 1000 / 1800);
    assert.equal(byId.C.paybackHours, null);
    assert.equal(byId.C.affordInHours, null);
    assert.equal(byId.D.gainPerHour, 0);
    assert.equal(byId.D.paybackHours, null);
    assert.equal(byId.H.proven, false);
    assert.equal(byId.B.proven, true);
    assert.equal(byId.E.affordInHours, null);
    assert.equal(byId.F.gainPerHour, null);
});

test('test_scores_without_a_base_income_or_proof', () => {
    const candidates = [cand('A', 100), cand('B', 200)];
    // Keyed by id works as well as lined up.
    const rows = scoreRoadmap(candidates, null, { A: { top: 2 } }, { coinsPerHour: 0 });
    assert.deepEqual(rows.map(r => `${r.id}:${r.status}:${r.affordInHours}`), ['B:pending:null', 'A:failed:null']);
    const unproven = scoreRoadmap(candidates, 1, new Map([['A', { top: 2, proven: true }]]), { baseProven: false });
    assert.equal(unproven[0].proven, false);
    near0(unproven[0].gainPerHour - 3600);
    assert.deepEqual(scoreRoadmap([], 1, []), []);
});

test('test_next_batch_retries_unanswered_then_takes_deferred', () => {
    const shown = [cand('A', 1), cand('B', 2), cand('C', 3), cand('X', 4, { input: null, needsRv: 9 })];
    const deferred = [cand('D', 4), cand('E', 5), cand('F', 6)];
    const results = { A: { top: 1 }, C: null };
    assert.equal(remainingCount(shown, deferred, results), 4);
    const { batch, deferred: rest } = nextBatch(shown, deferred, results, 3);
    assert.deepEqual(batch.map(c => c.id), ['B', 'D', 'E']);
    assert.deepEqual(rest.map(c => c.id), ['F']);
    assert.deepEqual(nextBatch([], [], {}, 20), { batch: [], deferred: [] });
});

test('test_nothing_to_solve_says_why', () => {
    // Simple mode at the top RV: everything is at its top level and there is no next RV.
    const top = { ...base, ...setupAt(config, 20) };
    const { candidates, deferred } = roadmapCandidates(top, { config, homeLevel: 20, simple: true });
    assert.deepEqual(candidates, []);
    assert.deepEqual(deferred, []);
    assert.equal(emptyRoadmapStatus(candidates, deferred, 20, { simple: true }),
        'Everything you own is at its top level for RV 20, and there is no next RV to plan.');
    assert.equal(emptyRoadmapStatus([], [], 9), 'Everything you own is at its top level for RV 9.');
    // Only upgrades a higher RV unlocks: they are listed, and the line names the lowest RV.
    const waiting = roadmapCandidates({ ...base, facilities: { Mine: [{ count: 2, level: 2 }] } }, { config, homeLevel: 3 });
    assert.deepEqual(waiting.candidates.map(c => `${c.label}|${c.needsRv}`), ['1 Mine to Lv 3|9']);
    assert.equal(emptyRoadmapStatus(waiting.candidates, waiting.deferred, 3), 'Nothing can be upgraded until RV 9.');
    // Anything solvable, shown or deferred, means there is something to check.
    assert.equal(emptyRoadmapStatus([cand('A', 1)], [], 3), null);
    assert.equal(emptyRoadmapStatus([], [cand('A', 1)], 3), null);
});

test('test_advanced_mode_uses_the_saved_rv_or_the_level_below_a_level_up_target', () => {
    // At RV 6 (saved), or levelling up to RV 7: Farmland Lv 4 needs RV 7, so it waits; it is not solved.
    const atSix = { ...base, facilities: { Farmland: [{ count: 4, level: 3 }], Mine: [{ count: 1, level: 2 }] } };
    assert.equal(roadmapHomeLevel(atSix, { config, homeLevel: 6, context: { levelUp: true, target: 7 } }), 6);
    assert.equal(roadmapHomeLevel(atSix, { config, homeLevel: 6, context: { levelUp: true, target: 10 } }), 9);
    const homeLevel = roadmapHomeLevel(atSix, { config, homeLevel: 6, context: { levelUp: false, target: 10 } });
    assert.equal(homeLevel, 6);
    const { candidates } = roadmapCandidates(atSix, { config, homeLevel });
    assert.deepEqual(candidates.map(c => `${c.label}|${c.needsRv}|${c.input ? 'solve' : 'wait'}`), [
        '+1 Farmland (Lv 1)|null|solve', '+1 Mine (Lv 1)|null|solve', '1 Farmland to Lv 4|7|wait', 'Mine to Lv 3|9|wait',
    ]);
});

test('shouldStop: a run stops when no plan is left or the inputs were solved again', () => {
    const previous = { tab: 'best', setup: 'best:x', setupHash: 'h1' };
    assert.equal(shouldStop(true, previous, null), true);
    assert.equal(shouldStop(true, previous, { tab: 'best', setup: 'best:x', setupHash: 'h2' }), true);
    assert.equal(shouldStop(true, previous, { tab: 'best', setup: 'best:x', setupHash: 'h1' }), false);
    // Another Aniimo setup on the same inputs is not a new solve of the inputs, so this card leaves it be.
    assert.equal(shouldStop(true, previous, { tab: 'minimum', setup: 'minimum', setupHash: 'h1' }), false);
    // Nothing running, nothing to stop; no plan to compare with, nothing to decide on.
    assert.equal(shouldStop(false, previous, null), false);
    assert.equal(shouldStop(false, previous, { setupHash: 'h2' }), false);
    assert.equal(shouldStop(true, null, { setupHash: 'h2' }), false);
});

test('test_next_rv_names_an_item_slower_than_the_coins', () => {
    const requirements = [
        { name: 'coins', need: 32000, have: 0, per_second: 2, seconds: 16000 },
        { name: 'wood_block', need: 1300, have: 100, per_second: 0.0246, seconds: 48780 },
        { name: 'mineral_sand', need: 700, have: 700, per_second: 0.01, seconds: 0 },
    ];
    // Coins saved in 4h 27m; Wood Blocks take 13h 33m.
    assert.deepEqual(slowerItemThanCoins(requirements, 16000), { name: 'wood_block', seconds: 48780 });
    assert.equal(slowerItemThanCoins(requirements, 50000), null);
    assert.deepEqual(slowerItemThanCoins([{ name: 'mineral_sand', seconds: null }], 10), { name: 'mineral_sand', seconds: null });
    assert.equal(slowerItemThanCoins([{ name: 'coins', seconds: 99 }], 10), null);
    assert.equal(slowerItemThanCoins(undefined, 10), null);
    // Rows carry the candidate's level, so the card can match the plan's level-up target.
    assert.equal(scoreRoadmap([cand('next-rv:6', 32000, { kind: 'next-rv', level: 6 })], 1, [])[0].level, 6);
});
