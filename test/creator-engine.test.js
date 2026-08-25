'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DIRECTOR_PROFILES,
  normalizeRanges,
  subtractRange,
  silencesToRemovals,
  isTimeRemoved,
  removedDuration,
  outputDuration,
  sourceToOutputTime,
  mapInterval,
  splitVisibleInterval,
  splitCursorPath,
  generateDirectorKeyframes,
} = require('../renderer/creator-engine.js');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

test('normalizeRanges clamps, merges, filters, and does not mutate input', () => {
  const ranges = deepFreeze([
    { start: -2, end: 1 },
    { start: 0.8, end: 2 },
    { start: 4, end: 4.1 },
    { start: 8, end: 12 },
    { start: 7, end: 6 },
  ]);

  assert.deepEqual(
    normalizeRanges(ranges, { start: 0, end: 10, minDuration: 0.5 }),
    [
      { start: 0, end: 2 },
      { start: 8, end: 10 },
    ],
  );
  assert.equal(ranges[0].start, -2);
});

test('normalizeRanges preserves shared provenance and marks mixed merges', () => {
  assert.deepEqual(
    normalizeRanges([
      { start: 0, end: 2, source: 'silence' },
      { start: 1, end: 3, source: 'silence' },
      { start: 5, end: 7, source: 'manual' },
      { start: 6, end: 8, source: 'silence' },
    ]),
    [
      { start: 0, end: 3, source: 'silence' },
      { start: 5, end: 8, source: 'mixed' },
    ],
  );
});

test('subtractRange removes an interval and retains valid fragments', () => {
  const ranges = deepFreeze([
    { start: 0, end: 5 },
    { start: 6, end: 10 },
  ]);
  const removed = deepFreeze({ start: 2, end: 8 });

  assert.deepEqual(
    subtractRange(ranges, removed, { start: 0, end: 10, minDuration: 0.5 }),
    [
      { start: 0, end: 2 },
      { start: 8, end: 10 },
    ],
  );
});

test('silencesToRemovals preserves padding around speech and clamps to trim', () => {
  const silences = deepFreeze([
    { start: -1, end: 1 },
    { start: 2, end: 4 },
    { start: 4.1, end: 4.5 },
  ]);

  assert.deepEqual(
    silencesToRemovals(silences, {
      start: 0,
      end: 5,
      padding: 0.25,
      minDuration: 0.5,
    }),
    [
      { start: 0, end: 0.75, source: 'silence' },
      { start: 2.25, end: 3.75, source: 'silence' },
    ],
  );
});

test('removal queries use merged half-open ranges', () => {
  const ranges = [
    { start: 2, end: 5 },
    { start: 4, end: 7 },
    { start: 9, end: 12 },
  ];

  assert.equal(isTimeRemoved(2, ranges), true);
  assert.equal(isTimeRemoved(6.5, ranges), true);
  assert.equal(isTimeRemoved(7, ranges), false);
  assert.equal(removedDuration(ranges, { start: 0, end: 10 }), 6);
});

test('duration and source time mapping collapse removals and apply speed', () => {
  const context = {
    trimIn: 10,
    trimOut: 30,
    removedRanges: [
      { start: 12, end: 15 },
      { start: 20, end: 22 },
    ],
  };

  assert.equal(outputDuration({ ...context, speedMultiplier: 2 }), 7.5);
  assert.equal(sourceToOutputTime(9, context), 0);
  assert.equal(sourceToOutputTime(14, context), 2);
  assert.equal(sourceToOutputTime(18, context), 5);
  assert.equal(sourceToOutputTime(31, context), 15);
  assert.deepEqual(mapInterval(11, 23, { ...context, speedMultiplier: 2 }), {
    start: 0.5,
    end: 4,
    duration: 3.5,
  });
  assert.equal(mapInterval(12.5, 14, context), null);
});

test('splitVisibleInterval preserves source effect phase across removed ranges', () => {
  const context = deepFreeze({
    trimIn: 0,
    trimOut: 8,
    removedRanges: [{ start: 2, end: 4 }],
  });

  assert.deepEqual(splitVisibleInterval(2.5, 4.5, context), [
    {
      sourceStart: 4,
      sourceEnd: 4.5,
      start: 2,
      end: 2.5,
      duration: 0.5,
      phaseOffset: 1.5,
    },
  ]);
  assert.deepEqual(context.removedRanges, [{ start: 2, end: 4 }]);
});

test('splitCursorPath interpolates both sides of a cut as a hard output seam', () => {
  const points = deepFreeze([
    { time: 0, xPct: 0, yPct: 0.2, pressure: 0.5 },
    { time: 10, xPct: 1, yPct: 0.8, pressure: 0.9 },
  ]);

  const segments = splitCursorPath(points, {
    trimIn: 0,
    trimOut: 10,
    removedRanges: [{ start: 4, end: 6 }],
  });

  assert.equal(segments.length, 2);
  assert.deepEqual(
    segments.map((segment) => ({
      sourceStart: segment.sourceStart,
      sourceEnd: segment.sourceEnd,
      start: segment.start,
      end: segment.end,
    })),
    [
      { sourceStart: 0, sourceEnd: 4, start: 0, end: 4 },
      { sourceStart: 6, sourceEnd: 10, start: 4, end: 8 },
    ],
  );

  const preSeam = segments[0].points.at(-1);
  const postSeam = segments[1].points[0];
  assert.deepEqual(
    { sourceTime: preSeam.sourceTime, time: preSeam.time, xPct: preSeam.xPct },
    { sourceTime: 4, time: 4, xPct: 0.4 },
  );
  assert.deepEqual(
    { sourceTime: postSeam.sourceTime, time: postSeam.time, xPct: postSeam.xPct },
    { sourceTime: 6, time: 4, xPct: 0.6 },
  );
  assert.equal(preSeam.yPct, 0.44);
  assert.equal(postSeam.yPct, 0.56);
  assert.deepEqual(points, [
    { time: 0, xPct: 0, yPct: 0.2, pressure: 0.5 },
    { time: 10, xPct: 1, yPct: 0.8, pressure: 0.9 },
  ]);
});

test('director profiles create observably different pacing', () => {
  const events = {
    clicks: [
      { time: 1, xPct: 0.2, yPct: 0.3 },
      { time: 2.2, xPct: 0.24, yPct: 0.32 },
      { time: 5, xPct: 0.7, yPct: 0.4 },
    ],
    keys: [],
  };

  const calm = generateDirectorKeyframes({ events, profile: 'calm', trimIn: 0, trimOut: 10 });
  const energetic = generateDirectorKeyframes({ events, profile: 'energetic', trimIn: 0, trimOut: 10 });

  assert.ok(DIRECTOR_PROFILES.calm.minShotDuration > DIRECTOR_PROFILES.energetic.minShotDuration);
  assert.ok(calm.length < energetic.length);
  assert.ok(calm.every((shot) => shot.duration >= DIRECTOR_PROFILES.calm.minShotDuration));
  assert.ok(energetic.every((shot) => shot.duration >= DIRECTOR_PROFILES.energetic.minShotDuration));
});

test('director dedupes rapid clicks and groups nearby interactions into stable shots', () => {
  const keyframes = generateDirectorKeyframes({
    events: {
      clicks: [
        { time: 1, xPct: 0.2, yPct: 0.3 },
        { time: 1.1, xPct: 0.21, yPct: 0.31 },
        { time: 1.8, xPct: 0.25, yPct: 0.34 },
        { time: 5, xPct: 0.75, yPct: 0.45 },
      ],
      keys: [
        { time: 2.1, label: 'ignored content' },
      ],
    },
    profile: 'tutorial',
    trimIn: 0,
    trimOut: 10,
    zoomLevel: 2.25,
  });

  assert.equal(keyframes.length, 2);
  assert.equal(keyframes[0].zoomLevel, 2.25);
  assert.ok(keyframes[0].time <= 1);
  assert.ok(keyframes[0].time + keyframes[0].duration >= 2.1);
});

test('director keeps focus outside webcam and caption safe zones', () => {
  const bottomRight = generateDirectorKeyframes({
    events: { clicks: [{ time: 4, xPct: 0.96, yPct: 0.95 }], keys: [] },
    profile: 'tutorial',
    trimIn: 0,
    trimOut: 10,
    webcamPos: 'br',
    captions: true,
  })[0];
  const topLeft = generateDirectorKeyframes({
    events: { clicks: [{ time: 4, xPct: 0.02, yPct: 0.04 }], keys: [] },
    profile: 'tutorial',
    trimIn: 0,
    trimOut: 10,
    webcamPos: 'tl',
    captions: false,
  })[0];

  assert.ok(bottomRight.xPct <= 0.68);
  assert.ok(bottomRight.yPct <= 0.72);
  assert.ok(topLeft.xPct >= 0.32);
});

test('director caps shots within trim while preserving profile minimum duration', () => {
  const shots = generateDirectorKeyframes({
    events: { clicks: [{ time: 9.8, xPct: 0.5, yPct: 0.5 }], keys: [] },
    profile: 'calm',
    trimIn: 0,
    trimOut: 10,
  });

  assert.equal(shots.length, 1);
  assert.equal(shots[0].time + shots[0].duration, 10);
  assert.ok(shots[0].duration >= DIRECTOR_PROFILES.calm.minShotDuration);
});

test('director is deterministic, ignores key content, and does not mutate events', () => {
  const base = {
    clicks: [
      { time: 1.5, xPct: 0.3, yPct: 0.4 },
      { time: 3.1, xPct: 0.35, yPct: 0.42 },
    ],
    keys: [
      { time: 3.4, label: 'private typed text' },
    ],
    cursor: [
      { time: 1.5, xPct: 0.3, yPct: 0.4 },
    ],
  };
  const events = deepFreeze(structuredClone(base));
  const changedContent = structuredClone(base);
  changedContent.keys[0].label = 'completely different content';
  const options = { profile: 'tutorial', trimIn: 0, trimOut: 8, webcamPos: 'none', captions: false };

  const first = generateDirectorKeyframes({ events, ...options });
  const second = generateDirectorKeyframes({ events, ...options });
  const contentChanged = generateDirectorKeyframes({ events: changedContent, ...options });

  assert.deepEqual(first, second);
  assert.deepEqual(first, contentChanged);
  assert.ok(first.every((shot) => Number.isFinite(shot.id)));
  assert.ok(first.every((shot) => shot.source === 'action-director'));
  assert.deepEqual(events, base);
});
