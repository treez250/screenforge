'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const floatPreload = fs.readFileSync(path.join(root, 'preload-floatbar.js'), 'utf8');
const areaPreload = fs.readFileSync(path.join(root, 'preload-area-picker.js'), 'utf8');

function channels(source, method) {
  return [...source.matchAll(new RegExp(`ipcRenderer\\.${method}\\('([^']+)'`, 'g'))].map(match => match[1]);
}

test('every main preload invocation is registered as main-only IPC', () => {
  const registered = new Set([...main.matchAll(/handleFrom\('main', '([^']+)'/g)].map(match => match[1]));
  for (const channel of channels(preload, 'invoke')) {
    assert.ok(registered.has(channel), `${channel} must be registered through handleFrom('main')`);
  }
  assert.equal((main.match(/ipcMain\.handle\(/g) || []).length, 1, 'only the centralized wrapper may call ipcMain.handle');
});

test('auxiliary preloads expose only their role-specific event channels', () => {
  assert.deepEqual(new Set(channels(floatPreload, 'send')), new Set([
    'float-stop', 'float-pause', 'float-marker', 'float-screenshot',
  ]));
  assert.deepEqual(new Set(channels(areaPreload, 'send')), new Set(['area-selected', 'area-canceled']));
  assert.doesNotMatch(floatPreload + areaPreload, /ipcRenderer\.invoke/);
});

test('main preload omits legacy arbitrary filesystem and auxiliary-window powers', () => {
  const outbound = new Set([...channels(preload, 'invoke'), ...channels(preload, 'send')]);
  for (const channel of [
    'open-folder', 'open-file', 'get-file-size', 'read-srt', 'zoompan-export',
    'reset-settings', 'area-selected', 'area-canceled', 'float-stop', 'float-pause',
    'float-marker', 'float-screenshot',
  ]) {
    assert.equal(outbound.has(channel), false, `${channel} must not be callable from the main preload`);
  }
});

test('settings and media routes preserve main-owned authority', () => {
  assert.match(main, /if \(key !== 'templates'\) throw new Error\('This setting is owned by ScreenForge'\)/);
  assert.match(main, /approvedOutputDirVersion/);
  assert.match(main, /libraryDirApprovedVersion/);
  assert.match(main, /requireGrantedFile\(options\.inputPath, 'media'/);
  assert.match(main, /requireGrantedFile\(srtPath, 'subtitle'/);
  assert.match(main, /uniqueArtifactPath\(/);
  assert.match(main, /const inputMetadata = await mediaFileMetadata\(inputPath\)/);
  assert.match(main, /sourceFrameRate: inputMetadata\.fps/);
  assert.match(main, /return mediaFileMetadata\(safeFilePath\)/);
  assert.doesNotMatch(main, /store\?\.set\(k\s*,/);
});
