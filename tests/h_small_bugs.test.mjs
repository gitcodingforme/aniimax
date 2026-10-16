// H-f: what a loaded setup says the player chose, share links without roster names, and history
// messages that never claim a save the browser refused. H-g: an async bus listener's rejection is
// logged, not left unhandled.
import assert from 'node:assert/strict';
import test from 'node:test';

import { LEVEL_UP_COSTS, MAX_HOME_LEVEL } from '../web/facility-config.js';
import { addSnapshots, historyFile, makeSnapshot, parseHistoryFile } from '../web/history.js';
import { createShareUrl, readShareHash, shareableSetup } from '../web/share-config.js';
import { savedChoices } from '../web/setup-input.js';
import { appFunctions, declaration } from './helpers/app-source.mjs';

const config = { LEVEL_UP_COSTS, MAX_HOME_LEVEL };

test('test_saved_choices_follow_the_rv_level_unless_the_player_picked_another_target', () => {
    const at = (rv, target, extra = {}) => savedChoices({ 'home-level': String(rv), 'level-up-target': target, ...extra }, config);
    assert.equal(savedChoices({ 'home-level': '5' }, config).levelUpTargetChosen, false, 'nothing saved');
    assert.equal(at(5, '6').levelUpTargetChosen, false, 'RV + 1 is the target following the RV level');
    assert.equal(at(5, '9').levelUpTargetChosen, true);
    assert.equal(at(5, 9).levelUpTargetChosen, true, 'a number works as well as the select string');
    assert.equal(at(MAX_HOME_LEVEL, '12').levelUpTargetChosen, false, 'no RV + 1 at the top, so nothing to follow');
    assert.equal(at(5, '', {}).levelUpTargetChosen, true, 'a blank target is not RV + 1');
    assert.equal(at(5, '6').rateUnitChosen, false);
    assert.equal(at(5, '6', { 'rate-unit': 'day' }).rateUnitChosen, true);
    // currentConfig() always saves the select, so its default says nothing about a choice.
    assert.equal(at(5, '6', { 'rate-unit': 'second' }).rateUnitChosen, false);
    // A legacy save's RV level counts the same way.
    assert.equal(savedChoices({ facilityTiers: {}, 'home-level': '3', 'level-up-target': '4' }, config).levelUpTargetChosen, false);
});

test('test_a_share_link_keeps_every_key_but_the_roster_names', async () => {
    const setup = {
        facilityTiers: { Farmland: [{ count: 4, level: 2 }] },
        roster: [{ name: 'A private name', count: 2, abilities: { Fire: 3 } }, { count: 1, abilities: {} }],
        'mode-simple': false, 'rate-unit': 'hour',
    };
    const before = JSON.stringify(setup);
    const shared = shareableSetup(setup);
    assert.equal(JSON.stringify(setup), before, 'the page setup is not changed');
    assert.deepEqual(Object.keys(shared), Object.keys(setup));
    const back = await readShareHash(new URL(await createShareUrl('https://example.com/aniimax/', shared)).hash);
    assert.deepEqual(back, {
        ...setup,
        roster: [{ name: '', count: 2, abilities: { Fire: 3 } }, { count: 1, abilities: {} }],
    });
    assert.ok(!JSON.stringify(back).includes('private'));
    assert.deepEqual(shareableSetup({ facilityTiers: {} }), { facilityTiers: {} });
    assert.equal(shareableSetup(null), null);
});

function historyPage(existing = []) {
    const els = { 'history-status': { textContent: '' } };
    const stored = new Map([['aniimax-history-v1', JSON.stringify(existing)]]);
    const app = appFunctions(['HISTORY_KEY', 'readHistory', 'writeHistory', 'showHistoryStatus', 'importHistoryFile', 'clearHistory', 'deleteSnapshot'], {
        document: { getElementById: id => els[id] },
        localStorage: {
            getItem: key => stored.get(key) ?? null,
            setItem: () => { throw new Error('QuotaExceededError'); },
        },
        window: { confirm: () => true },
        addSnapshots, parseHistoryFile,
        publish: () => assert.fail('nothing is published when the save fails'),
        renderHistory: () => {},
        formatProfileTime: () => 'then',
    });
    return { app, status: () => els['history-status'].textContent };
}

const FAILED = 'Could not save: this browser refused to store the history (storage full or disabled).';

test('test_history_says_so_when_the_browser_refuses_to_store_it', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const snapshot = makeSnapshot({ setup: { facilityTiers: {}, 'home-level': '4' }, actual: { rv: 4 }, now: new Date('2026-10-01T10:00:00Z') });
    const other = makeSnapshot({ setup: { facilityTiers: {}, 'home-level': '5' }, actual: { rv: 5 }, now: new Date('2026-10-02T10:00:00Z') });

    const restore = historyPage([snapshot]);
    const file = JSON.stringify(historyFile(addSnapshots([], [other])));
    await restore.app.importHistoryFile({ text: async () => file });
    assert.equal(restore.status(), FAILED);

    const clear = historyPage([snapshot]);
    clear.app.clearHistory();
    assert.equal(clear.status(), FAILED);

    const remove = historyPage([snapshot]);
    remove.app.deleteSnapshot(snapshot.id);
    assert.equal(remove.status(), FAILED);
});

test('test_the_page_shares_the_shareable_setup_and_loads_its_choices', () => {
    assert.match(declaration('shareCurrentConfig').text, /createShareUrl\(window\.location\.href, shareableSetup\(currentConfig\(\)\)\)/);
    assert.match(declaration('loadInputsFromStorage').text, /\(\{ levelUpTargetChosen, rateUnitChosen \} = savedChoices\(data, pageConfig\(\)\)\)/);
});

test('test_an_async_bus_listener_that_rejects_is_logged', async (t) => {
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args));
    const { on, publish } = await import('../web/bus.js');
    const seen = [];
    const stopA = on('h-test-topic', async () => { throw new Error('async boom'); });
    const stopB = on('h-test-topic', value => seen.push(value));
    let unhandled = null;
    const onUnhandled = reason => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandled);
    publish('h-test-topic', 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    process.off('unhandledRejection', onUnhandled);
    stopA();
    stopB();
    assert.deepEqual(seen, [1], 'the other listener still ran');
    assert.equal(unhandled, null);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /h-test-topic/);
    assert.match(warnings[0][1].message, /async boom/);
});

test('test_the_saved_setup_keeps_its_shape', () => {
    const app = appFunctions(['getPersistedFieldIds']);
    assert.deepEqual(JSON.parse(JSON.stringify(app.getPersistedFieldIds())), [
        'target-amount', 'current-amount',
        'strategy-level-up', 'strategy-priorities', 'level-up-target',
        'mode-simple', 'mode-advanced', 'home-level',
        'ecological-module-level', 'kitchen-module-level',
        'resource-detector-level', 'crafting-module-level',
        'rate-unit', 'season-on', 'layout-sim-on', 'season-currency-per-day',
        'aniimo-best', 'aniimo-minimum', 'aniimo-custom',
        // Milestone 10: the E-mode inputs ride in the saved setup (so in profiles and share links).
        'emode-on', 'emode-generator-level', 'emode-generator-count', 'emode-supply',
    ]);
    assert.match(declaration('currentConfig').text,
        /const data = \{ facilityTiers, levelUpStock, skippedRecipes: \[\.\.\.skippedRecipes\], unlockedSpecial: \[\.\.\.unlockedSpecial\], priorities: priorityOrder, aniimoLevels, roster \};/);
});
