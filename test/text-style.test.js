'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ffmpegPath = require('ffmpeg-static');
const { drawtextFontFile, ffFilterPath, ffText, previewFontFamily, supportsBold } = require('../renderer/text-style');

test('maps supported CSS font choices to concrete macOS style variants', () => {
  assert.match(drawtextFontFile('Arial, sans-serif', false, false), /Arial\.ttf$/);
  assert.match(drawtextFontFile('Georgia, serif', true, false), /Georgia Bold\.ttf$/);
  assert.match(drawtextFontFile('Courier New, monospace', false, true), /Courier New Italic\.ttf$/);
  assert.match(drawtextFontFile('Inter, sans-serif', true, true), /Arial Bold Italic\.ttf$/);
  assert.equal(ffFilterPath("a'b\\c"), "a\\'b\\\\c");
  assert.equal(previewFontFamily('Inter, sans-serif', true, true), 'Arial, sans-serif');
  assert.equal(previewFontFamily('Georgia, serif', false, false), 'Georgia, serif');
  assert.equal(previewFontFamily('Impact, sans-serif', false, true), 'Arial, sans-serif');
  assert.equal(supportsBold('Impact, sans-serif'), false);
  assert.equal(supportsBold('Arial, sans-serif'), true);
  assert.equal(drawtextFontFile('Impact, sans-serif', true, false), drawtextFontFile('Impact, sans-serif', false, false));
});

test('bundled FFmpeg renders bold italic text and literal percentages', { timeout: 30000 }, t => {
  const fontFile = drawtextFontFile('Arial', true, true);
  if (!fs.existsSync(fontFile)) {
    t.skip('macOS supplemental fonts are unavailable on this host');
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-drawtext-test-'));
  const outputPath = path.join(tempDir, 'text.png');
  try {
    const filter = `drawtext=text='100% ready':expansion=none:fontfile='${ffFilterPath(fontFile)}':fontsize=32:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`;
    const result = spawnSync(ffmpegPath, [
      '-hide_banner', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=0.1',
      '-vf', filter,
      '-frames:v', '1', outputPath,
    ], { encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(/Stray %/.test(result.stderr), false, result.stderr);
    assert.ok(fs.statSync(outputPath).size > 500);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('inline drawtext preserves common punctuation exactly', { timeout: 30000 }, t => {
  const fontFile = drawtextFontFile('Arial', false, false);
  if (!fs.existsSync(fontFile)) {
    t.skip('macOS supplemental fonts are unavailable on this host');
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-drawtext-escape-'));
  const samples = [
    "Here's: v2 [beta] \\ path, 100% = good; yes",
    'All punctuation !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
    'A path ending in a backslash \\',
  ];
  try {
    const render = filter => spawnSync(ffmpegPath, [
      '-hide_banner', '-nostdin', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=1400x80:d=0.1',
      '-vf', filter, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-',
    ], { timeout: 20000, maxBuffer: 16 * 1024 * 1024 });

    samples.forEach((sample, index) => {
      const textPath = path.join(tempDir, `expected-${index}.txt`);
      fs.writeFileSync(textPath, sample);
      const style = `:expansion=none:fontfile='${ffFilterPath(fontFile)}':fontsize=20:fontcolor=white:x=4:y=4`;
      const inline = render(`drawtext=text=${ffText(sample)}${style}`);
      const oracle = render(`drawtext=textfile='${ffFilterPath(textPath)}'${style}`);
      assert.equal(inline.status, 0, inline.stderr?.toString() || inline.stdout?.toString());
      assert.equal(oracle.status, 0, oracle.stderr?.toString() || oracle.stdout?.toString());
      assert.deepEqual(inline.stdout, oracle.stdout);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
