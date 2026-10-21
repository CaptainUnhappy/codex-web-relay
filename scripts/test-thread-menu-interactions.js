'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const start = html.indexOf('    function cancelThreadLongPress(');
const end = html.indexOf("    reasoningMenuCard.addEventListener('pointerdown'", start);
assert(start >= 0 && end > start, 'load the actual title and menu event handlers');
const state = html.match(/^    let (?:threadLongPress\w*|suppressThreadClick\w*) = .*;$/gm).join('\n');

function fixture() {
  let now = 1000;
  let timerId = 0;
  let actionCards = 0;
  const timers = new Map();
  const document = { activeElement: null, listeners: {}, addEventListener };
  function addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  function node() {
    const classes = new Set();
    return {
      listeners: {}, style: {}, attributes: {}, addEventListener,
      classList: {
        contains: key => classes.has(key),
        toggle(key, on) { if (on) classes.add(key); else classes.delete(key); },
      },
      setAttribute(key, value) { this.attributes[key] = value; },
      contains(target) { return target === this; },
      focus() { document.activeElement = this; },
      blur() { if (document.activeElement === this) document.activeElement = null; },
      getBoundingClientRect: () => ({ top: 760, bottom: 52 }),
    };
  }
  const nodes = Object.fromEntries(['threadButton', 'threadMenu', 'threadMenuList', 'threadMenuScrim',
    'threadSearch', 'threadSearchClear', 'threadMenuClose', 'threadActionCard', 'threadRenameInput',
    'textarea', 'topbar', 'composer', 'composerShell'].map(name => [name, node()]));
  document.body = node();
  nodes.threadMenu.contains = target => target === nodes.threadMenu || target === nodes.threadSearch;
  const transitions = [];
  const toggle = nodes.threadMenu.classList.toggle;
  nodes.threadMenu.classList.toggle = (key, on) => { transitions.push(on); toggle(key, on); };
  const context = vm.createContext({
    ...nodes, document, selectedThreadId: 'fixture', threadSearchQuery: '',
    Date: { now: () => now },
    window: {
      innerHeight: 844,
      getComputedStyle: () => ({ position: 'fixed', left: '12px', getPropertyValue: () => '12' }),
      setTimeout(callback, delay) { timers.set(++timerId, { callback, at: now + delay }); return timerId; },
      clearTimeout: id => timers.delete(id),
    },
    closeReasoningMenu() {}, closeModelMenu() {}, closeThreadActionCard() {}, renderThreadMenu() {},
    loadThreads: () => Promise.resolve(), refreshRelayStatus: () => Promise.resolve(), setNotice() {}, scheduleThreadMenuFill() {},
    openThreadActionCard() { actionCards++; },
  });
  vm.runInContext(state + '\n' + html.slice(start, end), context);
  function fire(type, props = {}) {
    const event = { target: nodes.threadButton, button: 0, clientX: 40, clientY: 20,
      pointerType: 'touch', detail: 1, cancelable: true, preventDefault() {}, stopPropagation() {}, ...props };
    for (const handler of nodes.threadButton.listeners[type] || []) handler(event);
  }
  function advance(ms) {
    now += ms;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
  }
  function tap(delay = 0, click = {}) {
    fire('pointerdown'); fire('pointerup'); advance(delay); fire('click', click);
  }
  return { fire, advance, tap, transitions, nodes, document,
    open: () => nodes.threadMenu.classList.contains('is-open'), actions: () => actionCards };
}

const delayed = fixture();
delayed.tap(650);
assert(delayed.open(), 'a delayed compatibility click must leave the menu open');
assert.deepStrictEqual(delayed.transitions, [true], 'one gesture must change menu state only once');
assert(delayed.document.body.classList.contains('thread-menu-open'), 'opening floating navigation hides the composer');
assert.strictEqual(delayed.nodes.composerShell.inert, true, 'hidden composer cannot receive keyboard focus');
delayed.tap();
assert(!delayed.document.body.classList.contains('thread-menu-open'), 'closing navigation restores the composer');
assert.strictEqual(delayed.nodes.composerShell.inert, false);

const rapid = fixture();
rapid.tap(); rapid.advance(80); rapid.tap();
assert(!rapid.open(), 'a second intentional tap must close the menu without a cooldown');
assert.deepStrictEqual(rapid.transitions, [true, false]);

const zeroDetail = fixture();
zeroDetail.tap(0, { detail: 0 });
assert.deepStrictEqual(zeroDetail.transitions, [true], 'zero-detail pointer clicks must not toggle twice');
assert.notStrictEqual(zeroDetail.document.activeElement, zeroDetail.nodes.threadSearch, 'touch does not automatically open the search keyboard');

const longPress = fixture();
longPress.fire('pointerdown'); longPress.advance(600); longPress.fire('pointerup'); longPress.advance(1200); longPress.fire('click');
assert.strictEqual(longPress.actions(), 1, 'long press retains the task action card');
assert(!longPress.open(), 'even a late click after a long press must not open navigation');
longPress.tap();
assert(longPress.open(), 'the next intentional tap works immediately after a long press');

for (const cancelledEvent of ['pointercancel', 'pointermove']) {
  const cancelled = fixture();
  cancelled.fire('pointerdown'); cancelled.fire(cancelledEvent, { clientX: 80 });
  cancelled.fire('pointerup'); cancelled.fire('click');
  assert(!cancelled.open(), `${cancelledEvent} must not become a tap`);
  cancelled.advance(1000);
  assert.strictEqual(cancelled.actions(), 0, 'cancellation must clear the long-press timer');
}

for (const key of ['Enter', ' ']) {
  const keyboard = fixture();
  keyboard.fire('contextmenu');
  keyboard.fire('keydown', { key, pointerType: undefined, detail: 0 });
  keyboard.fire('click', { pointerType: '', detail: 0 });
  assert(keyboard.open(), 'keyboard activation must not inherit pointer suppression');
  assert.strictEqual(keyboard.document.activeElement, keyboard.nodes.threadSearch);
}
console.log('Thread menu interactions passed: delayed/rapid/zero-detail clicks, long press, cancellation and keyboard activation.');
