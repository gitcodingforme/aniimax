// H-c: the plan input the page sends equals setup-input.js's planInputFromSetup for the same saved
// setup. Each fixture in tests/fixtures/setups/ (shaped like currentConfig() in app.js) is loaded
// the way the page loads a saved setup, on a fake DOM that behaves like index.html's inputs
// (radio groups, selects that drop a value they have no option for); the page's own functions,
// sliced out of app.js, then build the input for each Aniimo tab. The result must equal
// planInputFromSetup(fixture, pageConfig(), { aniimoTab }) and the golden file next to the fixture
// (<name>.input.json). Run with UPDATE_GOLDEN=1 to write the golden files again.
//
// The golden files were written at 2b84fae, while the page still built the input with functions
// of its own (levelUpInput, excludedRecipes, rosterPayload, ...), after this test had shown those
// equal to planInputFromSetup for every fixture. The page now calls planInputFromSetup and
// aniimoInputFromSetup itself, so the files pin its load path and wrappers to what it sent then.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import * as facilityConfig from '../web/facility-config.js';
import * as shared from '../web/shared.js';
import * as setupInput from '../web/setup-input.js';
import { planInputFromSetup } from '../web/setup-input.js';
import { appFunctions, plain } from './helpers/app-source.mjs';

const DIR = new URL('./fixtures/setups/', import.meta.url);
const FIXTURES = readdirSync(DIR).filter(name => name.endsWith('.json') && !name.endsWith('.input.json')).sort();

// The persisted inputs as index.html has them: type, radio group and default.
const FIELDS = {
    'target-amount': { type: 'number', value: '1000' }, 'current-amount': { type: 'number', value: '0' },
    'strategy-level-up': { type: 'radio', name: 'strategy', checked: true }, 'strategy-priorities': { type: 'radio', name: 'strategy' },
    'level-up-target': { type: 'select' },
    'mode-simple': { type: 'radio', name: 'config-mode', checked: true }, 'mode-advanced': { type: 'radio', name: 'config-mode' },
    'home-level': { type: 'select' }, 'fill-level': { type: 'select' },
    'ecological-module-level': { type: 'number', value: '0' }, 'kitchen-module-level': { type: 'number', value: '0' },
    'resource-detector-level': { type: 'number', value: '0' }, 'crafting-module-level': { type: 'number', value: '0' },
    'rate-unit': { type: 'select', options: ['second', 'minute', 'hour', 'day'] },
    'season-on': { type: 'checkbox' }, 'layout-sim-on': { type: 'checkbox', checked: true },
    'season-currency-per-day': { type: 'number', value: '' },
    'aniimo-best': { type: 'radio', name: 'aniimo-setup', checked: true }, 'aniimo-minimum': { type: 'radio', name: 'aniimo-setup' },
    'aniimo-custom': { type: 'radio', name: 'aniimo-setup' },
};

function fakeDocument() {
    const els = {};
    for (const [id, spec] of Object.entries(FIELDS)) {
        if (spec.type === 'select') {
            let options = spec.options || [];
            let value = options[0] ?? '';
            els[id] = {
                id, tagName: 'SELECT', type: 'select-one',
                get options() { return options.map(v => ({ value: v })); },
                set innerHTML(html) {
                    options = [...html.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
                    value = options[0] ?? '';
                },
                get value() { return value; },
                // A select keeps a value only when it has an option for it.
                set value(v) { value = options.includes(String(v)) ? String(v) : ''; },
            };
        } else if (spec.type === 'radio' || spec.type === 'checkbox') {
            let checked = !!spec.checked;
            els[id] = {
                id, tagName: 'INPUT', type: spec.type, name: spec.name,
                get checked() { return checked; },
                set checked(on) {
                    checked = !!on;
                    if (checked && spec.type === 'radio') {
                        for (const other of Object.values(els)) if (other !== els[id] && other.type === 'radio' && other.name === spec.name) other.checked = false;
                    }
                },
            };
        } else {
            let value = spec.value;
            els[id] = {
                id, tagName: 'INPUT', type: spec.type,
                get value() { return value; },
                // A number input drops what is not a number.
                set value(v) { value = /^\s*-?\d*\.?\d+(e[+-]?\d+)?\s*$/i.test(String(v)) || String(v) === '' ? String(v).trim() : ''; },
            };
        }
    }
    return { getElementById: id => els[id] ?? null };
}

// What the page functions below call but app.js imports.
const IMPORTS = {
    ...facilityConfig,
    ...shared,
    ...setupInput,
    PRIORITY_IDS: shared.PRIORITY_TARGETS,
};

// Every page declaration getPlanInputValues and aniimoInput reach, plus the page's load path.
const PAGE = [
    'STORAGE_KEY', 'facilityTiers', 'defaultFacilityTiers', 'getPersistedFieldIds', 'readStorage', 'initFacilityTiers',
    'currentConfig', 'loadInputsFromStorage', 'bestAniimoSetup', 'MODULE_NAMES', 'roster', 'skippedRecipes', 'unlockedSpecial',
    'levelUpStock', 'levelledAbilities', 'aniimoLevels', 'aniimoInput', 'bestAniimoLevel', 'PRIORITY_LABELS', 'PRIORITY_TARGETS',
    'priorityOrder', 'populateLevelUpTargets', 'getPlanInputValues', 'numberOrDefault', 'floatOrDefault', 'ABILITIES',
    'ABILITY_BY_NAME', 'isSimpleMode', 'selectedHomeLevel', 'populateHomeLevels', 'levelUpTargetChosen', 'followLevelUpTarget',
    'pageConfig', 'pageConfigMemo', 'rateUnitChosen',
];

// The page after loading `setup` from storage (initApp's order), with the plan input builders.
function loadedPage(setup) {
    const saved = new Map([['aniimax-config-v1', JSON.stringify(setup)]]);
    const app = appFunctions(PAGE, {
        ...IMPORTS,
        document: fakeDocument(),
        localStorage: { getItem: key => saved.get(key) ?? null },
    });
    const data = app.readStorage();
    app.initFacilityTiers(data);
    app.populateHomeLevels();
    app.populateLevelUpTargets();
    app.loadInputsFromStorage(data);
    // applyConfigMode: Advanced mode's level-up target follows the RV level until one is picked.
    if (!app.isSimpleMode() && !app.levelUpTargetChosen) app.followLevelUpTarget(app.selectedHomeLevel());
    return app;
}

const TABS = { best: app => app.bestAniimoSetup(), minimum: () => 'minimum', custom: () => 'roster:' };

for (const file of FIXTURES) {
    test(`test_the_page_and_setup_input_agree_on_${file.replace(/\.json$/, '').replace(/-/g, '_')}`, () => {
        const fixture = JSON.parse(readFileSync(new URL(file, DIR), 'utf8'));
        const app = loadedPage(fixture);
        const config = app.pageConfig();
        const got = {};
        for (const [tab, key] of Object.entries(TABS)) {
            const page = plain({ ...app.getPlanInputValues(), ...app.aniimoInput(key(app)) });
            assert.deepEqual(plain(planInputFromSetup(fixture, config, { aniimoTab: tab })), page, `${file}, ${tab}`);
            got[tab] = page;
        }
        const golden = new URL(file.replace(/\.json$/, '.input.json'), DIR);
        // The golden files are the independent proof: they were written by the old code path at HEAD
        // (2b84fae), so a missing one fails unless UPDATE_GOLDEN asks for it to be written.
        if (process.env.UPDATE_GOLDEN) writeFileSync(golden, `${JSON.stringify(got, null, 2)}\n`);
        assert.ok(existsSync(golden), `${file} has no golden file; set UPDATE_GOLDEN=1 only on a trusted code path`);
        assert.deepEqual(got, JSON.parse(readFileSync(golden, 'utf8')), `${file} against its golden file`);
        assert.deepEqual(JSON.parse(JSON.stringify(fixture)), JSON.parse(readFileSync(new URL(file, DIR), 'utf8')), 'the fixture is not changed');
    });
}
