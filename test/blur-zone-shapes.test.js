/**
 * Privacy blur zones: small targets and shapes.
 *
 * The feature existed but could not do the job people actually need it for -
 * covering one account number, not a quarter of the screen. The default zone was
 * 30% x 20% of the frame (~576x216px at 1080p) and the editor refused to shrink
 * below 4% (~77x43px), which is taller than a line of text. The export side
 * already accepted 0.1%, so the UI clamp was the only obstacle.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'export-engine.js'), 'utf8');

test('zones can shrink small enough to cover a single field', () => {
  const match = renderer.match(/const MIN_BLUR_ZONE_PCT = ([0-9.]+);/);
  assert.ok(match, 'MIN_BLUR_ZONE_PCT must be defined');
  const min = Number(match[1]);
  assert.ok(min <= 0.01, `minimum zone size ${min} is too coarse for one line of text`);
  // At 1080p this must be able to sit tightly over ~180x22px of text.
  assert.ok(min * 1920 <= 20, 'minimum width must be under 20px at 1080p');
  assert.ok(min * 1080 <= 12, 'minimum height must be under 12px at 1080p');
  assert.equal(renderer.includes('0.04, 1 - zone.xPct'), false, 'old 4% clamp must be gone');
});

test('a new zone starts field-sized, not screen-sized', () => {
  const at = renderer.indexOf('function addBlurZone()');
  const body = renderer.slice(at, at + 900);
  const w = Number(body.match(/wPct: ([0-9.]+)/)[1]);
  const h = Number(body.match(/hPct: ([0-9.]+)/)[1]);
  assert.ok(w <= 0.2, `default width ${w} is too large`);
  assert.ok(h <= 0.1, `default height ${h} is too large`);
});

test('square and circle are constrained to equal pixels, not equal percent', () => {
  const at = renderer.indexOf('function constrainBlurZoneShape');
  assert.ok(at !== -1, 'constrainBlurZoneShape must exist');
  const body = renderer.slice(at, at + 700);
  assert.ok(/aspect = frameW \/ frameH/.test(body), 'must derive height from the frame aspect');
  assert.ok(/if \(shape === 'rect'\) return zone;/.test(body), 'rect must stay free-form');
});

test('shape is allowlisted before it reaches the filtergraph', () => {
  assert.ok(/const BLUR_ZONE_SHAPES = new Set\(\['rect', 'square', 'circle'\]\)/.test(engine));
  assert.ok(/BLUR_ZONE_SHAPES\.has\(rawZone\.shape\) \? rawZone\.shape : 'rect'/.test(engine));
});

test('shape survives a project round trip', () => {
  const at = renderer.indexOf('function normalizeBlurZones');
  const body = renderer.slice(at, at + 1200);
  assert.ok(/shape: BLUR_ZONE_SHAPES\.includes\(raw\.shape\)/.test(body), 'normalize must preserve shape');
});

test('the editor exposes all three shapes', () => {
  for (const id of ['blurShapeRect', 'blurShapeSquare', 'blurShapeCircle']) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
  assert.ok(html.includes('aria-label="Privacy blur zone shape"'), 'shape group needs a label');
});

test('the circle mask filtergraph is accepted by the bundled ffmpeg', () => {
  const ffmpeg = require('ffmpeg-static');
  const out = path.join(require('node:os').tmpdir(), `sf-circle-${process.pid}.mp4`);
  // A square-in-pixels region, which is what the editor enforces for a circle.
  const graph = "[0:v]split=2[k][c];"
    + "[c]crop=w=iw*0.15:h=ih*0.26667:x=iw*0.425:y=ih*0.36667,"
    + "boxblur=luma_radius='min(30\\,min(w\\,h)/2)':luma_power=1:"
    + "chroma_radius='min(30\\,min(cw\\,ch)/2)':chroma_power=1,"
    + "format=yuva420p,geq=lum='p(X\\,Y)':cb='p(X\\,Y)':cr='p(X\\,Y)':"
    + "a='if(lte(pow((X-W/2)/(W/2)\\,2)+pow((Y-H/2)/(H/2)\\,2)\\,1)\\,255\\,0)'[b];"
    + "[k][b]overlay=x=main_w*0.425:y=main_h*0.36667[vout]";
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=1',
    '-filter_complex', graph, '-map', '[vout]', '-frames:v', '3', '-y', out,
  ], { encoding: 'utf8' });
  try {
    assert.equal(result.status, 0, `ffmpeg rejected the circle mask: ${result.stderr}`);
    assert.ok(fs.statSync(out).size > 0, 'circle mask produced no output');
  } finally {
    try { fs.unlinkSync(out); } catch {}
  }
});
