'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const start = html.indexOf('    function lockPageScrollToThread(');
const end = html.indexOf('\n    function ', start + 1);
assert(start >= 0 && end > start);

function fixture() {
  const listeners = new Map();
  const node = (classes = '', parentElement = null, options = {}) => ({
    nodeType: 1, classes: classes.split(' '), parentElement, id: '', connected: true,
    scrollTop: 0, scrollHeight: 400, clientHeight: 400, overflowY: 'visible',
    ...options,
    closest(selector) {
      const matches = element => selector.split(',').some(part => {
        const value = part.trim();
        return value.startsWith('.') ? element.classes.includes(value.slice(1))
          : value.startsWith('#') ? element.id === value.slice(1) : element.tagName === value;
      });
      for (let element = this; element; element = element.parentElement) if (matches(element)) return element;
      return null;
    },
  });
  const root = node('', null, { overflowY: 'hidden' });
  const context = vm.createContext({
    document: {
      addEventListener(type, callback) { listeners.set(type, callback); },
      contains(element) { return element.connected; },
    },
    window: { getComputedStyle: element => ({ overflowY: element.overflowY }) },
    performance: { now: () => 100 }, keepLayoutViewportPinned() {},
  });
  vm.runInContext(html.slice(start, end), context);
  context.lockPageScrollToThread();
  const fire = (type, target, x, y) => {
    const event = { target, touches: type === 'touchend' ? [] : [{ clientX: x, clientY: y }], defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    listeners.get(type)(event);
    return event.defaultPrevented;
  };
  const drag = (target, dx, dy) => {
    fire('touchstart', target, 100, 100);
    const blocked = fire('touchmove', target, 100 + dx, 100 + dy);
    fire('touchend', target, 100 + dx, 100 + dy);
    return blocked;
  };
  return { node, root, drag, fire };
}

const { node, root, drag, fire } = fixture();
const menu = node('thread-menu', root, { overflowY: 'hidden' });
const menuList = node('', menu, { id: 'thread-menu-list', overflowY: 'hidden' });
const project = node('thread-section-body', menuList, { overflowY: 'auto', scrollHeight: 1200, clientHeight: 300 });
const conversation = node('thread-section-body', menuList, { overflowY: 'auto', scrollHeight: 1800, clientHeight: 600 });
for (const pane of [project, conversation]) {
  const title = node('thread-title-text', pane);
  assert.strictEqual(drag(title, 0, -80), false, 'loaded section history must allow touch scrolling toward older rows');
  pane.scrollTop = 150;
  assert.strictEqual(drag(title, 0, 80), false, 'touch scrolling back toward recent rows must work');
  pane.scrollTop = 0;
  assert.strictEqual(drag(title, 0, 80), true, 'top-edge overscroll must not drag the page');
  pane.scrollTop = pane.scrollHeight - pane.clientHeight;
  assert.strictEqual(drag(title, 0, -80), true, 'bottom-edge overscroll must not drag the page');
}

// Search changes the scroll owner from each section to their common list.
menuList.overflowY = 'auto';
menuList.scrollHeight = 2000;
menuList.clientHeight = 600;
conversation.overflowY = 'visible';
conversation.clientHeight = conversation.scrollHeight;
assert.strictEqual(drag(node('thread-title-text', conversation), 0, -80), false, 'search must skip non-scrolling sections and use the shared results scroller');

const chat = node('thread', root, { overflowY: 'auto', scrollHeight: 2000 });
const shortSteps = node('steps', chat, { overflowY: 'auto' });
assert.strictEqual(drag(node('', shortSteps), 0, -80), false, 'short detail blocks must let the enclosing chat scroll');
assert.strictEqual(drag(node('process-tool-row', chat), 80, 0), false, 'horizontal tool history must retain native scrolling');
assert.strictEqual(drag(node('', root), 0, -80), true, 'non-scrolling page chrome remains pinned');
const textarea = node('', root, { tagName: 'textarea', selectionStart: 0, selectionEnd: 0 });
assert.strictEqual(drag(textarea, 80, 0), false, 'text editing gestures must remain available');
const viewer = node('', root, { id: 'image-viewer' });
assert.strictEqual(drag(node('', viewer), 80, 80), false, 'image viewer must own its pan gesture without the page scroll lock swallowing it');

// A refresh may replace the original node between touch events.
project.scrollTop = 100;
fire('touchstart', node('', project), 100, 100);
project.connected = false;
const replacement = node('thread-section-body', menu, { overflowY: 'auto', scrollHeight: 1200, clientHeight: 300 });
assert.strictEqual(fire('touchmove', node('', replacement), 100, 20), false, 'a replaced scroller must be resolved from the new touch target');

console.log('Touch scrolling passed: split/focused histories, search results, boundaries, chat, editing and replaced nodes.');
