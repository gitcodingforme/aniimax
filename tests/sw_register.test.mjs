// Tests for the pure helpers in web/sw-register.js (importing it in Node registers nothing: the
// browser part only runs when there is a `window`).
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isLocalHost, needsReload, sameOriginUrls, shouldRegister, switchOffRequested, toastElement, withoutParam,
} from '../web/sw-register.js';

const at = (url) => {
    const u = new URL(url);
    return { hostname: u.hostname, search: u.search, href: u.href };
};

test('test_should_register_only_on_the_published_site_or_with_sw_on', () => {
    assert.equal(shouldRegister(at('http://localhost:8080/')), false);
    assert.equal(shouldRegister(at('http://localhost:8080/?sw=on')), true);
    assert.equal(shouldRegister(at('http://localhost:8080/?sw=off')), false);
    assert.equal(shouldRegister(at('http://127.0.0.1:8080/index.html')), false);
    assert.equal(shouldRegister(at('http://127.0.0.1:8080/?a=1&sw=on')), true);
    assert.equal(shouldRegister(at('http://[::1]:8080/')), false);
    assert.equal(shouldRegister(at('http://[::1]:8080/?sw=on')), true);
    assert.equal(shouldRegister(at('https://gitcodingforme.github.io/aniimax/')), true);
    assert.equal(shouldRegister(at('https://gitcodingforme.github.io/aniimax/#config=abc')), true);
    assert.equal(shouldRegister(at('https://gitcodingforme.github.io/aniimax/?nosw')), false);
    assert.equal(shouldRegister(at('http://localhost:8080/?sw=on&nosw')), false);
    assert.equal(shouldRegister(null), false);
    assert.equal(isLocalHost('LOCALHOST'), true);
    assert.equal(isLocalHost('gitcodingforme.github.io'), false);
});

test('test_nosw_is_detected_and_removed_from_the_address', () => {
    assert.equal(switchOffRequested(at('https://gitcodingforme.github.io/aniimax/?nosw')), true);
    assert.equal(switchOffRequested(at('https://gitcodingforme.github.io/aniimax/?nosw=1')), true);
    assert.equal(switchOffRequested(at('http://localhost:8080/?a=1&nosw')), true);
    assert.equal(switchOffRequested(at('https://gitcodingforme.github.io/aniimax/?noswx')), false);
    assert.equal(switchOffRequested(at('https://gitcodingforme.github.io/aniimax/')), false);
    assert.equal(withoutParam('?nosw', 'nosw'), '');
    assert.equal(withoutParam('?a=1&nosw&b=2', 'nosw'), '?a=1&b=2');
    assert.equal(withoutParam('?x=a%20b&nosw=1', 'nosw'), '?x=a%20b');
    assert.equal(withoutParam('', 'nosw'), '');
});

test('test_switching_off_reloads_once_only_while_the_old_worker_still_controls_the_tab', () => {
    const controller = { state: 'activated' };
    assert.equal(needsReload({ controlled: controller, justReloaded: false, storageWorks: true }), true);
    assert.equal(needsReload({ controlled: null, justReloaded: false, storageWorks: true }), false, 'already free');
    assert.equal(needsReload({ controlled: controller, justReloaded: true, storageWorks: true }), false, 'no loop');
    assert.equal(needsReload({ controlled: controller, justReloaded: false, storageWorks: false }), false,
        'without sessionStorage the loop guard cannot be kept, so it never reloads');
});

test('test_same_origin_urls_keeps_only_this_sites_files', () => {
    const page = 'https://gitcodingforme.github.io/aniimax/';
    assert.deepEqual(sameOriginUrls([
        page, `${page}app.js?v=1`, 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js',
        `${page}app.js?v=1`, 'not a url', 7,
    ], page), [page, `${page}app.js?v=1`]);
});

function fakeDocument() {
    const make = (tag) => ({
        tagName: tag.toUpperCase(), children: [], attributes: {}, listeners: {}, style: { cssText: '' },
        textContent: '', removed: false,
        setAttribute(name, value) { this.attributes[name] = String(value); },
        appendChild(child) { this.children.push(child); return child; },
        addEventListener(type, listener) { this.listeners[type] = listener; },
        remove() { this.removed = true; },
    });
    return { createElement: make };
}

test('test_toast_element_has_text_a_reload_button_and_a_dismiss_button', () => {
    let clicks = 0;
    const box = toastElement('Site updated.', () => { clicks += 1; }, fakeDocument());
    assert.equal(box.attributes.role, 'status');
    assert.match(box.style.cssText, /background:var\(--surface-2, #1e2229\)/);
    assert.match(box.style.cssText, /color:var\(--text, #e9eaec\)/);
    const [label, reload, close] = box.children;
    assert.equal(label.textContent, 'Site updated.');
    assert.equal(reload.textContent, 'Reload');
    assert.match(reload.style.cssText, /var\(--accent, #6cc5a4\)/);
    reload.listeners.click();
    assert.equal(clicks, 1);
    assert.equal(close.attributes['aria-label'], 'Dismiss');
    close.listeners.click();
    assert.equal(box.removed, true);

    const plainBox = toastElement('Offline mode switched off', null, fakeDocument());
    assert.deepEqual(plainBox.children.map((child) => child.textContent), ['Offline mode switched off', '×']);
});
