// Small stand-ins for the browser, for tests that run page code in Node. No jsdom: just the few
// properties the feature cards (web/cards/) touch.
//
// - fakeNode(tag): a plain element. This is the helper that began in tests/coverage.test.mjs
//   (which still has its own copy), with the usual extras added: value, checked, disabled, hidden,
//   dataset, style, classList and the small methods cards call.
// - fakeContainer(tag): a fakeNode whose querySelector(sel) makes (and then remembers) a container
//   for each selector asked about, so a card can look up the pieces of the markup it just wrote
//   without anything parsing that markup. querySelectorAll always gives an empty list. Every
//   selector asked about is kept in `queried`, in order, so a test can check them afterwards.
// - memoryStorage(): a localStorage on a Map. blockedStorage(): a global that throws when read, as
//   a browser does in a private window or with site data blocked.
// - installGlobals({ name: value }): sets globals for one test and returns the function that
//   puts them back exactly as they were.

export function fakeNode(tag = 'div') {
    const classes = new Set();
    const node = {
        tag, children: [], listeners: {}, attributes: {}, open: false, textContent: '', id: '', className: '', type: '',
        value: '', checked: false, disabled: false, hidden: false, dataset: {}, style: {},
        _html: '',
        get innerHTML() { return this._html; },
        set innerHTML(v) { this._html = v; this.children = []; },
        appendChild(child) { this.children.push(child); return child; },
        setAttribute(k, v) { this.attributes[k] = v; },
        getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
        hasAttribute(k) { return k in this.attributes; },
        removeAttribute(k) { delete this.attributes[k]; },
        // The last listener of a type wins here (`listeners[type]`); `added` has every one in order.
        added: [],
        addEventListener(type, fn) { this.listeners[type] = fn; this.added.push([type, fn]); },
        removeEventListener(type, fn) { if (this.listeners[type] === fn) delete this.listeners[type]; },
        classList: {
            add: (...names) => names.forEach(n => classes.add(n)),
            remove: (...names) => names.forEach(n => classes.delete(n)),
            toggle: (name, force) => {
                const on = force === undefined ? !classes.has(name) : !!force;
                if (on) classes.add(name); else classes.delete(name);
                return on;
            },
            contains: name => classes.has(name),
        },
        focus() {},
        remove() {},
        closest() { return null; },
    };
    return node;
}

export function fakeContainer(tag = 'div') {
    const node = fakeNode(tag);
    const found = new Map();
    node.queried = [];
    node.found = found; // selector -> the container handed out for it
    node.querySelector = (selector) => {
        node.queried.push(selector);
        if (!found.has(selector)) found.set(selector, fakeContainer());
        return found.get(selector);
    };
    node.querySelectorAll = (selector) => {
        node.queried.push(selector);
        return [];
    };
    return node;
}

const blocked = () => {
    const error = new Error('The operation is insecure.');
    error.name = 'SecurityError';
    return error;
};

// A localStorage kept in a Map. Values are stored as text, as the real one does.
export function memoryStorage(initial = {}) {
    const map = new Map(Object.entries(initial).map(([k, v]) => [k, String(v)]));
    return {
        get length() { return map.size; },
        key: index => [...map.keys()][index] ?? null,
        getItem: key => (map.has(String(key)) ? map.get(String(key)) : null),
        setItem: (key, value) => { map.set(String(key), String(value)); },
        removeItem: (key) => { map.delete(String(key)); },
        clear: () => map.clear(),
        // For tests: what is stored now.
        dump: () => Object.fromEntries(map),
    };
}

// Marks a value for installGlobals as "run this function every time the global is read".
const GETTER = Symbol('global getter');
export const globalGetter = fn => ({ [GETTER]: fn });

// Reading the global itself throws, as in a browser with site data blocked. Install it with
// installGlobals({ localStorage: blockedStorage() }).
export function blockedStorage() {
    return globalGetter(() => { throw blocked(); });
}

// Sets each named global (a plain value, or a globalGetter) and returns a function that restores
// whatever was there before, including "nothing".
export function installGlobals(values) {
    const before = new Map();
    for (const [name, value] of Object.entries(values)) {
        before.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        const descriptor = value && typeof value === 'object' && GETTER in value
            ? { get: value[GETTER], configurable: true }
            : { value, writable: true, configurable: true };
        Object.defineProperty(globalThis, name, descriptor);
    }
    return () => {
        for (const [name, descriptor] of before) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    };
}

// The page's `document` as far as the cards go: createElement makes fake nodes.
export function fakeDocument() {
    return {
        createElement: tag => fakeNode(tag),
        head: fakeNode('head'),
        body: fakeNode('body'),
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
    };
}
