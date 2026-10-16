// Side solves for feature cards: the planner (worker.js) in workers of their own, so a card never
// touches app.js's worker or its Calculate run. No imports, no DOM; the Worker class is injected
// (`makeWorker`), so tests/solve.test.mjs runs it all with a fake one.
//
// Worker messages (see worker.js): the page posts `{ id, type, payload }` with `payload` a JSON
// string; the worker answers with any number of `{ id, type: 'progress', count }` and then one
// `{ id, ok, result | error }`, where `result` is a JSON string.
//
// Every plan and ranking worker this solver starts goes through one limiter, so no more than
// `maxWorkers` of them are alive at once; extra work waits its turn. Each solve's `timeoutMs`
// counts from when its worker starts, not from when it was queued. The time_to_reach helper is
// one extra worker outside the limiter (so a goal time never waits behind a ranking), stopped
// after `helperIdleMs` with nothing to do.

// The candidates dealt out across `n` workers, each list keeping the candidates' order:
// splitIndices(5, 2) -> [[0, 2, 4], [1, 3]]. Never more lists than candidates; none for none.
export function splitIndices(count, n) {
    const total = Math.max(0, Math.floor(Number(count) || 0));
    if (total === 0) return [];
    const lists = Math.max(1, Math.min(total, Math.floor(Number(n) || 1)));
    const shares = Array.from({ length: lists }, () => []);
    for (let i = 0; i < total; i++) shares[i % lists].push(i);
    return shares;
}

const cancelledError = () => new Error('cancelled');
const timedOutError = () => new Error('timed out');

// A timeout of `ms` (a positive number; anything else means none). Returns its id or null.
function startTimer(ms, fn) {
    const delay = Number(ms);
    if (!(delay > 0)) return null;
    return setTimeout(fn, Math.min(delay, 2 ** 31 - 1));
}

function stop(worker) {
    try {
        worker?.terminate();
    } catch (_) { /* already gone */ }
}

// Hands out at most `max` slots. `acquire(signal)` resolves with a `release` function once a slot
// is free (or rejects with 'cancelled' if `signal` aborts while it waits).
function createLimiter(max) {
    let live = 0;
    const queue = [];
    const pump = () => {
        while (live < max && queue.length > 0) {
            live++;
            queue.shift().grant();
        }
    };
    const acquire = (signal) => new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(cancelledError());
            return;
        }
        const onAbort = () => {
            const at = queue.indexOf(entry);
            if (at >= 0) {
                queue.splice(at, 1);
                reject(cancelledError());
            }
        };
        const entry = {
            grant: () => {
                signal?.removeEventListener('abort', onAbort);
                let released = false;
                resolve(() => {
                    if (released) return;
                    released = true;
                    live--;
                    pump();
                });
            },
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        queue.push(entry);
        pump();
    });
    return { acquire };
}

export function createSolver({
    workerUrl, makeWorker = url => new Worker(url, { type: 'module' }), maxWorkers = 2, helperIdleMs = 60000,
} = {}) {
    const max = Math.max(1, Math.floor(Number(maxWorkers) || 1));
    const limiter = createLimiter(max);

    // One plan, in a worker of its own that is stopped when the plan is in, on a timeout or on
    // an abort. Resolves with the plan, or `{ success: false, error }` when the planner fails
    // (as app.js's ensurePlanFor does); rejects with Error('timed out') or Error('cancelled').
    async function findPlan(input, { onProgress, timeoutMs = 180000, signal } = {}) {
        const release = await limiter.acquire(signal);
        return new Promise((resolve, reject) => {
            let worker = null;
            let timer = null;
            let settled = false;
            const finish = (settle, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                stop(worker);
                release();
                settle(value);
            };
            const onAbort = () => finish(reject, cancelledError());
            if (signal?.aborted) {
                onAbort();
                return;
            }
            try {
                worker = makeWorker(workerUrl);
            } catch (error) {
                finish(reject, error);
                return;
            }
            signal?.addEventListener('abort', onAbort, { once: true });
            timer = startTimer(timeoutMs, () => finish(reject, timedOutError()));
            worker.onmessage = (event) => {
                const { type, count, ok, result, error } = event.data || {};
                if (type === 'progress') {
                    if (onProgress) {
                        try {
                            onProgress(count);
                        } catch (e) {
                            console.warn('A plan progress listener failed:', e);
                        }
                    }
                    return;
                }
                if (!ok) {
                    finish(resolve, { success: false, error: error || 'The planner failed' });
                    return;
                }
                let plan;
                try {
                    plan = JSON.parse(result);
                } catch (e) {
                    plan = { success: false, error: `The planner's answer could not be read: ${e.message}` };
                }
                finish(resolve, plan);
            };
            worker.onerror = (event) => finish(resolve, { success: false, error: event?.message || 'The planner stopped' });
            worker.postMessage({ id: 1, type: 'find_plan', payload: typeof input === 'string' ? input : JSON.stringify(input) });
        });
    }

    // Ranks `inputs` (plan inputs) against `base` by `measure` ('coins', 'level_up' or a priority
    // target), split across up to `workers` workers as app.js's rankImprovementsFor does. Each
    // answer `{ index, top, coins, proven }` goes to `onResult(index, result)` as it arrives and
    // into `results[index]` (null where none came); the base's own answer goes to `onBase(base)`.
    // `baseTop` is the plan's `measure_top`, which spares each worker solving the base again.
    // Never rejects: on a timeout or an abort the workers are stopped and it resolves with what it
    // has and `timedOut: true` (`cancelled: true` as well for an abort); `failed` is true when a
    // worker broke.
    function rank(measure, base, inputs, { onResult, onBase, baseTop, workers = 2, timeoutMs = 300000, signal } = {}) {
        return new Promise((resolve) => {
            const list = Array.isArray(inputs) ? inputs : [];
            const outcome = { base: null, results: list.map(() => null), timedOut: false, cancelled: false, failed: false };
            const shares = splitIndices(list.length, workers);
            if (shares.length === 0) {
                resolve(outcome);
                return;
            }
            // Aborted when the ranking ends, so shares still waiting for a slot leave the queue.
            const local = new AbortController();
            const running = new Set();
            let open = shares.length;
            let settled = false;
            let timer = null;
            let timerStarted = false;
            const end = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                running.forEach(share => share.finish(false));
                local.abort();
                resolve(outcome);
            };
            const onAbort = () => {
                outcome.timedOut = true;
                outcome.cancelled = true;
                end();
            };
            if (signal?.aborted) {
                onAbort();
                return;
            }
            signal?.addEventListener('abort', onAbort, { once: true });
            const shareDone = (failed) => {
                if (failed) outcome.failed = true;
                if (--open === 0) end();
            };
            const start = (indices, release) => {
                let worker;
                try {
                    worker = makeWorker(workerUrl);
                } catch (error) {
                    console.warn('Could not start a ranking worker:', error);
                    release();
                    shareDone(true);
                    return;
                }
                const share = {
                    done: false,
                    // `counted` is false when the whole ranking is ending anyway.
                    finish: (failed, counted = true) => {
                        if (share.done) return;
                        share.done = true;
                        running.delete(share);
                        stop(worker);
                        release();
                        if (counted && !settled) shareDone(failed);
                    },
                };
                running.add(share);
                worker.onmessage = (event) => {
                    if (settled || share.done) return;
                    const { type, count, ok, error } = event.data || {};
                    if (type === 'progress') {
                        if (!count || typeof count !== 'object') return;
                        if (count.index === -1) {
                            if (!outcome.base) {
                                outcome.base = count;
                                if (onBase) {
                                    try {
                                        onBase(count);
                                    } catch (e) {
                                        console.warn('A ranking listener failed:', e);
                                    }
                                }
                            }
                            return;
                        }
                        const index = indices[count.index];
                        if (index === undefined) return;
                        const result = { ...count, index };
                        outcome.results[index] = result;
                        if (onResult) {
                            try {
                                onResult(index, result);
                            } catch (e) {
                                console.warn('A ranking listener failed:', e);
                            }
                        }
                        return;
                    }
                    if (!ok) console.warn('Ranking failed:', error);
                    share.finish(!ok);
                };
                worker.onerror = (event) => {
                    if (settled || share.done) return;
                    console.warn('Ranking failed:', event?.message || event);
                    share.finish(true);
                };
                worker.postMessage({
                    id: 1,
                    type: 'rank_improvements',
                    payload: JSON.stringify({ measure, base, candidates: indices.map(i => list[i]), baseTop }),
                });
            };
            shares.forEach((indices) => {
                limiter.acquire(local.signal).then((release) => {
                    if (settled) {
                        release();
                        return;
                    }
                    // The clock starts with the first worker, not while the ranking waits its turn.
                    if (!timerStarted) {
                        timerStarted = true;
                        timer = startTimer(timeoutMs, () => {
                            outcome.timedOut = true;
                            end();
                        });
                    }
                    start(indices, release);
                }, () => { /* the ranking ended while this share waited */ });
            });
        });
    }

    // --- time_to_reach, on one helper worker of its own ---------------------------------------
    // Outside the limiter: one extra worker at most, kept between calls and stopped after
    // `helperIdleMs` with nothing to do. The next call starts a new one, as it does after an error.
    let helper = null;
    let nextId = 0;

    function dropHelper(h, error) {
        if (helper !== h) return;
        helper = null;
        clearTimeout(h.idleTimer);
        stop(h.worker);
        h.pending.forEach(p => p.reject(error));
        h.pending.clear();
    }

    // Starts the idle clock once nothing is waiting on the helper. The timer never keeps Node (the
    // tests) running on its own.
    function whenIdle(h) {
        if (helper !== h || h.pending.size > 0) return;
        clearTimeout(h.idleTimer);
        h.idleTimer = startTimer(helperIdleMs, () => dropHelper(h, cancelledError()));
        h.idleTimer?.unref?.();
    }

    function helperWorker() {
        if (helper) return helper;
        const worker = makeWorker(workerUrl);
        const h = { worker, pending: new Map(), idleTimer: null };
        worker.onmessage = (event) => {
            const { id, type, ok, result, error } = event.data || {};
            if (type === 'progress') return;
            const p = h.pending.get(id);
            if (!p) return;
            h.pending.delete(id);
            if (!ok) {
                p.reject(new Error(error || 'The planner failed'));
            } else {
                try {
                    p.resolve(JSON.parse(result));
                } catch (e) {
                    p.reject(e);
                }
            }
            whenIdle(h);
        };
        // A broken helper is dropped; the next call starts a new one.
        worker.onerror = (event) => dropHelper(h, new Error(event?.message || 'The planner stopped'));
        helper = h;
        return h;
    }

    function callHelper(goal) {
        return new Promise((resolve, reject) => {
            let h;
            try {
                h = helperWorker();
            } catch (error) {
                reject(error);
                return;
            }
            clearTimeout(h.idleTimer);
            h.idleTimer = null;
            const id = ++nextId;
            h.pending.set(id, { resolve, reject });
            h.worker.postMessage({ id, type: 'time_to_reach', payload: JSON.stringify(goal) });
        });
    }

    // What `plan` makes in `seconds`: time_to_reach's goal result (see JsGoalResult in wasm.rs).
    function timeOver(plan, seconds) {
        return callHelper({ plan, seconds });
    }

    // How long `plan` takes from `current` to `target` Home Coins: time_to_reach's goal result,
    // with `total_time_seconds` (see JsGoalResult in wasm.rs).
    function timeTo(plan, target, current = 0) {
        return callHelper({ plan, target, current });
    }

    return { findPlan, rank, timeOver, timeTo };
}
