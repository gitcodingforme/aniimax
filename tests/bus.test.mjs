import assert from 'node:assert/strict';
import test from 'node:test';

import { last, on, publish } from '../web/bus.js';

test('test_publish_reaches_listeners_and_is_kept_as_the_last_value', () => {
    const seen = [];
    assert.equal(last('bus-a'), undefined);
    const off = on('bus-a', value => seen.push(value));
    assert.deepEqual(seen, [], 'nothing published yet, so nothing to replay');
    publish('bus-a', 1);
    publish('bus-a', { n: 2 });
    assert.deepEqual(seen, [1, { n: 2 }]);
    assert.deepEqual(last('bus-a'), { n: 2 });
    // Another topic is not heard.
    publish('bus-b', 'other');
    assert.equal(seen.length, 2);
    off();
});

test('test_replay_gives_the_last_value_at_once_unless_turned_off', () => {
    publish('bus-replay', null);
    const replayed = [];
    const off = on('bus-replay', value => replayed.push(value));
    assert.deepEqual(replayed, [null], 'null counts as a published value');
    const quiet = [];
    const offQuiet = on('bus-replay', value => quiet.push(value), { replay: false });
    assert.deepEqual(quiet, []);
    publish('bus-replay', 'next');
    assert.deepEqual(replayed, [null, 'next']);
    assert.deepEqual(quiet, ['next']);
    off();
    offQuiet();
});

test('test_unsubscribe_stops_only_that_listener', () => {
    const a = [];
    const b = [];
    const offA = on('bus-off', value => a.push(value));
    const fn = value => b.push(value);
    const offB1 = on('bus-off', fn);
    const offB2 = on('bus-off', fn);
    publish('bus-off', 1);
    offA();
    offB1();
    publish('bus-off', 2);
    assert.deepEqual(a, [1]);
    assert.deepEqual(b, [1, 1, 2], 'the same function listening twice is stopped one call at a time');
    offB2();
    offB2();
    publish('bus-off', 3);
    assert.deepEqual(b, [1, 1, 2]);
});

test('test_a_throwing_listener_is_logged_and_the_others_still_run', (t) => {
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args));
    const seen = [];
    const offBad = on('bus-throw', () => { throw new Error('broken card'); });
    const offGood = on('bus-throw', value => seen.push(value));
    publish('bus-throw', 'x');
    assert.deepEqual(seen, ['x']);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /bus-throw/);
    assert.equal(warnings[0][1].message, 'broken card');
    // Replay is guarded the same way.
    on('bus-throw', () => { throw new Error('on replay'); });
    assert.equal(warnings.length, 2);
    offBad();
    offGood();
});

test('test_a_listener_added_during_a_publish_waits_for_the_next_one', () => {
    const late = [];
    const offOuter = on('bus-nested', () => {
        on('bus-nested', value => late.push(value), { replay: false });
    }, { replay: false });
    publish('bus-nested', 1);
    assert.deepEqual(late, []);
    offOuter();
    publish('bus-nested', 2);
    assert.deepEqual(late, [2]);
    assert.throws(() => on('bus-nested', 'not a function'), TypeError);
});
