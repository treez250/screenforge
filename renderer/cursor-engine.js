(function exposeCursorEngine(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScreenForgeCursorEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createCursorEngine() {
  'use strict';

  const BASE_CURSOR_SPEC = Object.freeze({
    diameter: 23,
    dotDiameter: 12,
    borderWidth: 4,
    ffFontSize: 32,
    ffBorderWidth: 4,
    trailOffset: 3,
  });

  function cursorRenderSpec(rawScale = 1) {
    const value = Number(rawScale);
    const scale = Math.min(3, Math.max(0.5, Number.isFinite(value) ? value : 1));
    return {
      diameter: BASE_CURSOR_SPEC.diameter * scale,
      dotDiameter: BASE_CURSOR_SPEC.dotDiameter * scale,
      borderWidth: BASE_CURSOR_SPEC.borderWidth * scale,
      ffFontSize: Math.max(8, Math.round(BASE_CURSOR_SPEC.ffFontSize * scale)),
      ffBorderWidth: Math.max(1, Math.round(BASE_CURSOR_SPEC.ffBorderWidth * scale)),
      trailOffset: Math.max(1, Math.round(BASE_CURSOR_SPEC.trailOffset * scale)),
    };
  }

  function samplePoints(rawPoints, maximum = 720) {
    const points = Array.isArray(rawPoints) ? rawPoints : [];
    const max = Math.max(2, Math.floor(Number(maximum) || 720));
    if (points.length <= max) return points.slice();
    return Array.from({ length: max }, (_, index) => {
      const sourceIndex = Math.round(index * (points.length - 1) / (max - 1));
      return points[sourceIndex];
    });
  }

  function samplingLimit(rawPoints, options = {}) {
    const points = Array.isArray(rawPoints) ? rawPoints : [];
    const minimum = Math.max(2, Math.floor(Number(options.minimum) || 720));
    const maximum = Math.max(minimum, Math.floor(Number(options.maximum) || 5000));
    const targetInterval = Math.max(0.04, Number(options.targetInterval) || 0.12);
    if (points.length < 2) return minimum;
    const duration = Math.max(0, Number(points.at(-1).time) - Number(points[0].time));
    return Math.min(maximum, Math.max(minimum, Math.ceil(duration / targetInterval) + 1));
  }

  function samplePointSegments(rawSegments, maximum = 5000) {
    const segments = (Array.isArray(rawSegments) ? rawSegments : [])
      .map(segment => ({
        ...segment,
        points: Array.isArray(segment?.points) ? segment.points.slice() : [],
      }))
      .filter(segment => segment.points.length);
    const total = segments.reduce((sum, segment) => sum + segment.points.length, 0);
    const requested = Math.max(2, Math.floor(Number(maximum) || 5000));
    if (total <= requested) return segments;

    const minimums = segments.map(segment => Math.min(segment.points.length, segment.points.length > 1 ? 2 : 1));
    const minimumTotal = minimums.reduce((sum, value) => sum + value, 0);
    const budget = Math.min(total, Math.max(requested, minimumTotal));
    const capacities = segments.map((segment, index) => segment.points.length - minimums[index]);
    const capacityTotal = capacities.reduce((sum, value) => sum + value, 0);
    let remaining = budget - minimumTotal;
    const allocations = minimums.slice();

    if (remaining > 0 && capacityTotal > 0) {
      const fractions = capacities.map((capacity, index) => {
        const exact = remaining * capacity / capacityTotal;
        const whole = Math.min(capacity, Math.floor(exact));
        allocations[index] += whole;
        return { index, fraction: exact - whole };
      }).sort((left, right) => right.fraction - left.fraction || left.index - right.index);
      remaining = budget - allocations.reduce((sum, value) => sum + value, 0);
      for (const item of fractions) {
        if (remaining <= 0) break;
        if (allocations[item.index] >= segments[item.index].points.length) continue;
        allocations[item.index] += 1;
        remaining -= 1;
      }
    }

    return segments.map((segment, index) => ({
      ...segment,
      points: samplePoints(segment.points, allocations[index]),
    }));
  }

  function axisExpression(chunk, axis) {
    let expression = Number(chunk.at(-1)[axis]).toFixed(5);
    for (let index = chunk.length - 2; index >= 0; index -= 1) {
      const from = chunk[index];
      const to = chunk[index + 1];
      const start = Number(from.time).toFixed(6);
      const end = Number(to.time).toFixed(6);
      const duration = Math.max(0.000001, Number(to.time) - Number(from.time)).toFixed(6);
      const fromValue = Number(from[axis]).toFixed(5);
      const delta = (Number(to[axis]) - Number(from[axis])).toFixed(5);
      const interpolation = `(${fromValue}+${delta}*clip((t-${start})/${duration}\\,0\\,1))`;
      expression = `if(between(t\\,${start}\\,${end})\\,${interpolation}\\,${expression})`;
    }
    return expression;
  }

  function buildPathChunks(rawPoints, options = {}) {
    const points = samplePoints(rawPoints, options.maximum || 720);
    if (!points.length) return [];
    const chunkSize = Math.max(3, Math.floor(Number(options.chunkSize) || 90));
    const chunks = [];
    for (let offset = 0; offset < points.length; offset += chunkSize - 1) {
      const chunk = points.slice(offset, offset + chunkSize);
      if (!chunk.length) break;
      chunks.push({
        start: Math.max(0, Number(chunk[0].time)),
        end: Number(chunk.at(-1).time) + (chunk.length === 1 ? 0.2 : 0),
        endExclusive: false,
        xExpression: axisExpression(chunk, 'xPct'),
        yExpression: axisExpression(chunk, 'yPct'),
      });
      if (offset + chunkSize >= points.length) break;
    }
    for (let index = 0; index < chunks.length - 1; index += 1) {
      chunks[index].end = Math.max(chunks[index].start, chunks[index + 1].start);
      chunks[index].endExclusive = true;
    }
    return chunks;
  }

  function chunkEnableExpression(chunk) {
    const start = Number(chunk?.start).toFixed(6);
    const end = Number(chunk?.end).toFixed(6);
    const range = `between(t\\,${start}\\,${end})`;
    return chunk?.endExclusive ? `${range}*lt(t\\,${end})` : range;
  }

  return {
    BASE_CURSOR_SPEC,
    axisExpression,
    buildPathChunks,
    chunkEnableExpression,
    cursorRenderSpec,
    samplePoints,
    samplingLimit,
    samplePointSegments,
  };
});
