// H0: names from a share link (skipped recipes) and from the roster reach the Opportunities card's
// HTML escaped exactly once. Before the fix, a link's skippedRecipes entry such as
// '<img src=x onerror=...>' became 'Unskip <img ...>' and was written into innerHTML as markup.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PACE_UNIT_SECONDS, RANK_MIN_GAIN, escapeHtml, tierCount } from '../web/shared.js';
import { appFunctions } from './helpers/app-source.mjs';

const HOSTILE = '<img src=x onerror=alert(1)>';

function fakeDocument() {
    const els = {
        'improve-card': { style: {} },
        'improve-list': { innerHTML: '' },
        'rate-unit': { value: 'hour' },
    };
    return { els, document: { getElementById: id => els[id], querySelector: () => null } };
}

function page(globals = {}) {
    const { els, document } = fakeDocument();
    const app = appFunctions(
        ['RATE_UNIT_SECONDS', 'escapeText', 'formatPercent', 'improvementGain', 'improvementsChecked', 'renderImprovements', 'ranking', 'lastPlan'],
        {
            document,
            planContext: null,
            RANK_MIN_GAIN,
            PACE_UNIT_SECONDS,
            escapeHtml,
            priorityLabel: target => String(target),
            formatRate: n => String(Math.round(n)),
            formatDuration: s => `${Math.round(s)} s`,
            ...globals,
        },
    );
    app.lastPlan = { success: true };
    return { app, els };
}

test('test_a_skipped_recipe_from_a_share_link_is_escaped_in_the_opportunities_card', () => {
    const { app, els } = page();
    app.ranking = {
        setup: 'best:', measure: 'coins', homeLevel: null, done: true,
        candidates: [{ kind: 'Recipes', label: `Unskip ${HOSTILE}` }],
        base: { top: 1 },
        results: [{ top: 2 }],
    };
    app.renderImprovements();
    const html = els['improve-list'].innerHTML;
    assert.ok(!html.includes('<img'), html);
    assert.ok(html.includes('Unskip &lt;img src=x onerror=alert(1)&gt;'), html);
});

test('test_a_roster_name_is_escaped_once_in_the_checked_list', () => {
    const { app, els } = page();
    app.ranking = {
        setup: 'roster:[]', measure: 'coins', homeLevel: null, done: true,
        candidates: [
            { kind: 'Aniimo', group: 'roster:0:Fire', family: 'One Tom & <b>Jerry</b>: Fire', level: 2, label: 'One Tom & <b>Jerry</b>: Fire Lv.2' },
            { kind: 'Aniimo', group: 'roster:0:Fire', family: 'One Tom & <b>Jerry</b>: Fire', level: 3, label: 'One Tom & <b>Jerry</b>: Fire Lv.3' },
        ],
        base: { top: 1 },
        results: [{ top: 1 }, { top: 1.5 }],
    };
    app.renderImprovements();
    const html = els['improve-list'].innerHTML;
    assert.ok(!html.includes('<b>'), html);
    assert.ok(html.includes('One Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;: Fire Lv.2–3'), html);
    assert.ok(html.includes('One Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;: Fire Lv.3'), html);
    assert.ok(!html.includes('&amp;amp;') && !html.includes('&amp;lt;'), 'escaped once, not twice');
});

test('test_improvement_candidates_keep_the_roster_name_plain_for_render_time_escaping', async () => {
    const { FACILITIES, SPECIAL_RECIPES, SEASON, simpleSetup } = await import('../web/facility-config.js');
    const f = FACILITIES.find(x => x.ability && x.hasLevels !== false);
    const name = 'Tom & <b>Jerry</b>';
    const app = appFunctions(['improvementCandidates'], {
        FACILITIES, SPECIAL_RECIPES, SEASON, simpleSetup,
        planContext: { simple: true, skipped: [] },
        skippedRecipes: new Set(),
        roster: [{ name, count: 2, abilities: { [f.ability]: 1 } }],
        prettyItem: n => n,
        levelledAbilities: () => [f.ability],
        defaultLevelFor: () => 2,
        tierCount,
        rosterLabel: () => 'unnamed',
        escapeText: () => { throw new Error('names are escaped where they are rendered, not here'); },
    });
    const base = {
        exclude: [], season: false, aniimo_levels: {}, modules: {},
        facilities: { [f.name]: [{ count: 1, level: 1 }] },
        roster: { members: [{ count: 2, abilities: { [f.ability]: 1 } }] },
    };
    const [candidate] = app.improvementCandidates(base, 'roster:[]');
    assert.equal(candidate.family, `One ${name}: ${f.ability}`);
    assert.equal(candidate.label, `One ${name}: ${f.ability} Lv.2`);
});
