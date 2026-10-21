'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('public/index.html', 'utf8');
function extract(name) {
  const start = html.indexOf(`    function ${name}(`);
  assert(start >= 0);
  const end = html.indexOf('\n    function ', start + 1);
  return html.slice(start, end);
}
const properties = new Map([['--keyboard-shift', '0px']]);
const classes = new Set();
let renderedShift = 0;
const textarea = {};
const root = { clientHeight: 844, style: { setProperty: (key, value) => properties.set(key, value) } };
const context = vm.createContext({
  window: { innerHeight: 844, visualViewport: { height: 500, offsetTop: 0 } },
  document: { documentElement: root, activeElement: textarea, body: { classList: {
    contains: key => classes.has(key), toggle: (key, on) => on ? classes.add(key) : classes.delete(key),
  } } },
  textarea, maxViewportHeight: 844, keyboardFocusStartedAt: 1, keyboardShiftTarget: 0,
  performance: { now: () => 2000 }, keepLayoutViewportPinned() {},
  clampNumber: (value, min, max) => Math.max(min, Math.min(max, value)),
  composer: { getBoundingClientRect: () => ({ bottom: 824 - renderedShift }) },
  composerShell: { getBoundingClientRect: () => ({ bottom: 844 - renderedShift }) },
  getComputedStyle: node => node === root ? { getPropertyValue: key => properties.get(key) || '' }
    : { transform: `matrix(1, 0, 0, 1, 0, ${-renderedShift})` },
});
vm.runInContext(extract('currentKeyboardShift') + '\n' + extract('renderedKeyboardShift') + '\n' + extract('applyViewportSize'), context);
context.applyViewportSize();
assert.strictEqual(Number.parseFloat(properties.get('--keyboard-shift')), 344, 'keyboard must align the shell to the visible viewport');
// CSS transitions may still be between frames: do not treat target shift as rendered shift.
renderedShift = 120;
context.applyViewportSize();
assert.strictEqual(Number.parseFloat(properties.get('--keyboard-shift')), 344, 'animation must not feed back into the next target');
renderedShift = 344;
context.window.visualViewport.height = 650;
context.applyViewportSize();
assert.strictEqual(Number.parseFloat(properties.get('--keyboard-shift')), 194, 'a shorter keyboard must lower the composer again');
renderedShift = 194;
context.window.visualViewport.offsetTop = 40;
context.applyViewportSize();
assert.strictEqual(Number.parseFloat(properties.get('--keyboard-shift')), 154, 'visual viewport offsets must be included');
context.window.visualViewport.height = 844;
context.window.visualViewport.offsetTop = 0;
context.applyViewportSize();
assert.strictEqual(properties.get('--keyboard-shift'), '0px');
assert.strictEqual(classes.has('keyboard-open'), false, 'dismissing the keyboard must clear sticky alignment while textarea remains focused');
context.window.visualViewport.height = 500;
renderedShift = 0;
context.applyViewportSize();
renderedShift = 344;
context.document.activeElement = {};
context.applyViewportSize();
assert.strictEqual(properties.get('--keyboard-shift'), '344px', 'blur must keep the composer above a keyboard that is still closing');
context.document.activeElement = textarea;
context.window.visualViewport.height = 800;
context.applyViewportSize();
assert.strictEqual(properties.get('--keyboard-shift'), '44px', 'small visible viewport changes must not leave the composer offscreen');
context.window.visualViewport.height = 844;
context.applyViewportSize();
assert.strictEqual(properties.get('--keyboard-shift'), '0px', 'the composer returns to the bottom when the visible viewport actually recovers');
console.log('Keyboard viewport layout regression tests passed.');
