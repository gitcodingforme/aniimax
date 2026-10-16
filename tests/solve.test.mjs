import assert from 'node:assert/strict';
import test from 'node:test';

import { createSolver, splitIndices } from '../web/solve.js';

// A stand-in for the planner's Worker: records what it is sent and lets the test (or `behave`,
// called just after each postMessage) answer the way worker.js does.
function fakeWorkers(behave = null) {
    const made = [];
    let maxAlive = 0;
    const alive = () => made.filter(w => !w.terminated).length;
    class FakeWorker {
        constructor(url) {
            this.url = url;
            this.terminated = false;
            this.messages = [];
            made.push(this);
            maxAlive = Math.max(maxAlive, alive());
        }
        postMessage(message) {
            this.messages.push(message);
            if (behave) queueMicrotask(() => behave(this, message));
        }
        terminate() {
            this.terminated = true;
        }
        send(data) {
            if (!this.terminated) this.onmessage?.({ data });
        }
        fail(message) {
            if (!this.terminated) this.onerror?.({ message });
        }
    }
    return { made, alive, maxAlive: () => maxAlive, makeWorker: url => new FakeWorker(url) };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// Answers a rank_improvements request: the base, then each candidate as `top`.
function answerRank(worker, message, { stopAfter = Infinity, ok = true } = {}) {
    const { candidates } = JSON.parse(message.payload);
    worker.send({ id: message.id, type: 'progress', count: { index: -1, top: 100, proven: true } });
    candidates.forEach((candidate, index) => {
        if (index < stopAfter) worker.send({ id: message.id, type: 'progress', count: { index, top: candidate.top, coins: null, proven: true } });
    });
    if (stopAfter === Infinity) worker.send(ok ? { id: message.id, ok: true, result: null } : { id: message.id, ok: false, error: 'no good' });
}

test('test_split_indices_deals_candidates_out_in_order', () => {
    assert.deepEqual(splitIndices(5, 2), [[0, 2, 4], [1, 3]]);
    assert.deepEqual(splitIndices(2, 6), [[0], [1]]);
    assert.deepEqual(splitIndices(3, 1), [[0, 1, 2]]);
    assert.deepEqual(splitIndices(3, 0), [[0, 1, 2]], 'at least one list');
    assert.deepEqual(splitIndices(0, 3), []);
});

test('test_find_plan_sends_the_input_and_parses_the_plan', async () => {
    const fake = fakeWorkers((worker, message) => {
        worker.send({ id: message.id, type: 'progress', count: { step: 'final', state: 'start' } });
        worker.send({ id: message.id, type: 'progress', count: 7 });
        worker.send({ id: message.id, ok: true, result: JSON.stringify({ success: true, rate_per_second: 2 }) });
    });
    const solver = createSolver({ workerUrl: './worker.js?load=1', makeWorker: fake.makeWorker });
    const progress = [];
    const plan = await solver.findPlan({ home_level: 5 }, { onProgress: count => progress.push(count) });
    assert.deepEqual(plan, { success: true, rate_per_second: 2 });
    assert.deepEqual(progress, [{ step: 'final', state: 'start' }, 7]);
    assert.equal(fake.made.length, 1);
    const [worker] = fake.made;
    assert.equal(worker.url, './worker.js?load=1');
    assert.equal(worker.messages[0].type, 'find_plan');
    assert.deepEqual(JSON.parse(worker.messages[0].payload), { home_level: 5 });
    assert.equal(worker.terminated, true, 'a finished solve stops its worker');
});

test('test_find_plan_turns_a_planner_failure_into_a_failed_plan', async () => {
    const fake = fakeWorkers((worker, message) => {
        if (JSON.parse(message.payload).broken) worker.fail('The worker crashed');
        else worker.send({ id: message.id, ok: false, error: 'Invalid input' });
    });
    const solver = createSolver({ workerUrl: 'w', makeWorker: fake.makeWorker });
    assert.deepEqual(await solver.findPlan({}), { success: false, error: 'Invalid input' });
    assert.deepEqual(await solver.findPlan({ broken: true }), { success: false, error: 'The worker crashed' });
    assert.equal(fake.alive(), 0);
});

test('test_find_plan_times_out_or_cancels_and_stops_its_worker', async () => {
    const fake = fakeWorkers();
    const solver = createSolver({ workerUrl: 'w', makeWorker: fake.makeWorker });
    await assert.rejects(solver.findPlan({}, { timeoutMs: 15 }), { message: 'timed out' });
    assert.equal(fake.made[0].terminated, true);

    const controller = new AbortController();
    const running = solver.findPlan({}, { signal: controller.signal });
    await tick();
    controller.abort();
    await assert.rejects(running, { message: 'cancelled' });
    assert.equal(fake.made[1].terminated, true);

    // Already aborted: no worker is started at all.
    await assert.rejects(solver.findPlan({}, { signal: AbortSignal.abort() }), { message: 'cancelled' });
    assert.equal(fake.made.length, 2);
});

test('test_rank_splits_inputs_across_workers_and_maps_results_back', async () => {
    const fake = fakeWorkers((worker, message) => answerRank(worker, message));
    const solver = createSolver({ workerUrl: 'w', makeWorker: fake.makeWorker });
    const inputs = [{ top: 10 }, { top: 11 }, { top: 12 }, { top: 13 }, { top: 14 }];
    const seen = [];
    const bases = [];
    const outcome = await solver.rank('coins', { top: 1 }, inputs, {
        workers: 2, baseTop: { measure: 'coins', objective: 100 },
        onResult: (index, result) => seen.push([index, result.top]), onBase: base => bases.push(base.top),
    });
    assert.equal(fake.made.length, 2);
    const payloads = fake.made.map(w => JSON.parse(w.messages[0].payload));
    assert.deepEqual(payloads.map(p => p.candidates.map(c => c.top)), [[10, 12, 14], [11, 13]]);
    assert.deepEqual(payloads[0].base, { top: 1 });
    assert.equal(payloads[0].measure, 'coins');
    assert.deepEqual(payloads[0].baseTop, { measure: 'coins', objective: 100 });
    assert.equal(fake.made[0].messages[0].type, 'rank_improvements');
    assert.deepEqual(outcome.results.map(r => [r.index, r.top]), [[0, 10], [1, 11], [2, 12], [3, 13], [4, 14]]);
    assert.deepEqual(seen.sort((a, b) => a[0] - b[0]), [[0, 10], [1, 11], [2, 12], [3, 13], [4, 14]]);
    assert.equal(outcome.base.top, 100);
    assert.deepEqual(bases, [100], 'the base is reported once');
    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.failed, false);
    assert.equal(fake.alive(), 0);
    assert.deepEqual(await solver.rank('coins', {}, []), { base: null, results: [], timedOut: false, cancelled: false, failed: false });
});

test('test_rank_resolves_with_what_it_has_on_a_timeout_or_an_abort', async () => {
    const fake = fakeWorkers((worker, message) => {
        // The first worker answers everything; the second one answer, then nothing.
        if (worker === fake.made[0]) answerRank(worker, message);
        else answerRank(worker, message, { stopAfter: 1 });
    });
    const solver = createSolver({ workerUrl: 'w', makeWorker: fake.makeWorker });
    const inputs = [{ top: 1 }, { top: 2 }, { top: 3 }, { top: 4 }];
    const outcome = await solver.rank('coins', {}, inputs, { workers: 2, timeoutMs: 30 });
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.cancelled, false);
    assert.deepEqual(outcome.results.map(r => r && r.top), [1, 2, 3, null]);
    assert.equal(fake.alive(), 0, 'the hanging worker is stopped');

    const controller = new AbortController();
    const hanging = fakeWorkers();
    const other = createSolver({ workerUrl: 'w', makeWorker: hanging.makeWorker });
    const pending = other.rank('coins', {}, inputs, { workers: 2, signal: controller.signal });
    await tick();
    controller.abort();
    const aborted = await pending;
    assert.equal(aborted.timedOut, true);
    assert.equal(aborted.cancelled, true);
    assert.deepEqual(aborted.results, [null, null, null, null]);
    assert.equal(hanging.alive(), 0);
});

test('test_rank_marks_a_broken_worker_as_failed_without_rejecting', async (t) => {
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args));
    const fake = fakeWorkers((worker, message) => {
        if (worker === fake.made[0]) answerRank(worker, message, { ok: false });
        else worker.fail('crashed');
    });
    const solver = createSolver({ workerUrl: 'w', makeWorker: fake.makeWorker });
    const outcome = await solver.rank('level_up', {}, [{ top: 1 }, { top: 2 }], { workers: 2 });
    assert.equal(outcome.failed, true);
    assert.equal(outcome.timedOut, false);
    assert.deepEqual(outcome.results.map(r => r && r.top), [1, null]);
    assert.equal(warnings.length, 2, 'both breakages are logged');
});

test('test_the_limiter_never_runs_more_than_max_workers', async () => {
    const fake = fakeWorkers();
    const solver = createSolver({ workerUrl: 'w', makeWorker: fake.makeWorker, maxWorkers: 2 });
    const plans = [solver.findPlan({ n: 1 }), solver.findPlan({ n: 2 }), solver.findPlan({ n: 3 })];
    const ranking = solver.rank('coins', {}, [{ top: 1 }, { top: 2 }, { top: 3 }], { workers: 2 });
    await tick();
    assert.equal(fake.made.length, 2, 'the third solve and the ranking wait');
    // Finish whatever is running, one at a time, until everything is done.
    const answer = (worker) => {
        const message = worker.messages[0];
        if (message.type === 'find_plan') worker.send({ id: message.id, ok: true, result: JSON.stringify({ success: true, n: JSON.parse(message.payload).n }) });
        else answerRank(worker, message);
    };
    for (let round = 0; round < 10 && fake.made.some(w => !w.terminated); round++) {
        answer(fake.made.find(w => !w.terminated));
        await tick();
    }
    assert.deepEqual((await Promise.all(plans)).map(p => p.n), [1, 2, 3]);
    const ranked = await ranking;
    assert.deepEqual(ranked.results.map(r => r.top), [1, 2, 3]);
    assert.equal(fake.made.length, 5);
    assert.equal(fake.maxAlive(), 2);
    assert.equal(fake.alive(), 0);
});

test('test_time_helpers_share_one_worker_and_restart_it_after_an_error', async () => {
    const fake = fakeWorkers((worker, message) => {
        const goal = JSON.parse(message.payload);
        if (goal.plan.broken) {
            worker.fail('helper crashed');
            return;
        }
        const seconds = goal.seconds ?? (goal.target - goal.current) / goal.plan.rate_per_second;
        worker.send({ id: message.id, ok: true, result: JSON.stringify({ success: true, total_time_seconds: seconds }) });
    });
    const solver = createSolver({ workerUrl: 'w', makeWorker: fake.makeWorker });
    const plan = { success: true, rate_per_second: 2 };
    assert.equal((await solver.timeTo(plan, 100, 20)).total_time_seconds, 40);
    assert.equal((await solver.timeOver(plan, 3600)).total_time_seconds, 3600);
    assert.equal(fake.made.length, 1, 'one helper for both');
    const sent = fake.made[0].messages.map(m => [m.type, JSON.parse(m.payload)]);
    assert.deepEqual(sent, [
        ['time_to_reach', { plan, target: 100, current: 20 }],
        ['time_to_reach', { plan, seconds: 3600 }],
    ]);
    await assert.rejects(solver.timeTo({ broken: true }, 1, 0), { message: 'helper crashed' });
    assert.equal(fake.made[0].terminated, true);
    assert.equal((await solver.timeTo(plan, 10, 0)).total_time_seconds, 5);
    assert.equal(fake.made.length, 2, 'a new helper after the error');
});

test('test_the_time_helper_runs_beside_busy_workers_and_stops_when_idle', async () => {
    const fake = fakeWorkers((worker, message) => {
        // A plan never answers here, so it keeps the only limiter slot.
        if (message.type === 'time_to_reach') worker.send({ id: message.id, ok: true, result: JSON.stringify({ success: true }) });
    });
    const solver = createSolver({ workerUrl: 'w', makeWorker: fake.makeWorker, maxWorkers: 1, helperIdleMs: 20 });
    const controller = new AbortController();
    const busy = solver.findPlan({}, { signal: controller.signal });
    await tick();
    assert.equal(fake.alive(), 1);
    assert.deepEqual(await solver.timeOver({ success: true }, 60), { success: true }, 'no waiting behind the plan');
    assert.equal(fake.alive(), 2, 'the helper is a worker of its own');
    await solver.timeTo({ success: true }, 10, 0);
    assert.equal(fake.made.length, 2, 'one helper, kept between calls');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fake.made[1].terminated, true, 'stopped once idle');
    await solver.timeOver({ success: true }, 60);
    assert.equal(fake.made.length, 3, 'started again when asked');
    controller.abort();
    await assert.rejects(busy, { message: 'cancelled' });
});

test('test_a_time_request_can_time_out_or_be_cancelled_and_the_helper_is_replaced', async () => {
    // The helper answers only plans that are not marked `stuck`.
    const fake = fakeWorkers((worker, message) => {
        const goal = JSON.parse(message.payload);
        if (!goal.plan.stuck) worker.send({ id: message.id, ok: true, result: JSON.stringify({ success: true, seconds: goal.seconds }) });
    });
    const solver = createSolver({ workerUrl: 'w', makeWorker: fake.makeWorker });
    await assert.rejects(solver.timeOver({ stuck: true }, 1, { timeoutMs: 15 }), { message: 'timed out' });
    assert.equal(fake.made[0].terminated, true, 'the stuck helper is stopped');
    assert.deepEqual(await solver.timeOver({ success: true }, 5), { success: true, seconds: 5 });
    assert.equal(fake.made.length, 2, 'and a new one answers the next call');

    // Cancelling one request moves the others waiting on that helper to a new one.
    const controller = new AbortController();
    const stuck = solver.timeTo({ stuck: true }, 10, 0, { signal: controller.signal });
    const behind = solver.timeOver({ success: true }, 7);
    controller.abort();
    await assert.rejects(stuck, { message: 'cancelled' });
    assert.deepEqual(await behind, { success: true, seconds: 7 });
    assert.equal(fake.made[1].terminated, true);
    assert.equal(fake.made.length, 3);
    // Already aborted: nothing is sent.
    await assert.rejects(solver.timeOver({ success: true }, 1, { signal: AbortSignal.abort() }), { message: 'cancelled' });
    assert.equal(fake.made[2].messages.length, 1);
});
