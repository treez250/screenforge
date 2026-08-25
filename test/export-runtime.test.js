'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { materializeFilterComplexArgs } = require('../export-runtime');

test('keeps compact filter graphs inline', () => {
  const input = ['-i', 'input.mp4', '-filter_complex', '[0:v]null[vout]', '-map', '[vout]'];
  const runtime = materializeFilterComplexArgs(input, { threshold: 1024 });
  assert.deepEqual(runtime.args, input);
  assert.equal(runtime.scriptPath, null);
  runtime.cleanup();
});

test('materializes oversized filter graphs in a private, disposable script', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-runtime-test-'));
  const graph = `[0:v]${'null,'.repeat(200)}null[vout]`;
  const input = ['-i', 'input.mp4', '-filter_complex', graph, '-map', '[vout]'];
  let runtime;

  try {
    runtime = materializeFilterComplexArgs(input, { threshold: 64, tempRoot });
    assert.ok(runtime.scriptPath);
    assert.equal(runtime.args.includes('-filter_complex'), false);
    assert.equal(runtime.args[runtime.args.indexOf('-filter_complex_script') + 1], runtime.scriptPath);
    assert.equal(fs.readFileSync(runtime.scriptPath, 'utf8'), graph);
    assert.equal(fs.statSync(runtime.scriptPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(runtime.scriptPath)).mode & 0o777, 0o700);
    runtime.cleanup();
    runtime.cleanup();
    assert.equal(fs.existsSync(runtime.scriptPath), false);
  } finally {
    runtime?.cleanup();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('moves a 1.7 MiB long-form graph out of argv before process spawn', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-runtime-spawn-'));
  const graph = `[0:v]${'null,'.repeat(340000)}null[vout]`;
  const input = ['-hide_banner', '-filter_complex', graph, '-map', '[vout]'];
  let runtime;

  try {
    assert.ok(Buffer.byteLength(graph, 'utf8') > 1.6 * 1024 * 1024);
    runtime = materializeFilterComplexArgs(input, { threshold: 64 * 1024, tempRoot });
    assert.ok(runtime.scriptPath);
    assert.ok(runtime.args.every(argument => Buffer.byteLength(argument, 'utf8') < 64 * 1024));
    const spawned = spawnSync('/usr/bin/true', runtime.args, { encoding: 'utf8' });
    assert.equal(spawned.error, undefined);
    assert.equal(spawned.status, 0, spawned.stderr || spawned.stdout);
  } finally {
    runtime?.cleanup();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
