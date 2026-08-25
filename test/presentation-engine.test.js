'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  backgroundCameraGeometry,
  mapSourcePoint,
  normalizePresentation,
  presentationGeometry,
} = require('../renderer/presentation-engine');

test('normalizes presentation settings and preserves even dimensions', () => {
  assert.deepEqual(normalizePresentation({
    width: 1921,
    height: 1081,
    styled: true,
    mode: 'solid',
    colors: ['bad', '#ABCDEF'],
    solidColor: '#102030',
    padding: 9,
    blur: -1,
    frame: true,
  }), {
    width: 1920,
    height: 1080,
    sourceWidth: 1920,
    sourceHeight: 1080,
    styled: true,
    mode: 'solid',
    colors: ['#2563eb', '#abcdef'],
    solidColor: '#102030',
    padding: 0.22,
    blur: 0,
    frame: true,
  });
});

test('maps source points through the exact padded presentation rectangle', () => {
  const presentation = { width: 1920, height: 1080, styled: true, padding: 0.1, frame: true };
  const geometry = presentationGeometry(presentation, 1600, 900);
  const center = mapSourcePoint(presentation, 1600, 900, 0.5, 0.5);
  assert.equal(center.xPct, 0.5);
  assert.ok(center.yPct > 0.5, 'titlebar shifts video content slightly downward');
  assert.ok(geometry.videoWidth < 1920);
  assert.ok(geometry.videoHeight < 1080);
  assert.ok(geometry.cornerRadius >= 6);
});

test('keeps a landscape recording as a centered window in vertical output', () => {
  const presentation = {
    width: 1080,
    height: 1920,
    sourceWidth: 1920,
    sourceHeight: 1080,
    styled: true,
    padding: 0.05,
    frame: true,
  };
  const geometry = presentationGeometry(presentation, 1920, 1080);
  assert.ok(geometry.videoWidth > geometry.videoHeight);
  assert.ok(geometry.frameBoxHeight < 900);
  assert.equal(geometry.boxX, (1080 - geometry.innerWidth) / 2);
  assert.equal(geometry.boxY, (1920 - geometry.frameBoxHeight) / 2);
});

test('applies source camera crop before presentation cover geometry', () => {
  const geometry = backgroundCameraGeometry(1920, 1080, 1080, 1920, {
    scale: 2,
    xPct: 0.8,
    yPct: 0.5,
  });
  const visibleStart = -geometry.left / geometry.width;
  const visibleEnd = (1080 - geometry.left) / geometry.width;
  assert.ok(Math.abs(visibleStart - 0.5708984375) < 0.0001);
  assert.ok(Math.abs(visibleEnd - 0.7291015625) < 0.0001);
});
