/**
 * Guard: process-level failures must be caught, logged, and surfaced.
 *
 * Without these hooks an unhandled rejection in any async IPC handler, or a dead
 * renderer/child process, takes the app down or zombies it with no log line and
 * nothing shown to the user. The failure is invisible, so it reads as "flaky".
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');

test('all four process/app crash guards are installed', () => {
  for (const hook of ['uncaughtException', 'unhandledRejection', 'render-process-gone', 'child-process-gone']) {
    assert.ok(main.includes(`'${hook}'`), `missing crash guard for ${hook}`);
  }
});

test('crash guards no-op outside the main process', () => {
  assert.ok(
    /function installCrashGuards\(\)\s*\{[\s\S]{0,400}?if \(process\.type !== 'browser'\) return;/.test(main),
    'installCrashGuards must bail unless process.type is browser',
  );
});

test('IPC wrapper keeps the sender check outside the try and re-throws', () => {
  const at = main.indexOf('function handleFrom(');
  const body = main.slice(at, at + 900);
  const assertAt = body.indexOf('assertIpcSender(event, role);');
  const tryAt = body.indexOf('try {');
  assert.ok(assertAt !== -1 && tryAt !== -1, 'expected both the sender check and a try block');
  assert.ok(assertAt < tryAt, 'assertIpcSender must run before the try block');
  assert.ok(body.includes('throw err;'), 'handler failures must re-throw to preserve reject semantics');
});

test('only the centralized wrapper calls ipcMain.handle', () => {
  assert.equal((main.match(/ipcMain\.handle\(/g) || []).length, 1);
});

test('faults reach the renderer out-of-band', () => {
  assert.ok(main.includes("'main-error'"), 'main must emit main-error');
  assert.ok(preload.includes("ipcRenderer.on('main-error'"), 'preload must expose main-error');
  assert.ok(renderer.includes('installRendererFaultHooks'), 'renderer must install fault hooks');
  assert.ok(renderer.includes("addEventListener('unhandledrejection'"), 'renderer must catch unhandled rejections');
});

test('fatal paths reap child processes', () => {
  assert.ok(/function reapChildProcesses/.test(main), 'reapChildProcesses must exist');
  assert.ok(/reapChildProcesses\('uncaughtException'\)/.test(main), 'uncaughtException must reap children');
});
