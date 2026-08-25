'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const {
  buildPathChunks,
  chunkEnableExpression,
  cursorRenderSpec,
  samplePoints,
  samplingLimit,
  samplePointSegments,
} = require('../renderer/cursor-engine');

test('shared cursor geometry matches bundled FFmpeg pixel bounds', () => {
  const spec = cursorRenderSpec(1);
  assert.deepEqual(spec, {
    diameter: 23,
    dotDiameter: 12,
    borderWidth: 4,
    ffFontSize: 32,
    ffBorderWidth: 4,
    trailOffset: 3,
  });
  const filter = `drawtext=text='●':expansion=none:fontfile='/System/Library/Fonts/Supplemental/Arial Bold.ttf':`
    + `fontsize=${spec.ffFontSize}:fontcolor=white:borderw=${spec.ffBorderWidth}:bordercolor=0x5eead4FF:`
    + 'x=(w-text_w)/2:y=(h-text_h)/2';
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-v', 'error', '-f', 'lavfi',
    '-i', 'color=c=black:s=96x96:d=0.1',
    '-vf', filter, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { encoding: null, timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString() || 'FFmpeg cursor probe failed');

  let minX = 96; let minY = 96; let maxX = -1; let maxY = -1;
  let whiteMinX = 96; let whiteMinY = 96; let whiteMaxX = -1; let whiteMaxY = -1;
  for (let y = 0; y < 96; y += 1) {
    for (let x = 0; x < 96; x += 1) {
      const offset = (y * 96 + x) * 3;
      const red = result.stdout[offset];
      const green = result.stdout[offset + 1];
      const blue = result.stdout[offset + 2];
      if (red + green + blue > 30) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      if (red > 220 && green > 220 && blue > 220) {
        whiteMinX = Math.min(whiteMinX, x); whiteMinY = Math.min(whiteMinY, y);
        whiteMaxX = Math.max(whiteMaxX, x); whiteMaxY = Math.max(whiteMaxY, y);
      }
    }
  }
  assert.ok(maxX - minX + 1 >= 22 && maxX - minX + 1 <= 24);
  assert.ok(maxY - minY + 1 >= 21 && maxY - minY + 1 <= 23);
  assert.equal(whiteMaxX - whiteMinX + 1, spec.dotDiameter);
  assert.equal(whiteMaxY - whiteMinY + 1, spec.dotDiameter);
});

test('samples the entire cursor history instead of truncating long recordings', () => {
  const input = Array.from({ length: 5000 }, (_, index) => ({
    time: index * 0.12,
    xPct: (index % 100) / 100,
    yPct: ((index * 3) % 100) / 100,
  }));
  const sampled = samplePoints(input, 720);
  assert.equal(sampled.length, 720);
  assert.equal(sampled[0], input[0]);
  assert.equal(sampled.at(-1), input.at(-1));

  const chunks = buildPathChunks(input, { maximum: 720, chunkSize: 90 });
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1).end, input.at(-1).time);
  assert.ok(chunks.length <= 9);
});

test('retains native cursor cadence for long-form recordings within the safe graph budget', () => {
  const points = Array.from({ length: 5000 }, (_, index) => ({
    time: index * 0.12,
    xPct: (index % 200) / 200,
    yPct: ((index * 7) % 200) / 200,
  }));
  const maximum = samplingLimit(points);
  assert.equal(maximum, 5000);
  const chunks = buildPathChunks(points, { maximum, chunkSize: 90 });
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1).end, points.at(-1).time);
  const expressionBytes = Buffer.byteLength(chunks.map(chunk => (
    chunk.xExpression + chunk.yExpression
  )).join(''), 'utf8');
  assert.ok(expressionBytes < 1024 * 1024, `cursor expressions grew to ${expressionBytes} bytes`);
});

test('adjacent cursor chunks never render a ghost cursor at their seam', () => {
  const points = Array.from({ length: 180 }, (_, index) => ({
    time: index * 0.12,
    xPct: index / 180,
    yPct: 0.5,
  }));
  const chunks = buildPathChunks(points, { maximum: points.length, chunkSize: 90 });
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].end, chunks[1].start);
  assert.equal(chunks[0].endExclusive, true);

  const sampleTime = chunks[1].start - 0.03;
  assert.equal(chunks.filter(chunk => sampleTime >= chunk.start && sampleTime <= chunk.end).length, 1);
  const font = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
  const draw = chunk => `drawtext=text='●':expansion=none:fontfile='${font}':fontsize=18:fontcolor=white:`
    + `x='w*(${chunk.xExpression})-text_w/2':y='h*(${chunk.yExpression})-text_h/2':`
    + `enable='${chunkEnableExpression(chunk)}'`;
  const frameHash = filters => {
    const result = spawnSync(ffmpegPath, [
      '-hide_banner', '-v', 'error', '-f', 'lavfi',
      '-i', 'color=c=black:s=320x180:r=30:d=0.1',
      '-vf', `setpts=PTS+${sampleTime.toFixed(3)}/TB,${filters}`,
      '-frames:v', '1', '-f', 'framemd5', '-',
    ], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim().split(/\r?\n/).filter(line => !line.startsWith('#')).at(-1);
  };

  assert.equal(frameHash(chunks.map(draw).join(',')), frameHash(draw(chunks[0])));
});

test('half-open chunk ownership has no missing or doubled long-form frames', () => {
  const points = Array.from({ length: 10000 }, (_, index) => ({
    time: index * (1200 / 9999),
    xPct: (index % 320) / 320,
    yPct: ((index * 7) % 180) / 180,
  }));
  const chunks = buildPathChunks(points, { maximum: points.length, chunkSize: 90 });
  const owns = (chunk, time) => time >= chunk.start
    && (chunk.endExclusive ? time < chunk.end : time <= chunk.end);
  for (const fps of [24, 30, 60]) {
    let cursor = 0;
    for (let frame = 0; frame <= 1200 * fps; frame += 1) {
      const time = frame / fps;
      while (cursor + 1 < chunks.length && time >= chunks[cursor + 1].start) cursor += 1;
      const candidates = [chunks[cursor - 1], chunks[cursor], chunks[cursor + 1]].filter(Boolean);
      assert.equal(candidates.filter(chunk => owns(chunk, time)).length, 1, `cursor ownership at ${fps} fps frame ${frame}`);
    }
  }
});

test('samples cut-separated cursor paths without losing either side of a seam', () => {
  const segments = [
    { start: 0, end: 4, points: Array.from({ length: 100 }, (_, index) => ({ time: index / 25, xPct: index / 250, yPct: 0.2 })) },
    { start: 4, end: 8, points: Array.from({ length: 100 }, (_, index) => ({ time: 4 + index / 25, xPct: 0.6 + index / 250, yPct: 0.8 })) },
  ];
  const sampled = samplePointSegments(segments, 20);
  assert.equal(sampled.reduce((sum, segment) => sum + segment.points.length, 0), 20);
  assert.equal(sampled[0].points[0], segments[0].points[0]);
  assert.equal(sampled[0].points.at(-1), segments[0].points.at(-1));
  assert.equal(sampled[1].points[0], segments[1].points[0]);
  assert.equal(sampled[1].points.at(-1), segments[1].points.at(-1));
});

test('cursor interpolation expressions parse in bundled FFmpeg', () => {
  const points = Array.from({ length: 24 }, (_, index) => ({
    time: index / 30,
    xPct: 0.1 + index / 40,
    yPct: 0.2 + Math.sin(index / 4) * 0.1,
  }));
  const chunk = buildPathChunks(points, { maximum: 90, chunkSize: 90 })[0];
  const filter = `drawtext=text='●':expansion=none:fontfile='/System/Library/Fonts/Supplemental/Arial Bold.ttf':`
    + `fontsize=12:fontcolor=white:x='w*(${chunk.xExpression})-text_w/2':`
    + `y='h*(${chunk.yExpression})-text_h/2':enable='${chunkEnableExpression(chunk)}'`;
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-v', 'error', '-f', 'lavfi',
    '-i', 'color=c=black:s=320x180:r=30:d=1',
    '-vf', filter, '-frames:v', '5', '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
