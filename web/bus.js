// A tiny publish/subscribe bus, so feature cards (web/cards/) can follow the page's state without
// app.js knowing about them. app.js publishes; cards listen. No imports, no DOM; tested in
// tests/bus.test.mjs.
//
// Topics app.js publishes (see docs/plans/card-contract.md):
// - 'plan': the plan on screen, `{ plan, input, setup, tab, context, setupHash, solvedAt }`, or
//   null when there is none (before the first solve, or after a failed one).
// - 'history': the list of saved snapshots, each time it is written (see history.js).
// - 'timers': the running reminders, or null when there are none (see reminders.js).
// Values are shared, not copied: a listener must not change what it is given.

const values = new Map();
const listeners = new Map();

// Calls one listener; one that throws is logged and the others still run. An async listener's
// rejection is logged the same way, instead of surfacing as an unhandled rejection.
function deliver(topic, fn, value) {
    const warn = error => console.warn(`A listener for "${topic}" failed:`, error);
    try {
        const result = fn(value);
        if (result && typeof result.then === 'function') result.then(undefined, warn);
    } catch (error) {
        warn(error);
    }
}

// Sends `value` to everyone listening on `topic`, and keeps it as that topic's latest value.
export function publish(topic, value) {
    values.set(topic, value);
    const entries = listeners.get(topic);
    if (!entries) return;
    // A copy, so a listener that subscribes or unsubscribes during the call does not upset the loop.
    for (const entry of [...entries]) {
        if (entries.has(entry)) deliver(topic, entry.fn, value);
    }
}

// Calls `fn(value)` on every later publish to `topic`. With `replay` (the default), also calls it
// right away with the latest value, if anything was published on that topic yet (null counts).
// Returns a function that stops the calls.
export function on(topic, fn, { replay = true } = {}) {
    if (typeof fn !== 'function') throw new TypeError('on() needs a listener function');
    let entries = listeners.get(topic);
    if (!entries) {
        entries = new Set();
        listeners.set(topic, entries);
    }
    // One entry per call, so the same function can listen twice and stop each one on its own.
    const entry = { fn };
    entries.add(entry);
    if (replay && values.has(topic)) deliver(topic, fn, values.get(topic));
    return () => {
        entries.delete(entry);
    };
}

// The latest value published on `topic`, or undefined if nothing was yet.
export function last(topic) {
    return values.get(topic);
}
