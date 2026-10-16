import assert from 'node:assert/strict';
import test from 'node:test';

import { CARDS, addStylesheet, mountCards } from '../web/panels.js';

// A container as index.html has it: `<section id="<name>-card" hidden>`.
function element(id) {
    const attributes = new Set(['hidden']);
    return {
        id,
        removeAttribute: name => attributes.delete(name),
        hasAttribute: name => attributes.has(name),
    };
}

test('test_the_card_list_matches_the_ten_containers', () => {
    assert.deepEqual(CARDS, ['daily', 'roadmap', 'coverage', 'goal-mode', 'what-if', 'roster-advisor', 'session', 'insight', 'streaks', 'compare']);
});

test('test_cards_mount_with_the_context_and_are_shown', async () => {
    const elements = new Map(CARDS.map(name => [`${name}-card`, element(`${name}-card`)]));
    const mountedWith = [];
    const ctx = { marker: 'ctx' };
    const imported = [];
    const mounted = await mountCards(ctx, {
        getElement: id => elements.get(id) || null,
        importCard: async (name) => {
            imported.push(name);
            return { mount: async (el, given) => mountedWith.push([name, el.id, given]) };
        },
    });
    assert.deepEqual(mounted, CARDS);
    assert.deepEqual(imported, CARDS);
    assert.deepEqual(mountedWith.map(([name, id]) => [name, id]), CARDS.map(name => [name, `${name}-card`]));
    assert.ok(mountedWith.every(([, , given]) => given === ctx), 'every card gets the same ctx');
    assert.ok([...elements.values()].every(el => !el.hasAttribute('hidden')));
});

test('test_a_missing_container_is_skipped_and_its_module_not_loaded', async () => {
    const roadmap = element('roadmap-card');
    const imported = [];
    const mounted = await mountCards({}, {
        getElement: id => (id === 'roadmap-card' ? roadmap : null),
        importCard: async (name) => {
            imported.push(name);
            return { mount() {} };
        },
    });
    assert.deepEqual(mounted, ['roadmap']);
    assert.deepEqual(imported, ['roadmap']);
    assert.equal(roadmap.hasAttribute('hidden'), false);
});

test('test_a_broken_card_is_warned_about_and_stays_hidden', async (t) => {
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args));
    const elements = new Map(['daily', 'roadmap', 'coverage', 'insight'].map(name => [`${name}-card`, element(`${name}-card`)]));
    const mounted = await mountCards({}, {
        getElement: id => elements.get(id) || null,
        importCard: async (name) => {
            if (name === 'daily') throw new Error('no such file');
            if (name === 'coverage') return {};
            return {
                mount: async () => {
                    if (name === 'roadmap') throw new Error('mount broke');
                },
            };
        },
    });
    assert.deepEqual(mounted, ['insight']);
    assert.equal(elements.get('insight-card').hasAttribute('hidden'), false);
    for (const name of ['daily', 'roadmap', 'coverage']) assert.equal(elements.get(`${name}-card`).hasAttribute('hidden'), true, name);
    assert.deepEqual(warnings.map(w => w[0]).sort(), ['card coverage not loaded', 'card daily not loaded', 'card roadmap not loaded']);
    assert.equal(warnings.find(w => w[0] === 'card roadmap not loaded')[1].message, 'mount broke');
});

test('test_add_stylesheet_adds_one_link_per_href', () => {
    const appended = [];
    const doc = {
        createElement: tag => ({ tag }),
        head: { appendChild: el => appended.push(el) },
    };
    const first = addStylesheet('css/roadmap.css', { doc });
    const again = addStylesheet('css/roadmap.css', { doc });
    addStylesheet('css/daily.css', { doc });
    assert.equal(first, again);
    assert.equal(appended.length, 2);
    // Loaded from a plain file URL in the tests, so there is no ?v= tag to pass on.
    assert.deepEqual(appended.map(el => [el.tag, el.rel, el.href]), [['link', 'stylesheet', 'css/roadmap.css'], ['link', 'stylesheet', 'css/daily.css']]);
});
