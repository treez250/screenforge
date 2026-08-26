/**
 * Guard: window capture cannot track click positions, and must say so.
 *
 * serializeCaptureSources() only assigns bounds to 'screen:' sources - macOS does
 * not report where another app's window sits and Electron exposes no API for it.
 * Without bounds, normalizePoint() returns inside:false, so every click is
 * discarded and click zooms, click rings and cursor effects all do nothing.
 *
 * That failure used to be silent, which made a working feature look broken.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('only screen sources are given bounds', () => {
  const at = main.indexOf('function serializeCaptureSources');
  const body = main.slice(at, at + 800);
  assert.ok(/const isScreen = s\.id\.startsWith\('screen:'\);/.test(body));
  assert.ok(/if \(isScreen\) \{/.test(body), 'bounds must remain gated on isScreen');
});

test('the unavailable-tracking condition is centralized', () => {
  assert.ok(
    /function pointerTrackingUnavailable\(\)[\s\S]{0,200}?!S\.selected\.isScreen && !S\.sourceBounds/.test(renderer),
    'pointerTrackingUnavailable() must test for a window source with no bounds',
  );
});

test('the warning names the features that stop working', () => {
  const at = renderer.indexOf('POINTER_TRACKING_WARNING =');
  assert.ok(at !== -1, 'warning constant must exist');
  const text = renderer.slice(at, at + 320).toLowerCase();
  for (const term of ['click zoom', 'display or area']) {
    assert.ok(text.includes(term), `warning must mention "${term}"`);
  }
  assert.ok(
    !/action director tracking/i.test(renderer.slice(at, at + 320)),
    'the old jargon wording must not come back',
  );
});

test('the user is warned on selection, at record start, and after a take with no clicks', () => {
  assert.ok(
    (renderer.match(/showFloatToast\(POINTER_TRACKING_WARNING\)/g) || []).length >= 2,
    'warn both when selecting the source and when recording starts',
  );
  assert.ok(
    /S\.cfg\.zoom && !S\.recEvents\.clicks\.length/.test(renderer),
    'a finished take with zoom on and zero clicks must explain itself',
  );
});
