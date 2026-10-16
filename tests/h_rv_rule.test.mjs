// H-b: the page's covering RV rule (the lowest RV level whose facilities and modules allow
// everything entered) is plan-summary.js's coveringHomeLevel. `pageCovering` below is app.js's own
// homeLevelCovering as it was at 2b84fae, kept here as the reference the shared rule must match.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FACILITIES, MAX_HOME_LEVEL, MODULE_MAX_LEVELS, simpleSetup } from '../web/facility-config.js';
import { coveringHomeLevel } from '../web/plan-summary.js';

const config = { FACILITIES, MAX_HOME_LEVEL, MODULE_MAX_LEVELS, simpleSetup };

function pageCovering(input) {
    const tierCount = tiers => (tiers || []).reduce((sum, t) => sum + t.count, 0);
    const tierLevel = tiers => Math.max(0, ...(tiers || []).filter(t => t.count > 0).map(t => t.level));
    for (let level = 1; level <= MAX_HOME_LEVEL; level++) {
        const allowed = simpleSetup(level);
        const facilitiesFit = FACILITIES.every(f => {
            const have = input.facilities[f.name];
            if (tierCount(have) === 0) return true;
            const cap = allowed.facilities[f.name];
            return tierCount(have) <= tierCount(cap) && (f.hasLevels === false || tierLevel(have) <= tierLevel(cap));
        });
        const modulesFit = Object.entries(input.modules).every(([name, level_]) => level_ <= (allowed.modules[name] ?? 0));
        if (facilitiesFit && modulesFit) return level;
    }
    return MAX_HOME_LEVEL;
}

const clone = value => JSON.parse(JSON.stringify(value));

// Every RV level's own setup, and each one changed by one: a facility one more or one fewer, a
// level up or down, a module up or down.
function inputs() {
    const list = [];
    for (let rv = 1; rv <= MAX_HOME_LEVEL; rv++) {
        const base = simpleSetup(rv);
        list.push({ why: `RV ${rv}`, input: clone(base) });
        for (const f of FACILITIES) {
            for (const [why, change] of [
                ['+1', t => { t.count += 1; }], ['-1', t => { t.count = Math.max(0, t.count - 1); }],
                ['level +1', t => { t.level += 1; }], ['level -1', t => { t.level = Math.max(1, t.level - 1); }],
            ]) {
                const input = clone(base);
                const tiers = input.facilities[f.name];
                if (!tiers?.length) continue;
                change(tiers[0]);
                list.push({ why: `RV ${rv} ${f.name} ${why}`, input });
            }
        }
        for (const module of Object.keys(base.modules)) {
            for (const step of [1, -1]) {
                const input = clone(base);
                input.modules[module] = Math.max(0, input.modules[module] + step);
                list.push({ why: `RV ${rv} ${module} ${step > 0 ? '+1' : '-1'}`, input });
            }
        }
    }
    return list;
}

test('test_the_shared_covering_rule_matches_the_pages_old_one', () => {
    const cases = inputs();
    assert.ok(cases.length > 500);
    for (const { why, input } of cases) assert.equal(coveringHomeLevel(input, config), pageCovering(input), why);
});
