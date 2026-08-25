/**
 * Guard: the root-level app.js / index.html duplicates must never come back.
 *
 * They were dead weight for a long time - 5,856 lines that nothing loaded and
 * that package.json never shipped. Their only effect was to swallow edits that
 * were meant for the live renderer/ copies. main.js loads renderer/index.html,
 * which loads renderer/app.js. Those are the real ones.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('no dead root-level app.js duplicate', () => {
  assert.ok(
    !fs.existsSync(path.join(root, 'app.js')),
    'root app.js is dead code - the live file is renderer/app.js',
  );
});

test('no dead root-level index.html duplicate', () => {
  assert.ok(
    !fs.existsSync(path.join(root, 'index.html')),
    'root index.html is dead code - the live file is renderer/index.html',
  );
});
