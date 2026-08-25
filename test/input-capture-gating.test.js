/**
 * Guard: global input capture must never run outside an active recording.
 *
 * uiohook taps every keystroke and click on the whole machine. A build that
 * starts it at launch logs passwords typed into other apps for as long as
 * ScreenForge is open, and feeds them to the renderer where they become
 * shortcut badges burned into exported video.
 *
 * The hook may therefore only be started from the 'recording-started' path.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('uIOhook.start() is only reachable via startInputHook()', () => {
  const starts = main.match(/uIOhook\.start\(\)/g) || [];
  assert.strictEqual(starts.length, 1, 'expected exactly one uIOhook.start() call site');

  const fnStart = main.indexOf('function startInputHook()');
  assert.ok(fnStart !== -1, 'startInputHook() must exist');

  // The single start() call must sit inside startInputHook's body.
  const callAt = main.indexOf('uIOhook.start()');
  const nextFnAt = main.indexOf('\nfunction ', fnStart + 1);
  assert.ok(
    callAt > fnStart && (nextFnAt === -1 || callAt < nextFnAt),
    'uIOhook.start() must live inside startInputHook()',
  );
});

test('startInputHook is invoked from recording-started, not window creation', () => {
  assert.ok(
    /onFrom\('main', 'recording-started'[\s\S]{0,200}?startInputHook\(\)/.test(main),
    'recording-started handler must call startInputHook()',
  );
  assert.ok(
    /onFrom\('main', 'recording-stopped'[\s\S]{0,200}?stopInputHook\(\)/.test(main),
    'recording-stopped handler must call stopInputHook()',
  );
});

test('listener callbacks bail out when the hook is not running', () => {
  const bindAt = main.indexOf('function bindInputHookListeners()');
  assert.ok(bindAt !== -1, 'bindInputHookListeners() must exist');
  const body = main.slice(bindAt, bindAt + 2000);
  const guards = body.match(/if \(!inputHookRunning\) return;/g) || [];
  assert.strictEqual(guards.length, 2, 'both mousedown and keydown must guard on inputHookRunning');
});
