'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const start = html.indexOf('    function filterThreadItems(');
const end = html.indexOf('\n    function ', start + 1);
const context = vm.createContext({});
vm.runInContext(html.slice(start, end), context);
const rows = [
  { id: 'project', name: '规划界面', isProjectThread: true, projectName: 'Codex-Mini', children: [
    { id: 'child', name: '检查 Keyboard', children: [] },
    { id: 'other', name: '附件验证', children: [] },
  ] },
  { id: 'conversation', name: '日常想法', projectName: 'internal-only', cwd: '/private/path' },
];
const before = JSON.stringify(rows);
const filter = query => JSON.parse(JSON.stringify(context.filterThreadItems(rows, query)));
assert.strictEqual(context.filterThreadItems(rows, '  '), rows, 'empty search retains the source tree');
assert.deepStrictEqual(filter('日常').map(row => row.id), ['conversation']);
assert.deepStrictEqual(filter('CODEX-mini').map(row => row.id), ['project']);
const nested = filter('Codex keyboard');
assert.strictEqual(nested[0].id, 'project', 'matching children retain their parent context');
assert.deepStrictEqual(nested[0].children.map(row => row.id), ['child']);
assert.deepStrictEqual(filter('附件')[0].children.map(row => row.id), ['other']);
assert.deepStrictEqual(filter('private'), [], 'private paths are not searched');
assert.deepStrictEqual(filter('internal-only'), [], 'projectless internal metadata is not searched');
assert.deepStrictEqual(filter('<script>'), [], 'input is literal text');
assert.deepStrictEqual(filter('['), [], 'regex characters are literal');
assert.strictEqual(JSON.stringify(rows), before, 'search must not mutate original children or collapse state');
console.log('Thread search passed: project/title terms, case-insensitive matching, nested tasks, metadata boundaries and original-tree preservation.');
