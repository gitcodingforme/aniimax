import assert from 'node:assert/strict';
import test from 'node:test';

import { chips, personalBests, rvMilestones, snapshotDays, streaks, summarize } from '../web/streaks.js';

const utc = date => date.toISOString().slice(0, 10);
const snap = (id, rv, perHour) => ({
    id, setup: { facilityTiers: {} }, setupHash: 'x',
    actual: rv === undefined ? {} : { rv, coins: 100 },
    note: '', predicted: perHour === undefined ? null : { coinsPerHour: perHour },
});
const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-01T00:00:00Z');

test('test_days_group_and_sort_unique', () => {
    const list = [snap('2026-10-03T23:00:00.000Z', 1), snap('2026-10-01T01:00:00.000Z', 1), snap('2026-10-01T22:00:00.000Z', 1), { id: 'bad' }];
    assert.deepEqual(snapshotDays(list, utc), ['2026-10-01', '2026-10-03']);
    assert.deepEqual(snapshotDays(null, utc), []);
});

test('test_streak_continues_from_yesterday', () => {
    const days = ['2026-10-12', '2026-10-13', '2026-10-14'];
    assert.deepEqual(streaks(days, '2026-10-14'), { current: 3, longest: 3, lastDay: '2026-10-14' });
    assert.equal(streaks(days, '2026-10-15').current, 3);
});

test('test_streak_breaks_after_a_gap', () => {
    const days = ['2026-10-12', '2026-10-13', '2026-10-14'];
    assert.equal(streaks(days, '2026-10-16').current, 0);
    assert.equal(streaks(days, '2026-10-16').longest, 3);
    assert.deepEqual(streaks([], '2026-10-16'), { current: 0, longest: 0, lastDay: null });
});

test('test_longest_streak_is_found_across_month_ends', () => {
    const days = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-10', '2026-10-11'];
    const result = streaks(days, '2026-10-11');
    assert.equal(result.longest, 4);
    assert.equal(result.current, 2);
});

test('test_milestones_ignore_restores', () => {
    const list = [snap('2026-10-01T10:00:00Z', 3), snap('2026-10-02T10:00:00Z', 4), snap('2026-10-03T10:00:00Z', 3), snap('2026-10-04T10:00:00Z', 4), snap('2026-10-05T10:00:00Z', 5), snap('2026-10-06T10:00:00Z')];
    assert.deepEqual(rvMilestones(list, utc), [
        { rv: 3, day: '2026-10-01' }, { rv: 4, day: '2026-10-02' }, { rv: 5, day: '2026-10-05' },
    ]);
});

test('test_personal_bests_from_snapshots_and_series', () => {
    const list = [snap('2026-10-01T10:00:00Z', 3, 5000), snap('2026-10-02T10:00:00Z', 4, 9000), snap('2026-10-03T10:00:00Z', 3, 7000)];
    const series = [{ t: T0, coins: 0 }, { t: T0 + HOUR, coins: 1000 }, { t: T0 + 3 * HOUR, coins: 5000 }];
    const bests = personalBests(list, series, utc);
    assert.deepEqual(bests.predictedPerHour, { value: 9000, day: '2026-10-02' });
    assert.deepEqual(bests.highestRv, { value: 4, day: '2026-10-02' });
    assert.deepEqual(bests.actualPerHour, { value: 2000, day: '2026-10-01' });
});

test('test_no_one_hour_rising_window_gives_null', () => {
    const short = [{ t: T0, coins: 0 }, { t: T0 + 30 * 60_000, coins: 900 }];
    assert.equal(personalBests([], short, utc).actualPerHour, null);
    const falling = [{ t: T0, coins: 900 }, { t: T0 + 2 * HOUR, coins: 100 }];
    assert.equal(personalBests([], falling, utc).actualPerHour, null);
    assert.deepEqual(personalBests([], [], utc), { predictedPerHour: null, actualPerHour: null, highestRv: null });
});

test('test_chips_show_six_labels', () => {
    const empty = chips(summarize([], [], '2026-10-15', utc));
    assert.equal(empty.length, 6);
    assert.equal(empty[0].value, '0 days');
    assert.equal(empty[3].value, 'none yet');
    const full = chips(summarize([snap('2026-10-14T10:00:00Z', 4, 12345)], [], '2026-10-15', utc));
    assert.equal(full[0].value, '1 day');
    assert.equal(full[2].value, '1');
    assert.equal(full[3].value, 'RV 4 (2026-10-14)');
    assert.equal(full[4].value, '12,345 (2026-10-14)');
});
