import assert from 'node:assert/strict';
import test from 'node:test';

import { PROFILE_VERSION, buildProfile, parseProfile, profileFilename, summarizeProfile } from '../web/profile.js';

const setup = {
    facilityTiers: { Farmland: [{ count: 4, level: 2 }, { count: 2, level: 1 }], Mine: [{ count: 1, level: 3 }] },
    levelUpStock: { wood_block: 40 },
    skippedRecipes: ['quick_potato'],
    unlockedSpecial: [],
    priorities: [{ target: 'coins', on: true }],
    aniimoLevels: {},
    roster: [{ name: 'Тёплый Анимо 🌾', count: 2, abilities: { Gathering: 3 }, personalities: [] }],
    'home-level': '7',
    'mode-simple': false,
};

test('test_profile_round_trips_through_json', () => {
    const profile = buildProfile({
        setup,
        note: 'after RV 7 upgrade',
        site: { appVersion: '0.17.1', dataVersion: 'ae-bii@174655c 2026-10-11' },
        toolkits: ['quick_potato', 'quick_potato', ''],
        actual: { rv: 7, coins: 123456, stock: { wood_block: 40, bad: -1 } },
        savedAt: '2026-10-14T19:05:12.000Z',
    });
    assert.equal(profile.format, 'aniimax-profile');
    assert.equal(profile.version, PROFILE_VERSION);
    assert.equal(profile.savedAt, '2026-10-14T19:05:12.000Z');
    assert.deepEqual(profile.toolkits, ['quick_potato']);
    assert.deepEqual(profile.actual, { rv: 7, coins: 123456, stock: { wood_block: 40 } });
    assert.deepEqual(parseProfile(JSON.stringify(profile, null, 2)), profile);
    assert.deepEqual(parseProfile(JSON.stringify(profile)).setup, setup);
});

test('test_profile_cleans_optional_fields', () => {
    const profile = buildProfile({ setup, note: 'x'.repeat(600), toolkits: 'nope', actual: { rv: 0, coins: 'many' }, savedAt: 'not a date' });
    assert.equal(profile.note.length, 500);
    assert.equal(profile.savedAt, '');
    assert.deepEqual(profile.toolkits, []);
    assert.deepEqual(profile.actual, {});
    assert.deepEqual(profile.site, { appVersion: '', dataVersion: '' });
    assert.ok(buildProfile({ setup }).savedAt.endsWith('Z'));
    assert.equal(parseProfile(JSON.stringify({ format: 'aniimax-profile', version: 1, setup })).savedAt, '');
});

test('test_profile_rejects_files_that_are_not_profiles', () => {
    assert.throws(() => buildProfile({}), /no homeland setup/);
    assert.throws(() => buildProfile({ setup: { facilityTiers: [] } }), /no homeland setup/);
    assert.throws(() => parseProfile('{not json'), /not valid JSON/);
    assert.throws(() => parseProfile('[]'), /not an Aniimax profile/);
    assert.throws(() => parseProfile(JSON.stringify(setup)), /not an Aniimax profile/);
    assert.throws(() => parseProfile(JSON.stringify({ format: 'aniimax-profile', version: 0, setup })), /version number/);
    assert.throws(() => parseProfile(JSON.stringify({ format: 'aniimax-profile', version: '1', setup })), /version number/);
    assert.throws(() => parseProfile(JSON.stringify({ format: 'aniimax-profile', version: 99, setup })), /version 99/);
    assert.throws(() => parseProfile(JSON.stringify({ format: 'aniimax-profile', version: 1 })), /no homeland setup/);
    assert.throws(() => parseProfile(JSON.stringify({ format: 'aniimax-profile', version: 1, setup: { facilityTiers: 'x' } })), /no homeland setup/);
    assert.throws(() => parseProfile('x'.repeat(2_000_001)), /too large/);
});

test('test_profile_filename_matches_the_gitignored_pattern', () => {
    const name = profileFilename(new Date(2026, 9, 14, 19, 5));
    assert.equal(name, 'aniimax-2026-10-14_1905.profile.json');
    assert.match(profileFilename('garbage', new Date(2026, 0, 2, 3, 4)), /^aniimax-2026-01-02_0304\.profile\.json$/);
});

test('test_profile_summary_counts_facilities_and_aniimo', () => {
    const profile = buildProfile({ setup, actual: { rv: 7 } });
    assert.deepEqual(summarizeProfile(profile), { rv: 7, facilities: 7, aniimo: 2 });
    const bare = buildProfile({ setup: { facilityTiers: { Farmland: 'odd' }, 'home-level': '3' } });
    assert.deepEqual(summarizeProfile(bare), { rv: 3, facilities: 0, aniimo: 0 });
});
