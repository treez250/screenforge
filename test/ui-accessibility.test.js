'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const areaPicker = fs.readFileSync(path.join(root, 'renderer', 'area-picker.html'), 'utf8');
const floatbar = fs.readFileSync(path.join(root, 'renderer', 'floatbar.html'), 'utf8');
const appleCss = fs.readFileSync(path.join(root, 'renderer', 'apple.css'), 'utf8');

test('area picker supports keyboard adjustment and explicit completion', () => {
  assert.match(areaPicker, /role="dialog" aria-modal="true"/);
  assert.match(areaPicker, /Shift plus Arrow keys resize it/);
  assert.match(areaPicker, /id="cancelBtn"[^>]*aria-keyshortcuts="Escape"/);
  assert.match(areaPicker, /id="confirmBtn"[^>]*aria-keyshortcuts="Enter"/);
  assert.match(areaPicker, /\['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'\]/);
  assert.match(areaPicker, /window\.sf\?\.areaSelected/);
  assert.match(areaPicker, /window\.sf\?\.areaCanceled/);
});

test('editor shortcuts preserve native control and modal keyboard behavior', () => {
  assert.match(app, /if \(e\.defaultPrevented\) return/);
  assert.match(app, /target\?\.closest\('button, a, input, textarea, select, summary/);
  assert.match(app, /DIALOG_IDS\.some/);
  assert.match(app, /'libraryPanel'/);
});

test('clip library is a managed modal with focus entry, trap, escape, and restore', () => {
  assert.match(index, /id="libraryPanel"[^>]*role="dialog"[^>]*aria-modal="true"/s);
  assert.match(index, /aria-labelledby="libraryDialogTitle"/);
  assert.match(index, /id="libraryCloseBtn"[^>]*aria-label="Close clip library"/s);
  assert.match(app, /openAccessibleDialog\('libraryPanel', 'libraryCloseBtn'\)/);
  assert.match(app, /dialogReturnFocus/);
  assert.match(app, /event\.key !== 'Tab'/);
  assert.match(app, /dialog\.id === 'libraryPanel'\) hideLibraryPanel\(\)/);
});

test('dynamic background and cut controls use native button semantics', () => {
  assert.match(app, /<button type="button" class="bg-swatch/);
  assert.match(app, /<button type="button" class="insp-bg-thumb/);
  assert.match(app, /data-preset-index/);
  assert.match(index, /class="solid-bg-swatch[^>]*aria-label="Use black background"[^>]*aria-pressed="false"/s);
  assert.match(app, /syncSolidBackgroundControls/);
  assert.match(app, /<button type="button" class="cut-marker"/);
  assert.match(app, /aria-label="Remove cut at/);
  assert.doesNotMatch(app, /<div class="cut-marker"/);
});

test('dynamic keyframes provide named keyboard removal controls', () => {
  assert.match(app, /<button type="button" style="position:absolute;left:\$\{pct\}%/);
  assert.match(app, /class="keyframe-dot"[^>]*aria-label="Remove \$\{safeLabel\}"/s);
  assert.match(app, /aria-label="\$\{escapeHtml\(label\)\}"/);
  assert.doesNotMatch(app, /<div[^>]*class="keyframe-dot"/s);
});

test('stateful editor controls keep accessible values synchronized', () => {
  assert.match(app, /\['trimLeft', 'mtHandleIn'\]/);
  assert.match(app, /\['trimRight', 'mtHandleOut'\]/);
  assert.match(app, /btn\.setAttribute\('aria-pressed', String\(Boolean\(S\.textStyle\[key\]\)\)\)/);
  assert.match(app, /posBtn\.setAttribute\('aria-pressed', 'true'\)/);
  assert.match(app, /c\.setAttribute\('aria-pressed', String\(selected\)\)/);
  assert.match(app, /control\.setAttribute\('aria-checked', String\(enabled\)\)/);
});

test('active recorder, editor, export, and text fields have durable accessible names', () => {
  const expectedNames = new Map([
    ['webcamPos', 'Webcam position'],
    ['webcamShape', 'Webcam shape'],
    ['camDeviceSelect', 'Camera device'],
    ['micDeviceSelect', 'Microphone device'],
    ['fpsSelect', 'Recording frame rate'],
    ['qualitySelect', 'Recording quality'],
    ['countdownSelect', 'Recording countdown'],
    ['remoteUrlText', 'Remote control URL'],
    ['speedSelect', 'Preview playback speed'],
    ['bgSolidColor', 'Solid background color'],
    ['brightness', 'Brightness'],
    ['contrast', 'Contrast'],
    ['saturation', 'Saturation'],
    ['exportFormat', 'Export format'],
    ['exportRes', 'Export resolution'],
    ['exportQuality', 'Export quality'],
    ['watermarkText', 'Watermark text'],
    ['watermarkPosition', 'Watermark position'],
    ['watermarkOpacity', 'Watermark opacity'],
    ['textContent', 'Text overlay content'],
    ['textFont', 'Text font'],
    ['textSize', 'Text size'],
    ['textColor', 'Text color'],
    ['textBgColor', 'Text background color'],
    ['textBgOpacity', 'Text background opacity'],
    ['textAnim', 'Text animation'],
    ['textStartTime', 'Text start time'],
    ['textDuration', 'Text duration'],
    ['textFadeIn', 'Text fade in duration'],
    ['textFadeOut', 'Text fade out duration'],
  ]);

  for (const [id, accessibleName] of expectedNames) {
    const tag = index.match(new RegExp(
      `<(?:input|select|textarea)\\b[^>]*\\bid="${id}"[^>]*>`,
      's',
    ));
    assert.ok(tag, `expected form control #${id}`);
    assert.match(tag[0], new RegExp(`\\baria-label="${accessibleName}"`));
  }
});

test('reduced motion and source-label contrast are explicitly honored', () => {
  assert.match(app, /prefers-reduced-motion: reduce/);
  assert.match(app, /if \(prefersReducedMotion\(\)\)/);
  assert.match(floatbar, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(floatbar, /reducedMotion\?\.matches/);
  assert.match(app, /isSelected \? '\.92' : '\.72'/);
  assert.match(appleCss, /\.src-card:not\(\.selected\) > div:last-child p/);
  assert.match(appleCss, /color: #fcd34d !important/);
  assert.match(appleCss, /color: #c4b5fd !important/);
  assert.match(appleCss, /color: #fca5a5 !important/);
  assert.match(appleCss, /color: #a5b4fc !important/);
  assert.match(appleCss, /color: #6ee7b7 !important/);
  assert.match(app, /k\.type === 'key' \? '#a5b4fc' : k\.type === 'marker' \? '#c4b5fd' : '#fca5a5'/);
});

test('source permission recovery is actionable and never exposes Electron IPC errors', () => {
  assert.match(app, /Screen Recording Required/);
  assert.match(app, /openScreenRecordingSettings/);
  assert.match(app, /Open System Settings/);
  assert.match(app, /Quit and reopen ScreenForge/);
  assert.doesNotMatch(app, /escapeHtml\(e\.message\)/);
});
