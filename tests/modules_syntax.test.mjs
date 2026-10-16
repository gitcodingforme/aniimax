// Checks that nothing in web/ is broken in a way that only shows in a browser: a syntax error, an
// import that names something its module does not export, a file imported under two different
// ?v= tags (the page would run two copies of it), or an import of a file that is not there. Node
// cannot start app.js (it needs the page), so for app.js the imported names are checked against
// the exports of their modules by reading the source.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));

// --- reading the sources -------------------------------------------------------------------

// Every .js file under web/ except the vendored solver (web/vendor) and the wasm glue (web/pkg).
function webScripts(dir = WEB) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (dir === WEB && (entry.name === 'vendor' || entry.name === 'pkg')) continue;
            found.push(...webScripts(path));
        } else if (entry.name.endsWith('.js')) {
            found.push(path);
        }
    }
    return found.sort();
}

const name = file => relative(WEB, file).split(sep).join('/');
const read = file => readFileSync(file, 'utf8');

// The source without whole-line comments, so a tag or an import mentioned in a comment (the card
// contract in panels.js shows one) is not taken for code. Imports always start their own line.
const withoutComments = source => source.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

// The text of a list of names between braces, without comments: "a, b as c".
const names = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').split(',').map(s => s.trim()).filter(Boolean);

// Every relative import of a file:
//   { specifier, path (without ?query), query, names (imported names; 'default' for a default import),
//     kind: 'static' | 'reexport' | 'dynamic' } and, for dynamic imports whose argument is built at run
//   time, { expression } instead of a specifier.
function importsOf(source) {
    const code = withoutComments(source);
    const out = [];
    const add = (specifier, imported, kind) => {
        if (!specifier.startsWith('.')) return;
        const [path, query = ''] = specifier.split('?');
        out.push({ specifier, path, query: query ? `?${query}` : '', names: imported, kind });
    };
    for (const m of code.matchAll(/^[ \t]*import\s*(?:([^'"();]*?)\s*from\s*)?['"]([^'"]+)['"]/gm)) {
        const clause = (m[1] || '').trim();
        const imported = [];
        const braces = clause.match(/\{([^}]*)\}/);
        if (braces) for (const item of names(braces[1])) imported.push(item.split(/\s+as\s+/)[0].trim());
        const head = clause.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+[\w$]+/, '').replace(/,/g, '').trim();
        if (head) imported.push('default');
        add(m[2], imported, 'static');
    }
    for (const m of code.matchAll(/^[ \t]*export\s*(\*(?:\s+as\s+[\w$]+)?|\{([^}]*)\})\s*from\s*['"]([^'"]+)['"]/gm)) {
        add(m[3], m[2] === undefined ? [] : names(m[2]).map(item => item.split(/\s+as\s+/)[0].trim()), 'reexport');
    }
    for (const m of code.matchAll(/\bimport\(\s*([^)]*?)\s*\)/g)) {
        const literal = m[1].match(/^['"]([^'"]+)['"]$/);
        if (literal) add(literal[1], [], 'dynamic');
        else out.push({ expression: m[1], kind: 'dynamic' });
    }
    return out;
}

// What a module exports, as { names: Set, stars: [paths of `export *`] }.
function exportsOf(source) {
    const code = withoutComments(source);
    const exported = new Set();
    const stars = [];
    for (const m of code.matchAll(/^[ \t]*export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([\w$]+)/gm)) exported.add(m[1]);
    for (const m of code.matchAll(/^[ \t]*export\s+default\b/gm)) exported.add('default');
    for (const m of code.matchAll(/^[ \t]*export\s*\{([^}]*)\}/gm)) {
        for (const item of names(m[1])) exported.add(item.split(/\s+as\s+/).pop().trim());
    }
    for (const m of code.matchAll(/^[ \t]*export\s*\*\s*from\s*['"]([^'"]+)['"]/gm)) stars.push(m[1].split('?')[0]);
    return { names: exported, stars };
}

function allExports(file, seen = new Set()) {
    if (seen.has(file)) return new Set();
    seen.add(file);
    const { names: own, stars } = exportsOf(read(file));
    const all = new Set(own);
    for (const star of stars) {
        const target = resolve(dirname(file), star);
        if (existsSync(target)) for (const n of allExports(target, seen)) if (n !== 'default') all.add(n);
    }
    return all;
}

// --- 1. syntax -----------------------------------------------------------------------------

// `node --check FILE` reads a .js file that has import or export statements as a script first,
// and then stops quietly: Node 24 exits 0 even with a typo on line 2 (tried with 24.20). The same
// check on stdin with --input-type=module parses it as the module it is. A file with no import or
// export (sw.js is a classic script) is accepted if it parses as a script or as a module.
function check(args, options) {
    try {
        execFileSync(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
        return null;
    } catch (error) {
        return String(error.stderr || error.message).split('\n').filter(Boolean).slice(0, 6).join('\n');
    }
}

function syntaxProblem(file, source) {
    const asModule = check(['--check', '--input-type=module'], { input: source });
    if (/^\s*(import|export)\b/m.test(withoutComments(source))) return asModule;
    if (asModule === null) return null;
    return check(['--check', file]) === null ? null : asModule;
}

test('test_the_syntax_check_sees_a_typo_in_a_module', () => {
    // If a Node upgrade made the check blind again, the real test below would pass for nothing.
    assert.ok(syntaxProblem('broken.js', 'import x from "./y.js";\nconst a = ;\n'), 'a typo after an import statement is reported');
    assert.equal(syntaxProblem('fine.js', 'import x from "./y.js";\nconst a = 1;\nexport { a };\n'), null);
});

test('test_every_web_script_parses', () => {
    const files = webScripts();
    assert.ok(files.length >= 40, `found ${files.length} scripts under web/`);
    const problems = [];
    for (const file of files) {
        const problem = syntaxProblem(file, read(file));
        if (problem) problems.push(`${name(file)}:\n${problem}`);
    }
    assert.deepEqual(problems, []);
});

// --- 2. tags and files ---------------------------------------------------------------------

// The tag index.html puts on its own stylesheet and script lines, read from the file so a version
// bump does not need this test edited.
function pageTag() {
    const html = read(join(WEB, 'index.html'));
    const tagged = [...html.matchAll(/\b(?:href|src)="([^"?#:]+)\?v=([^"&]+)"/g)].map(m => ({ file: m[1], tag: m[2] }));
    return { tagged, tags: [...new Set(tagged.map(t => t.tag))] };
}

// Untagged relative imports that are on purpose, as `importer: [specifiers]`:
const UNTAGGED = {
    // i18n.js holds the page's language state, so there has to be ONE copy of it. app.js and
    // math-translation.js both import it without a tag; a tagged import in either would load a
    // second copy that never hears about a language change.
    'app.js': ['./i18n.js', './math-translation.js'],
    'math-translation.js': ['./i18n.js', './math-retypeset.js'],
    // The vendored HiGHS solver: not our code, never changes with a release, served as it is.
    'worker.js': ['./vendor/highs/highs.mjs'],
};

// Dynamic imports built at run time. Each takes its tag from the file's own address
// (`new URL(import.meta.url).search`), so the module it loads carries the tag it was loaded with.
const DERIVED_TAG = ['panels.js', 'layout-worker.js', 'worker.js'];

test('test_index_html_uses_one_tag_on_its_own_files', () => {
    const { tagged, tags } = pageTag();
    assert.deepEqual(tags.length, 1, `index.html has more than one ?v= tag: ${tagged.map(t => `${t.file}?v=${t.tag}`).join(', ')}`);
    for (const file of ['style.css', 'css/features.css', 'app.js', 'sw-register.js']) {
        assert.ok(tagged.some(t => t.file === file), `index.html loads ${file} with a ?v= tag`);
    }
});

test('test_every_tagged_import_uses_the_pages_tag_and_untagged_ones_are_on_purpose', () => {
    const [tag] = pageTag().tags;
    assert.ok(tag, 'index.html has a tag');
    const wrongTag = [];
    const untagged = [];
    const unknownDynamic = [];
    let scanned = 0;
    let tagged = 0;
    for (const file of webScripts()) {
        const importer = name(file);
        const source = read(file);
        for (const item of importsOf(source)) {
            scanned++;
            if (item.query) tagged++;
            if (item.expression !== undefined) {
                const derives = DERIVED_TAG.includes(importer) && /new URL\(import\.meta\.url\)\.search/.test(source);
                if (!derives) unknownDynamic.push(`${importer}: import(${item.expression})`);
            } else if (item.query === '') {
                if (!(UNTAGGED[importer] || []).includes(item.specifier)) untagged.push(`${importer} imports ${item.specifier} with no tag`);
            } else if (item.query !== `?v=${tag}`) {
                wrongTag.push(`${importer} imports ${item.specifier}, the page's tag is ?v=${tag}`);
            }
        }
    }
    // The scan reads the code it is meant to: dozens of imports, most of them tagged.
    assert.ok(scanned >= 50 && tagged >= 40, `scanned ${scanned} imports, ${tagged} tagged`);
    assert.deepEqual(wrongTag, [], 'one tag across the site, or the browser mixes old and new files');
    assert.deepEqual(untagged, [], 'tag it, or list it in UNTAGGED here with the reason');
    assert.deepEqual(unknownDynamic, [], 'an import() built at run time must take its tag from import.meta.url (DERIVED_TAG here)');
});

test('test_no_module_is_loaded_under_two_names', () => {
    // The same file imported with a tag in one place and without in another runs twice.
    const how = new Map();
    for (const file of webScripts()) {
        for (const item of importsOf(read(file))) {
            if (item.path === undefined) continue;
            const target = resolve(dirname(file), item.path);
            if (!how.has(target)) how.set(target, new Map());
            how.get(target).set(item.query || '(no tag)', name(file));
        }
    }
    const twice = [...how].filter(([, variants]) => variants.size > 1)
        .map(([target, variants]) => `${name(target)}: ${[...variants].map(([q, by]) => `${q} in ${by}`).join('; ')}`);
    assert.deepEqual(twice, []);
});

test('test_every_relative_import_points_at_a_file_that_exists', () => {
    const missing = [];
    for (const file of webScripts()) {
        for (const item of importsOf(read(file))) {
            if (item.path !== undefined && !existsSync(resolve(dirname(file), item.path))) missing.push(`${name(file)} imports ${item.specifier}`);
        }
    }
    assert.deepEqual(missing, []);
});

// --- 3. named imports ----------------------------------------------------------------------

// Every name a file imports from another file under web/ is exported there (vendor/ and pkg/ are
// not read). Written for app.js, but it checks every script, cards included.
function missingNames(file) {
    const problems = [];
    for (const item of importsOf(read(file))) {
        if (item.path === undefined || item.names.length === 0) continue;
        const target = resolve(dirname(file), item.path);
        if (!existsSync(target) || !target.endsWith('.js') || target.startsWith(join(WEB, 'vendor')) || target.startsWith(join(WEB, 'pkg'))) continue;
        const have = allExports(target);
        for (const wanted of item.names) {
            if (!have.has(wanted)) problems.push(`${name(file)} imports { ${wanted} } from ${item.specifier}, which does not export it`);
        }
    }
    return problems;
}

test('test_app_js_imports_only_names_its_modules_export', () => {
    const file = join(WEB, 'app.js');
    const imports = importsOf(read(file)).filter(i => i.kind === 'static');
    const wanted = imports.flatMap(i => i.names);
    // The reading itself works: app.js imports a lot, from several modules.
    assert.ok(imports.length >= 15, `read ${imports.length} imports from app.js`);
    assert.ok(wanted.length >= 100, `read ${wanted.length} imported names from app.js`);
    assert.ok(wanted.includes('FACILITIES') && wanted.includes('createSolver') && wanted.includes('mountCards'));
    assert.deepEqual(missingNames(file), []);
});

test('test_every_script_imports_only_names_its_modules_export', () => {
    const problems = webScripts().flatMap(missingNames);
    assert.deepEqual(problems, []);
});

test('test_the_export_reader_understands_the_forms_the_modules_use', () => {
    const { names: found, stars } = exportsOf([
        'export function a() {}', 'export async function b() {}', 'export const c = 1, d = 2;', 'export let e;', 'export class F {}',
        'export { g, h as i };', 'export { j } from "./x.js";', 'export * from "./y.js?v=1";', 'export default 1;',
        '// export const commented = 1;',
    ].join('\n'));
    assert.deepEqual([...found].sort(), ['a', 'b', 'c', 'default', 'e', 'F', 'g', 'i', 'j'].sort());
    assert.deepEqual(stars, ['./y.js']);
    const got = importsOf('import a, { b as c, d } from "./m.js?v=t";\nimport "./side.js";\nimport * as ns from "./n.js";\nexport { q } from "./r.js";\nconst z = import("./late.js?v=t");\nconst y = import(`./cards/${n}.js`);')
        .map(i => (i.expression !== undefined ? ['expr'] : [i.kind, i.path, i.query, i.names.join('+')]));
    assert.deepEqual(got, [
        ['static', './m.js', '?v=t', 'b+d+default'], ['static', './side.js', '', ''], ['static', './n.js', '', ''],
        ['reexport', './r.js', '', 'q'], ['dynamic', './late.js', '?v=t', ''], ['expr'],
    ]);
});

// --- 4. loading the pure modules -----------------------------------------------------------

// Modules with no page in them: importing each runs it and links everything it imports, so a
// name that is not exported, a loop of imports or a mistake at the top of a file fails here. The
// tag is left off (Node would ignore it on a file anyway); the imports inside carry theirs.
const PURE = [
    'bus', 'solve', 'panels', 'plan-summary', 'setup-input', 'reminders', 'history', 'profile', 'share-config', 'overrides', 'compare',
    'daily', 'roadmap', 'coverage', 'goal-mode', 'what-if', 'roster-advisor', 'session', 'insight', 'streaks', 'screenshot-import',
    'upstream-check', 'turn-jobs', 'checklist', 'facility-config', 'shared',
];

for (const module of PURE) {
    test(`test_pure_module_${module.replace(/-/g, '_')}_loads`, async () => {
        const exported = await import(pathToFileURL(join(WEB, `${module}.js`)).href);
        assert.ok(Object.keys(exported).length > 0, `${module}.js exports something`);
    });
}
