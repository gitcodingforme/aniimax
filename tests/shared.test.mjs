import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as shared from '../web/shared.js';
import {
    ABILITY_DEFAULTS, ENVIRONMENT_BUILDING_ABILITY, MAX_ANIIMO_LEVEL, PACE_UNIT_SECONDS, PRIORITY_TARGETS, RANK_MIN_GAIN,
    defaultLevelFor, escapeHtml, measureFor, onceUntilFailed, tierCount, tierLevel,
} from '../web/shared.js';

test('test_the_shared_values_are_frozen_and_match_the_engine', () => {
    assert.equal(MAX_ANIIMO_LEVEL, 4);
    assert.deepEqual({ ...ABILITY_DEFAULTS }, { Perfumery: 3 });
    assert.equal(defaultLevelFor('Perfumery'), 3);
    assert.equal(defaultLevelFor('Fire'), 4);
    assert.deepEqual(PRIORITY_TARGETS.map(t => t.id), ['coins', 'aniimo_exp', 'aniipods', 'Wood Blocks', 'Mineral Sand', 'season_points']);
    assert.deepEqual(PRIORITY_TARGETS.filter(t => t.season).map(t => t.id), ['season_points']);
    assert.deepEqual({ ...ENVIRONMENT_BUILDING_ABILITY }, { 'Heat Furnace': 'Fire', 'Cooling Unit': 'Ice', 'Sunlamp': 'Light' });
    assert.equal(RANK_MIN_GAIN, 1e-3);
    assert.equal(PACE_UNIT_SECONDS, 86400);
    for (const value of [ABILITY_DEFAULTS, PRIORITY_TARGETS, ENVIRONMENT_BUILDING_ABILITY, ...PRIORITY_TARGETS]) assert.ok(Object.isFrozen(value));
    assert.throws(() => { ABILITY_DEFAULTS.Fire = 2; }, TypeError);
});

test('test_tier_helpers_ignore_empty_and_negative_counts', () => {
    assert.equal(tierCount(undefined), 0);
    assert.equal(tierCount([{ count: 3, level: 2 }, { count: -2, level: 5 }, null, { count: 1, level: 4 }]), 4);
    assert.equal(tierLevel([{ count: 3, level: 2 }, { count: -2, level: 5 }, { count: 0, level: 9 }, { count: 1, level: 4 }]), 4);
    assert.equal(tierLevel([]), 0);
});

test('test_escape_html_covers_quotes_and_null', () => {
    assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(5), '5');
});

test('test_measure_for_prefers_a_workable_level_up', () => {
    assert.equal(measureFor({ priorities: ['aniimo_exp'] }, { levelUp: true }), 'level_up');
    assert.equal(measureFor({ priorities: ['aniimo_exp'] }, { levelUp: true, ready: true }), 'aniimo_exp');
    assert.equal(measureFor({ priorities: [] }, { levelUp: true, unavailable: 'no cost' }), 'coins');
    assert.equal(measureFor(null, null), 'coins');
});

test('test_once_until_failed_keeps_a_success_and_retries_a_failure', async () => {
    let calls = 0;
    const fails = [true, false];
    const load = onceUntilFailed(async () => {
        calls++;
        if (fails.shift()) throw new Error('offline');
        return 'bytes';
    });
    const [a, b] = [load(), load()];
    assert.equal(a, b, 'two callers before it settles share one load');
    await assert.rejects(a, /offline/);
    assert.equal(await load(), 'bytes', 'a failed load is tried again');
    assert.equal(await load(), 'bytes');
    assert.equal(calls, 2);

    let tries = 0;
    const throwing = onceUntilFailed(() => {
        tries++;
        throw new Error('sync');
    });
    await assert.rejects(throwing(), /sync/);
    await assert.rejects(throwing(), /sync/);
    assert.equal(tries, 2);
});

test('test_shared_js_is_a_leaf_and_the_modules_pass_on_its_copies', async () => {
    const source = await readFile(new URL('../web/shared.js', import.meta.url), 'utf8');
    assert.ok(!/^\s*import\s/m.test(source), 'shared.js imports nothing');
    const roadmap = await import('../web/roadmap.js');
    const advisor = await import('../web/roster-advisor.js');
    const coverage = await import('../web/coverage.js');
    // The modules import shared.js with the page's tag, a module instance of its own in Node.
    const tagged = await import(`../web/shared.js${(await readFile(new URL('../web/roadmap.js', import.meta.url), 'utf8')).match(/shared\.js(\?v=[\w-]+)/)[1]}`);
    assert.equal(roadmap.tierCount, tagged.tierCount);
    assert.equal(roadmap.tierLevel, tagged.tierLevel);
    assert.equal(advisor.measureFor, tagged.measureFor);
    assert.equal(advisor.PACE_UNIT_SECONDS, shared.PACE_UNIT_SECONDS);
    assert.equal(advisor.ADVISOR_MIN_GAIN, shared.RANK_MIN_GAIN);
    assert.deepEqual({ ...advisor.ABILITY_CAPS }, { ...shared.ABILITY_DEFAULTS });
    assert.equal(coverage.escapeHtml, tagged.escapeHtml);
});

test('test_no_module_keeps_its_own_copy_of_a_shared_rule', async () => {
    const own = {
        'app.js': [/const (tierCount|tierLevel|RANK_MIN_GAIN|PACE_UNIT_SECONDS|MAX_ANIIMO_LEVEL|ABILITY_DEFAULTS|ENVIRONMENT_BUILDING_ABILITY)\b/, /function (homeLevelCovering|rankMeasure)\b/],
        'setup-input.js': [/const (PRIORITY_TARGETS|ENVIRONMENT_BUILDING_ABILITY|ABILITY_DEFAULTS|MAX_ANIIMO_LEVEL|defaultLevelFor)\b/],
        'worker.js': [/const RANK_MIN_GAIN\b/],
        'plan-summary.js': [/const owned(Count|Level)\b/],
        'goal-mode.js': [/const tier(Count|Level)\b/],
        'roadmap.js': [/const tier(Count|Level)\b/],
        'coverage.js': [/function escapeHtml\b/],
        'roster-advisor.js': [/function measureFor\b/],
    };
    for (const [file, patterns] of Object.entries(own)) {
        const source = await readFile(new URL(`../web/${file}`, import.meta.url), 'utf8');
        for (const pattern of patterns) assert.ok(!pattern.test(source), `${file} still has ${pattern}`);
    }
});
