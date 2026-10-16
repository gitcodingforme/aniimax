// H-d and H-e: the page's ranking runs through solve.js in the background behind the cards'
// requests, and the page's main worker sits behind createChannel, which restarts a broken or silent
// worker and rejects what was waiting on it.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createChannel, createSolver, splitIndices } from '../web/solve.js';

// A stand-in for the planner's Worker (as in solve.test.mjs).
function fakeWorkers(behave = null) {
    const made = [];
    class FakeWorker {
        constructor(url) {
            this.url = url;
            this.terminated = false;
            this.messages = [];
            made.push(this);
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
    return { made, alive: () => made.filter(w => !w.terminated), makeWorker: url => new FakeWorker(url) };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function answer(worker) {
    const message = worker.messages[0];
    if (message.type === 'find_plan') {
        worker.send({ id: message.id, ok: true, result: JSON.stringify({ success: true, n: JSON.parse(message.payload).n }) });
        return;
    }
    const { candidates } = JSON.parse(message.payload);
    worker.send({ id: message.id, type: 'progress', count: { index: -1, top: 1 } });
    candidates.forEach((c, index) => worker.send({ id: message.id, type: 'progress', count: { index, top: c.top } }));
    worker.send({ id: message.id, ok: true, result: null });
}

test('test_background_ranking_shares_wait_behind_a_cards_request', async () => {
    const fake = fakeWorkers();
    const solver = createSolver({ workerUrl: 'w', makeWorker: fake.makeWorker, maxWorkers: 1 });
    const inputs = Array.from({ length: 13 }, (_, i) => ({ top: i + 2 }));
    const ranking = solver.rank('coins', {}, inputs, { workers: Math.ceil(inputs.length / 6), background: true, timeoutMs: 0 });
    await tick();
    assert.equal(fake.made.length, 1, 'one slot: the first share runs');
    const plan = solver.findPlan({ n: 7 });
    await tick();
    answer(fake.made[0]);
    await tick();
    assert.equal(fake.made.length, 2);
    assert.equal(fake.made[1].messages[0].type, 'find_plan', "the card's plan goes ahead of the remaining shares");
    answer(fake.made[1]);
    assert.equal((await plan).n, 7);
    for (let round = 0; round < 5 && fake.alive().length; round++) {
        answer(fake.alive()[0]);
        await tick();
    }
    const outcome = await ranking;
    assert.deepEqual(outcome.results.map(r => r.top), inputs.map(i => i.top));
    assert.equal(outcome.timedOut, false, 'timeoutMs 0 is no timeout');
    assert.deepEqual(fake.made.slice(2).concat(fake.made[0]).map(w => JSON.parse(w.messages[0].payload).candidates.length).sort(), [4, 4, 5]);
});

test('test_the_pages_share_size_keeps_each_worker_to_six_changes', () => {
    for (let n = 1; n <= 60; n++) {
        const shares = splitIndices(n, Math.ceil(n / 6));
        assert.ok(shares.every(s => s.length <= 6 && s.length > 0), `n=${n}`);
        assert.equal(shares.flat().length, n);
    }
});

test('test_an_aborted_background_ranking_leaves_the_queue', async () => {
    const fake = fakeWorkers();
    const solver = createSolver({ workerUrl: 'w', makeWorker: fake.makeWorker, maxWorkers: 1 });
    const blocker = solver.findPlan({ n: 1 });
    const controller = new AbortController();
    const ranking = solver.rank('coins', {}, [{ top: 1 }, { top: 2 }], { workers: 2, background: true, timeoutMs: 0, signal: controller.signal });
    await tick();
    controller.abort();
    const outcome = await ranking;
    assert.equal(outcome.cancelled, true);
    answer(fake.made[0]);
    assert.equal((await blocker).n, 1);
    await tick();
    assert.equal(fake.made.length, 1, 'no ranking worker started after the abort');
});

test('test_the_page_ranks_in_the_background_after_paint_and_caches_only_a_full_ranking', async () => {
    const { appFunctions } = await import('./helpers/app-source.mjs');
    const { measureFor } = await import('../web/shared.js');
    const calls = [];
    const steps = [];
    const frames = [];
    const sideSolver = {
        rank: (measure, base, inputs, options) => new Promise(resolve => calls.push({ measure, base, inputs, options, resolve })),
    };
    const candidates = Array.from({ length: 13 }, (_, i) => ({ kind: 'Recipes', label: `c${i}`, input: { n: i } }));
    const app = appFunctions(['rankAbort', 'rankingsBySetup', 'ranking', 'stopRanking', 'rankImprovementsFor'], {
        lastPlanInput: { priorities: [] },
        planContext: { simple: true },
        planRunId: 1,
        plansBySetup: { 'best:': { measure_top: { measure: 'coins', objective: 5 } } },
        aniimoInput: () => ({ aniimo: 'best' }),
        measureFor,
        improvementCandidates: () => candidates,
        renderImprovements: () => {},
        setStep: (...args) => steps.push(args),
        requestAnimationFrame: fn => frames.push(fn),
        setTimeout: fn => fn(),
        AbortController,
        sideSolver,
        document: { hidden: false },
    });

    app.rankImprovementsFor('best:');
    assert.equal(calls.length, 0, 'nothing starts before the plan has painted');
    frames.shift()();
    assert.equal(calls.length, 1);
    const [{ options, inputs }] = calls;
    assert.deepEqual(inputs.map(i => i.n), candidates.map(c => c.input.n));
    assert.equal(options.workers, 3);
    assert.equal(options.background, true);
    assert.equal(options.timeoutMs, 0);
    assert.deepEqual(options.baseTop, { measure: 'coins', objective: 5 });
    options.onBase({ index: -1, top: 1 });
    options.onResult(4, { index: 4, top: 2 });
    assert.equal(app.ranking.results[4].top, 2);
    assert.deepEqual(steps.at(-1), ['improve', 'start', '1 of 13']);

    // A failed ranking is shown but not kept.
    calls[0].resolve({ failed: true, cancelled: false, timedOut: false });
    await tick();
    assert.equal(app.ranking.done, true);
    assert.equal(app.rankingsBySetup['best:'], undefined);
    assert.equal(steps.at(-1)[1], 'fail');

    // A newer plan stops the one running: its signal aborts and its late answer changes nothing.
    app.rankImprovementsFor('best:');
    frames.shift()();
    const running = calls[1];
    app.stopRanking();
    assert.equal(running.options.signal.aborted, true);
    running.resolve({ failed: false, cancelled: true, timedOut: true });
    await tick();
    assert.equal(app.rankingsBySetup['best:'], undefined);

    // A full ranking is kept, so switching back to the setup shows it at once.
    app.rankImprovementsFor('best:');
    frames.shift()();
    calls[2].resolve({ failed: false, cancelled: false, timedOut: false });
    await tick();
    assert.equal(app.rankingsBySetup['best:'], app.ranking);
    app.rankImprovementsFor('best:');
    assert.equal(calls.length, 3, 'a kept ranking is not worked out again');
    assert.equal(frames.length, 0);
});

test('test_the_channel_answers_by_id_and_passes_progress_on', async () => {
    const fake = fakeWorkers();
    const channel = createChannel({ workerUrl: 'w', makeWorker: fake.makeWorker });
    assert.equal(fake.made.length, 0, 'no worker until the first call');
    const progress = [];
    const a = channel.call('find_plan', '{}', count => progress.push(count));
    const b = channel.call('get_version');
    assert.equal(fake.made.length, 1);
    assert.equal(channel.pending(), 2);
    const [first, second] = fake.made[0].messages;
    assert.deepEqual(second, { id: second.id, type: 'get_version', payload: undefined });
    fake.made[0].send({ id: first.id, type: 'progress', count: 3 });
    fake.made[0].send({ id: second.id, ok: true, result: '1.0' });
    fake.made[0].send({ id: first.id, ok: false, error: 'no plan' });
    assert.equal(await b, '1.0');
    await assert.rejects(a, /no plan/);
    assert.deepEqual(progress, [3]);
    assert.equal(channel.pending(), 0);
});

test('test_a_broken_worker_rejects_its_requests_and_is_replaced_up_to_the_cap', async (t) => {
    t.mock.method(console, 'error', () => {});
    const fake = fakeWorkers();
    const channel = createChannel({ workerUrl: 'w', makeWorker: fake.makeWorker, maxRestarts: 2 });
    for (let round = 0; round < 3; round++) {
        const call = channel.call('get_version');
        fake.made.at(-1).fail('crashed');
        await assert.rejects(call, /crashed/);
        assert.equal(fake.made.at(-1).terminated, true);
    }
    assert.equal(fake.made.length, 3, 'the first worker and two replacements');
    await assert.rejects(channel.call('get_version'), /stopped 3 times/);
    assert.equal(fake.made.length, 3, 'no fourth worker');
    channel.restart();
    const again = channel.call('get_version');
    assert.equal(fake.made.length, 4, 'restart() lets it try again');
    fake.made[3].send({ id: fake.made[3].messages[0].id, ok: true, result: 'ok' });
    assert.equal(await again, 'ok');
});

test('test_an_answer_resets_the_restart_count', async (t) => {
    t.mock.method(console, 'error', () => {});
    const fake = fakeWorkers();
    const channel = createChannel({ workerUrl: 'w', makeWorker: fake.makeWorker, maxRestarts: 1 });
    for (let round = 0; round < 3; round++) {
        const failing = channel.call('get_version');
        fake.made.at(-1).fail('crashed');
        await assert.rejects(failing, /crashed/);
        const ok = channel.call('get_version');
        const w = fake.made.at(-1);
        w.send({ id: w.messages.at(-1).id, ok: true, result: 'fine' });
        assert.equal(await ok, 'fine');
    }
});

test('test_a_silent_worker_is_restarted_but_any_message_resets_the_clock', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fake = fakeWorkers();
    const channel = createChannel({ workerUrl: 'w', makeWorker: fake.makeWorker, silenceMs: 1000 });
    const call = channel.call('find_plan', '{}');
    const w = fake.made[0];
    const id = w.messages[0].id;
    t.mock.timers.tick(900);
    w.send({ id, type: 'progress', count: { step: 'final', state: 'start' } });
    t.mock.timers.tick(900);
    assert.equal(channel.pending(), 1, 'still working: it spoke 900 ms ago');
    t.mock.timers.tick(200);
    await assert.rejects(call, /stopped answering/);
    assert.equal(w.terminated, true);
    assert.equal(channel.pending(), 0);
    // Nothing waiting: no clock runs, and the next call gets a new worker.
    t.mock.timers.tick(5000);
    channel.call('get_version');
    assert.equal(fake.made.length, 2);
});

test('test_restart_rejects_what_was_waiting_and_ignores_the_old_workers_late_answers', async () => {
    const fake = fakeWorkers();
    const channel = createChannel({ workerUrl: 'w', makeWorker: fake.makeWorker });
    const old = channel.call('find_plan', '{}');
    const w = fake.made[0];
    channel.restart(new Error('Cancelled by a newer calculation'));
    await assert.rejects(old, /newer calculation/);
    assert.equal(w.terminated, true);
    const fresh = channel.call('find_plan', '{}');
    w.onmessage?.({ data: { id: w.messages[0].id, ok: true, result: 'late' } });
    const next = fake.made[1];
    next.send({ id: next.messages[0].id, ok: true, result: 'new' });
    assert.equal(await fresh, 'new');
});

test('test_background_ranking_leaves_one_slot_free_for_a_card_click', async () => {
    const fake = fakeWorkers();
    const solver = createSolver({ workerUrl: 'w', makeWorker: fake.makeWorker, maxWorkers: 2 });
    const inputs = Array.from({ length: 18 }, (_, i) => ({ top: i + 2 }));
    const ranking = solver.rank('coins', {}, inputs, { workers: 3, background: true, timeoutMs: 0 });
    await tick();
    assert.equal(fake.alive().length, 1, 'background shares hold at most maxWorkers - 1 slots');
    const plan = solver.findPlan({ n: 9 });
    await tick();
    assert.equal(fake.alive().length, 2, 'the card click starts at once');
    answer(fake.made[1]);
    assert.equal((await plan).n, 9);
    for (let round = 0; round < 6 && fake.alive().length; round++) {
        assert.ok(fake.alive().length <= 1);
        answer(fake.alive()[0]);
        await tick();
    }
    assert.deepEqual((await ranking).results.map(r => r.top), inputs.map(i => i.top));
});

test('test_an_error_answer_also_resets_the_restart_count', async (t) => {
    t.mock.method(console, 'error', () => {});
    const fake = fakeWorkers();
    const channel = createChannel({ workerUrl: 'w', makeWorker: fake.makeWorker, maxRestarts: 1 });
    for (let round = 0; round < 3; round++) {
        const failing = channel.call('get_version');
        fake.made.at(-1).fail('crashed');
        await assert.rejects(failing, /crashed/);
        const refused = channel.call('find_plan', '{}');
        const w = fake.made.at(-1);
        w.send({ id: w.messages.at(-1).id, ok: false, error: 'no plan' });
        await assert.rejects(refused, /no plan/);
    }
    assert.equal(fake.made.length, 4, 'each crash was replaced: the error answers kept the count at zero');
});

test('test_a_hidden_tab_starts_the_ranking_without_waiting_for_a_paint', async () => {
    const { appFunctions } = await import('./helpers/app-source.mjs');
    const { measureFor } = await import('../web/shared.js');
    const calls = [];
    const app = appFunctions(['rankAbort', 'rankingsBySetup', 'ranking', 'stopRanking', 'rankImprovementsFor'], {
        lastPlanInput: { priorities: [] }, planContext: { simple: true }, planRunId: 1, plansBySetup: {},
        aniimoInput: () => ({}), measureFor, improvementCandidates: () => [{ kind: 'Recipes', label: 'x', input: {} }],
        renderImprovements: () => {}, setStep: () => {}, AbortController,
        requestAnimationFrame: () => assert.fail('a hidden tab never paints'),
        setTimeout: fn => fn(),
        document: { hidden: true },
        sideSolver: { rank: (...args) => new Promise(() => calls.push(args)) },
    });
    app.rankImprovementsFor('best:');
    assert.equal(calls.length, 1);
});
