// Pieces of web/app.js, run on their own in a vm, so a test can check one function of the page
// without a browser (app.js itself starts the whole page when imported). The same idea as
// tests/locale.test.mjs, which slices the language-change listener out of the file.
//
// A top-level declaration runs from its first line (`function name(`, `async function name(`,
// `const name =`, `let name =`) to the next line that starts with a letter at column 0, which in
// app.js is always the next declaration or top-level statement (comments, closing braces and
// indented lines never start with one).
//
// appFunctions(names, globals) runs the named declarations together in a fresh vm context whose
// globals are `globals` (what the declarations call but are not extracted: stubs, imports such as
// FACILITIES, a fake `document`). It returns an object with a getter for each name, and a setter
// for each `let`/`var`, so a test can set the page's state (`ranking`, `planContext`, ...).

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const APP_URL = new URL('../../web/app.js', import.meta.url);

let cached = null;

// app.js's source, read once.
export function appSource() {
    cached ??= readFileSync(APP_URL, 'utf8');
    return cached;
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `{ kind, text }` for one top-level declaration of app.js; `kind` is 'function', 'const', 'let'
// or 'var'. Throws when there is none, so a renamed function fails its test loudly.
export function declaration(name, source = appSource()) {
    const id = escapeRegExp(name);
    const start = new RegExp(`^(?:(?:async\\s+)?function\\s+${id}\\s*\\(|(const|let|var)\\s+${id}\\s*=)`, 'm').exec(source);
    if (!start) throw new Error(`app.js has no top-level declaration of ${name}`);
    // From the declaration's second line on (its first line starts with a letter itself).
    const lineEnd = source.indexOf('\n', start.index);
    if (lineEnd < 0) return { kind: start[1] || 'function', text: source.slice(start.index) };
    const next = /\n[A-Za-z_$]/.exec(source.slice(lineEnd));
    const end = next ? lineEnd + next.index + 1 : source.length;
    return { kind: start[1] || 'function', text: source.slice(start.index, end) };
}

// The named declarations of app.js, run together in a vm with `globals`; see the header.
export function appFunctions(names, globals = {}) {
    // In app.js's own order, so a `let` whose initializer reads another one finds it set.
    const parts = names.map(name => ({ name, ...declaration(name) }))
        .sort((a, b) => appSource().indexOf(a.text) - appSource().indexOf(b.text));
    const accessors = parts.map(({ name, kind }) => (kind === 'let' || kind === 'var'
        ? `get ${name}() { return ${name}; }, set ${name}(value) { ${name} = value; }`
        : `get ${name}() { return ${name}; }`)).join(',\n');
    const code = `(() => {\n${parts.map(p => p.text).join('\n')}\nreturn {\n${accessors}\n};\n})()`;
    // The vm has its own Object and Array, so compare what comes back through JSON (see plain()).
    const context = createContext({ console, structuredClone, setTimeout, clearTimeout, ...globals });
    return runInContext(code, context, { filename: 'app.js (extracted)' });
}

// A value made in the vm as a plain value of this realm, for assert.deepEqual.
export const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
