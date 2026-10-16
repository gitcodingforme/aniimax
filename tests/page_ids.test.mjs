// Checks the ids that web/index.html and the scripts agree on. A script that asks for an id the
// page does not have gets null in the browser and throws on the first use, which on startup can
// leave the whole page dead; a feature card whose ids do not carry its name can clash with the
// page's own. Both are cheap to see by reading the sources.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { CARDS } from '../web/panels.js';

const webFile = path => new URL(`../web/${path}`, import.meta.url);
const read = path => readFileSync(webFile(path), 'utf8');

// The source without whole-line comments (a getElementById in a comment is not a lookup).
const withoutComments = source => source.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

// Ids written in markup: id="x", but not data-id="x" or aria-labelledby-style attributes.
const declaredIds = source => [...source.matchAll(/(?<![\w-])id="([^"]*)"/g)].map(m => m[1]);

const PAGE_IDS = new Set(declaredIds(read('index.html')));

// Ids that a script looks up, written as plain text: getElementById('x') and the id at the start of
// querySelector('#x ...'). A template string with ${} in it is not a plain id and is left out.
function lookedUp(source) {
    const code = withoutComments(source);
    const found = [];
    for (const m of code.matchAll(/getElementById\(\s*(['"`])([^'"`]*)\1\s*\)/g)) {
        if (!m[2].includes('${')) found.push(m[2]);
    }
    for (const m of code.matchAll(/querySelector(?:All)?\(\s*(['"`])#([\w-]+)/g)) found.push(m[2]);
    return found;
}

// Ids the page script creates itself, so index.html has no place for them. Each is written into
// markup by app.js and looked up after that markup is on the page.
const RUNTIME_IDS = {
    // renderLevelUpTable's <th id="level-up-rate-head">, which then receives the rate-unit select.
    'level-up-rate-head': 'app.js',
    // the priority table's <th id="priority-rate-head">, the same.
    'priority-rate-head': 'app.js',
};

// The scripts that sit next to index.html (not the cards; those are checked below).
const pageScripts = readdirSync(webFile(''))
    .filter(file => file.endsWith('.js'))
    .sort();

test('test_every_id_a_page_script_looks_up_is_in_index_html', () => {
    const missing = [];
    const lookups = {};
    for (const file of pageScripts) {
        const ids = lookedUp(read(file));
        lookups[file] = ids.length;
        for (const id of ids) {
            if (!PAGE_IDS.has(id) && !(id in RUNTIME_IDS)) missing.push(`${file} looks up #${id}`);
        }
    }
    // The reading works: app.js looks up well over a hundred ids.
    assert.ok(lookups['app.js'] >= 150, `read ${lookups['app.js']} lookups in app.js`);
    assert.ok(PAGE_IDS.size >= 150, `index.html declares ${PAGE_IDS.size} ids`);
    assert.deepEqual(missing, [], 'add the id to index.html, or to RUNTIME_IDS here if the script creates it');
});

test('test_runtime_ids_are_really_created_by_the_script_that_looks_them_up', () => {
    for (const [id, file] of Object.entries(RUNTIME_IDS)) {
        const source = withoutComments(read(file));
        assert.ok(declaredIds(source).includes(id), `${file} writes id="${id}" into its markup`);
        assert.ok(lookedUp(source).includes(id), `${file} looks up #${id}`);
        assert.ok(!PAGE_IDS.has(id), `#${id} is in index.html now, so it no longer needs an entry in RUNTIME_IDS`);
    }
});

test('test_every_card_has_its_container_in_index_html', () => {
    assert.ok(CARDS.length >= 10);
    // panels.js mounts a card only if `<name>-card` is on the page, and says nothing otherwise.
    assert.deepEqual(CARDS.filter(card => !PAGE_IDS.has(`${card}-card`)), []);
    const html = read('index.html');
    for (const card of CARDS) {
        const tag = html.match(new RegExp(`<[a-z]+[^>]*\\bid="${card}-card"[^>]*>`))?.[0] || '';
        assert.match(tag, /\bhidden\b/, `${card}-card starts hidden (a card is shown after it mounts)`);
        assert.ok(readFileSync(webFile(`cards/${card}.js`)), `web/cards/${card}.js exists`);
    }
});

// --- the cards' own ids ---------------------------------------------------------------------

// The id or name belongs to the card: `<card>` or `<card>-...`.
const ownsId = (card, id) => id === card || id.startsWith(`${card}-`);

// The ids (id="...") and input names (name="...") a card writes into its markup, and the ids it
// looks up. Returns { written, names, lookups }.
function cardIds(card) {
    const code = withoutComments(read(`cards/${card}.js`));
    return {
        written: declaredIds(code),
        names: [...code.matchAll(/(?<![\w-])name="([^"]*)"/g)].map(m => m[1]),
        lookups: [...code.matchAll(/getElementById\(\s*(['"`])([^'"`]*)\1\s*\)/g)].map(m => m[2])
            .concat([...code.matchAll(/querySelector(?:All)?\(\s*(['"`])#([^'"`\s.[:>,]*)/g)].map(m => m[2])),
        code,
    };
}

// `${box}` or `${id}-count` at the start of an id: the text the variable is given in the card's
// code, which has to start with the card's name. Returns the problem, or null.
function interpolatedProblem(card, id, code) {
    const variable = id.match(/^\$\{([A-Za-z_$][\w$]*)\}/)?.[1];
    if (!variable) return `${card}: id "${id}" starts with something that is not a plain variable, so the card's prefix cannot be checked`;
    const assignments = [...code.matchAll(new RegExp(`(?:const|let)\\s+${variable}\\s*=\\s*([\`'"])([^\`'"]*)`, 'g'))].map(m => m[2]);
    if (assignments.length === 0) return `${card}: id "${id}" uses ${variable}, which is not set from a string in the card, so its prefix cannot be checked`;
    const wrong = assignments.filter(text => !ownsId(card, text.replace(/\$\{[^}]*\}.*$/, '')));
    return wrong.length ? `${card}: id "${id}" uses ${variable} = "${wrong[0]}", which does not start with "${card}-"` : null;
}

test('test_card_ids_and_input_names_start_with_the_cards_name', () => {
    const problems = [];
    let checked = 0;
    for (const card of CARDS) {
        const { written, names, lookups, code } = cardIds(card);
        for (const id of [...written, ...lookups]) {
            if (id === '') continue;
            checked++;
            if (id.startsWith('$')) {
                const problem = interpolatedProblem(card, id, code);
                if (problem) problems.push(problem);
            } else if (!ownsId(card, id)) {
                problems.push(`${card}: id "${id}" does not start with "${card}-"`);
            }
        }
        for (const name of names) {
            checked++;
            if (!ownsId(card, name)) problems.push(`${card}: input name "${name}" does not start with "${card}-"`);
        }
    }
    assert.ok(checked >= 60, `checked ${checked} ids and names across the cards`);
    assert.deepEqual(problems, []);
});

test('test_ids_a_card_looks_up_are_in_the_markup_it_writes', () => {
    const problems = [];
    for (const card of CARDS) {
        const { written, lookups } = cardIds(card);
        for (const id of lookups) {
            // `#compare-${id}` is cut at the ${; a lookup built that way is checked when the card is mounted.
            if (id === '' || id.endsWith('-') || id.includes('$')) continue;
            if (!written.includes(id)) problems.push(`${card}: looks up #${id}, which its markup does not contain`);
        }
    }
    assert.deepEqual(problems, []);
});

test('test_the_card_id_reader_sees_what_it_should', () => {
    // A quick proof for the regexes above, on text shaped like the cards' code.
    const sample = [
        '// el.querySelector("#in-a-comment");',
        "const a = el.querySelector('#roadmap-check');",
        'const b = el.querySelector(`#compare-${id}`);',
        "el.innerHTML = `<input id=\"roadmap-x\" data-id=\"${esc(item.id)}\" name=\"roadmap-kind\">`;",
    ].join('\n');
    assert.deepEqual(declaredIds(sample), ['roadmap-x']);
    assert.deepEqual(lookedUp(sample), ['roadmap-check', 'compare-']);
    assert.equal(ownsId('what-if', 'what-if-form'), true);
    assert.equal(ownsId('what-if', 'what-iffy'), false);
    assert.equal(ownsId('daily', 'dailyx-1'), false);
});
