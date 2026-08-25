(function attachCreatorEngine(root, factory) {
  'use strict';

  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.ScreenForgeCreatorEngine = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createCreatorEngine() {
  'use strict';

  const EPSILON = 1e-9;
  const DIRECTOR_ID_BASE = 910000000;

  const DIRECTOR_PROFILES = Object.freeze({
    calm: Object.freeze({
      minShotDuration: 3,
      maxShotDuration: 6.5,
      leadIn: 0.4,
      tail: 1,
      dedupeWindow: 0.45,
      dedupeDistance: 0.09,
      groupWindow: 2.4,
      groupDistance: 0.26,
      keyWindow: 2,
      keyTail: 0.9,
      easing: 'ease-in-out',
    }),
    tutorial: Object.freeze({
      minShotDuration: 2.2,
      maxShotDuration: 5,
      leadIn: 0.28,
      tail: 0.75,
      dedupeWindow: 0.3,
      dedupeDistance: 0.075,
      groupWindow: 1.65,
      groupDistance: 0.22,
      keyWindow: 1.6,
      keyTail: 0.65,
      easing: 'ease-in-out',
    }),
    energetic: Object.freeze({
      minShotDuration: 1.15,
      maxShotDuration: 2.8,
      leadIn: 0.14,
      tail: 0.45,
      dedupeWindow: 0.18,
      dedupeDistance: 0.055,
      groupWindow: 0.8,
      groupDistance: 0.16,
      keyWindow: 0.85,
      keyTail: 0.35,
      easing: 'linear',
    }),
  });

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function toFiniteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function round(value) {
    return Math.round((value + Number.EPSILON) * 1000000) / 1000000;
  }

  function rangeValues(range) {
    if (Array.isArray(range)) {
      return { start: Number(range[0]), end: Number(range[1]) };
    }
    const values = {
      start: Number(range && range.start),
      end: Number(range && range.end),
    };
    if (range && typeof range.source === 'string' && range.source.length) {
      values.source = range.source;
    }
    return values;
  }

  function copyRange(range) {
    const copy = { start: range.start, end: range.end };
    if (range.source !== undefined) copy.source = range.source;
    return copy;
  }

  function mergeSources(left, right) {
    if (left === right) return left;
    return 'mixed';
  }

  function rangeOptions(options) {
    const input = options || {};
    const start = isFiniteNumber(input.start) ? input.start : -Infinity;
    const end = isFiniteNumber(input.end) ? input.end : Infinity;
    return {
      start,
      end,
      minDuration: Math.max(0, toFiniteNumber(input.minDuration, 0)),
      valid: end >= start,
    };
  }

  function normalizeRanges(ranges, options) {
    const bounds = rangeOptions(options);
    if (!bounds.valid || !Array.isArray(ranges)) return [];

    const sorted = ranges
      .map(rangeValues)
      .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end))
      .map((range) => {
        const clamped = {
          start: Math.max(bounds.start, range.start),
          end: Math.min(bounds.end, range.end),
        };
        if (range.source !== undefined) clamped.source = range.source;
        return clamped;
      })
      .filter((range) => range.end - range.start > EPSILON)
      .sort((left, right) => left.start - right.start || left.end - right.end);

    const merged = [];
    for (const range of sorted) {
      const previous = merged[merged.length - 1];
      if (!previous || range.start > previous.end + EPSILON) {
        merged.push(copyRange(range));
      } else {
        if (range.end > previous.end) previous.end = range.end;
        const source = mergeSources(previous.source, range.source);
        if (source === undefined) delete previous.source;
        else previous.source = source;
      }
    }

    return merged
      .filter((range) => range.end - range.start + EPSILON >= bounds.minDuration)
      .map((range) => {
        const normalized = { start: round(range.start), end: round(range.end) };
        if (range.source !== undefined) normalized.source = range.source;
        return normalized;
      });
  }

  function subtractRange(ranges, range, options) {
    const bounds = rangeOptions(options);
    if (!bounds.valid) return [];

    const source = normalizeRanges(ranges, {
      start: bounds.start,
      end: bounds.end,
      minDuration: 0,
    });
    const subtract = normalizeRanges([range], {
      start: bounds.start,
      end: bounds.end,
      minDuration: 0,
    })[0];

    if (!subtract) {
      return normalizeRanges(source, bounds);
    }

    const result = [];
    for (const item of source) {
      if (subtract.end <= item.start || subtract.start >= item.end) {
        result.push(copyRange(item));
        continue;
      }
      if (subtract.start > item.start) {
        const left = { start: item.start, end: Math.min(item.end, subtract.start) };
        if (item.source !== undefined) left.source = item.source;
        result.push(left);
      }
      if (subtract.end < item.end) {
        const right = { start: Math.max(item.start, subtract.end), end: item.end };
        if (item.source !== undefined) right.source = item.source;
        result.push(right);
      }
    }

    return normalizeRanges(result, bounds);
  }

  function paddingValues(padding) {
    if (padding && typeof padding === 'object') {
      return {
        before: Math.max(0, toFiniteNumber(padding.before ?? padding.start, 0)),
        after: Math.max(0, toFiniteNumber(padding.after ?? padding.end, 0)),
      };
    }
    const amount = Math.max(0, toFiniteNumber(padding, 0));
    return { before: amount, after: amount };
  }

  function silencesToRemovals(silences, options) {
    const input = options || {};
    const padding = paddingValues(input.padding);
    const ranges = Array.isArray(silences)
      ? silences.map((silence) => {
        const range = rangeValues(silence);
        return {
          start: range.start + padding.before,
          end: range.end - padding.after,
          source: 'silence',
        };
      })
      : [];

    return normalizeRanges(ranges, input);
  }

  function isTimeRemoved(time, ranges) {
    const value = Number(time);
    if (!Number.isFinite(value)) return false;
    return normalizeRanges(ranges).some((range) => value >= range.start && value < range.end);
  }

  function removedDuration(ranges, options) {
    return normalizeRanges(ranges, options).reduce(
      (total, range) => total + range.end - range.start,
      0,
    );
  }

  function timelineContext(context) {
    const input = context || {};
    const trimIn = toFiniteNumber(input.trimIn, 0);
    const requestedOut = toFiniteNumber(input.trimOut, trimIn);
    const trimOut = Math.max(trimIn, requestedOut);
    const speed = toFiniteNumber(input.speedMultiplier, 1);
    return {
      trimIn,
      trimOut,
      speedMultiplier: speed > 0 ? speed : 1,
      removedRanges: normalizeRanges(input.removedRanges, {
        start: trimIn,
        end: trimOut,
      }),
    };
  }

  function outputDuration(context) {
    const timeline = timelineContext(context);
    const sourceDuration = timeline.trimOut - timeline.trimIn;
    const removed = removedDuration(timeline.removedRanges, {
      start: timeline.trimIn,
      end: timeline.trimOut,
    });
    return round(Math.max(0, sourceDuration - removed) / timeline.speedMultiplier);
  }

  function sourceToOutputTimeInTimeline(time, timeline) {
    const sourceTime = clamp(
      toFiniteNumber(time, timeline.trimIn),
      timeline.trimIn,
      timeline.trimOut,
    );
    let removedBefore = 0;

    for (const range of timeline.removedRanges) {
      if (sourceTime <= range.start) break;
      removedBefore += Math.max(0, Math.min(sourceTime, range.end) - range.start);
    }

    return round(Math.max(0, sourceTime - timeline.trimIn - removedBefore));
  }

  function sourceToOutputTime(time, context) {
    return sourceToOutputTimeInTimeline(time, timelineContext(context));
  }

  function mappedOutputTime(time, timeline) {
    return round(sourceToOutputTimeInTimeline(time, timeline) / timeline.speedMultiplier);
  }

  function mapInterval(start, end, context) {
    const timeline = timelineContext(context);
    const sourceStart = Math.max(timeline.trimIn, toFiniteNumber(start, timeline.trimIn));
    const sourceEnd = Math.min(timeline.trimOut, toFiniteNumber(end, timeline.trimOut));
    if (sourceEnd - sourceStart <= EPSILON) return null;

    const mappedStart = mappedOutputTime(sourceStart, timeline);
    const mappedEnd = mappedOutputTime(sourceEnd, timeline);
    const duration = mappedEnd - mappedStart;
    if (duration <= EPSILON) return null;

    return {
      start: round(mappedStart),
      end: round(mappedEnd),
      duration: round(duration),
    };
  }

  function splitVisibleInterval(start, end, context) {
    const timeline = timelineContext(context);
    const effectStart = toFiniteNumber(start, timeline.trimIn);
    const effectEnd = toFiniteNumber(end, timeline.trimOut);
    if (effectEnd - effectStart <= EPSILON) return [];

    const clippedStart = Math.max(timeline.trimIn, effectStart);
    const clippedEnd = Math.min(timeline.trimOut, effectEnd);
    if (clippedEnd - clippedStart <= EPSILON) return [];

    const sourceSegments = [];
    let visibleStart = clippedStart;

    for (const removed of timeline.removedRanges) {
      if (removed.end <= visibleStart + EPSILON) continue;
      if (removed.start >= clippedEnd - EPSILON) break;

      const visibleEnd = Math.min(clippedEnd, removed.start);
      if (visibleEnd - visibleStart > EPSILON) {
        sourceSegments.push({ sourceStart: visibleStart, sourceEnd: visibleEnd });
      }

      visibleStart = Math.max(visibleStart, removed.end);
      if (visibleStart >= clippedEnd - EPSILON) break;
    }

    if (clippedEnd - visibleStart > EPSILON) {
      sourceSegments.push({ sourceStart: visibleStart, sourceEnd: clippedEnd });
    }

    return sourceSegments.map((segment) => {
      const mappedStart = mappedOutputTime(segment.sourceStart, timeline);
      const mappedEnd = mappedOutputTime(segment.sourceEnd, timeline);
      return {
        sourceStart: round(segment.sourceStart),
        sourceEnd: round(segment.sourceEnd),
        start: mappedStart,
        end: mappedEnd,
        duration: round(mappedEnd - mappedStart),
        phaseOffset: round(segment.sourceStart - effectStart),
      };
    }).filter((segment) => segment.duration > EPSILON);
  }

  function normalizeCursorPoints(points) {
    if (!Array.isArray(points)) return [];
    const sorted = points
      .map((point, index) => ({
        point,
        index,
        time: Number(point && point.time),
        xPct: Number(point && point.xPct),
        yPct: Number(point && point.yPct),
      }))
      .filter((entry) => Number.isFinite(entry.time)
        && Number.isFinite(entry.xPct)
        && Number.isFinite(entry.yPct))
      .sort((left, right) => left.time - right.time || left.index - right.index);

    const normalized = [];
    for (const entry of sorted) {
      const point = {
        ...entry.point,
        time: entry.time,
        xPct: entry.xPct,
        yPct: entry.yPct,
      };
      const previous = normalized[normalized.length - 1];
      if (previous && Math.abs(previous.time - point.time) <= EPSILON) {
        normalized[normalized.length - 1] = point;
      } else {
        normalized.push(point);
      }
    }
    return normalized;
  }

  function cursorPointAtTime(points, time) {
    if (time <= points[0].time + EPSILON) {
      return { ...points[0], time };
    }
    const last = points[points.length - 1];
    if (time >= last.time - EPSILON) {
      return { ...last, time };
    }

    let low = 0;
    let high = points.length - 1;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (points[middle].time <= time) low = middle;
      else high = middle;
    }

    const left = points[low];
    const right = points[high];
    const span = Math.max(EPSILON, right.time - left.time);
    const progress = clamp((time - left.time) / span, 0, 1);
    return {
      ...left,
      time,
      xPct: round(left.xPct + ((right.xPct - left.xPct) * progress)),
      yPct: round(left.yPct + ((right.yPct - left.yPct) * progress)),
    };
  }

  function mapCursorPoint(point, timeline, segment) {
    const sourceTime = round(point.time);
    const outputTime = segment
      ? segment.start + ((sourceTime - segment.sourceStart) / timeline.speedMultiplier)
      : mappedOutputTime(sourceTime, timeline);
    return {
      ...point,
      sourceTime,
      time: round(outputTime),
    };
  }

  function splitCursorPath(points, context) {
    const timeline = timelineContext(context);
    const sourcePoints = normalizeCursorPoints(points);
    if (!sourcePoints.length) return [];

    if (sourcePoints.length === 1) {
      const point = sourcePoints[0];
      const inTrim = point.time >= timeline.trimIn - EPSILON
        && point.time <= timeline.trimOut + EPSILON;
      const removed = timeline.removedRanges.some(
        (range) => point.time >= range.start && point.time < range.end,
      );
      if (!inTrim || removed) return [];
      const mapped = mapCursorPoint(point, timeline);
      return [{
        sourceStart: mapped.sourceTime,
        sourceEnd: mapped.sourceTime,
        start: mapped.time,
        end: mapped.time,
        duration: 0,
        phaseOffset: 0,
        points: [mapped],
      }];
    }

    const sourceStart = sourcePoints[0].time;
    const visibleSegments = splitVisibleInterval(
      sourceStart,
      sourcePoints[sourcePoints.length - 1].time,
      timeline,
    );
    let pointIndex = 0;

    return visibleSegments.map((segment) => {
      while (pointIndex < sourcePoints.length
        && sourcePoints[pointIndex].time <= segment.sourceStart + EPSILON) {
        pointIndex += 1;
      }

      const segmentPoints = [cursorPointAtTime(sourcePoints, segment.sourceStart)];
      while (pointIndex < sourcePoints.length
        && sourcePoints[pointIndex].time < segment.sourceEnd - EPSILON) {
        segmentPoints.push({ ...sourcePoints[pointIndex] });
        pointIndex += 1;
      }
      segmentPoints.push(cursorPointAtTime(sourcePoints, segment.sourceEnd));

      return {
        ...segment,
        points: segmentPoints.map((point) => mapCursorPoint(point, timeline, segment)),
      };
    });
  }

  function distance(left, right) {
    return Math.hypot(left.xPct - right.xPct, left.yPct - right.yPct);
  }

  function resolveProfile(profile) {
    if (typeof profile === 'string' && DIRECTOR_PROFILES[profile]) {
      return { name: profile, values: DIRECTOR_PROFILES[profile] };
    }
    if (profile && typeof profile === 'object') {
      return {
        name: 'custom',
        values: Object.assign({}, DIRECTOR_PROFILES.tutorial, profile),
      };
    }
    return { name: 'tutorial', values: DIRECTOR_PROFILES.tutorial };
  }

  function nearestCursorPoint(time, cursor) {
    let nearest = null;
    for (const point of cursor) {
      const delta = Math.abs(point.time - time);
      if (!nearest || delta < nearest.delta) nearest = { point, delta };
    }
    return nearest && nearest.delta <= 0.75 ? nearest.point : null;
  }

  function normalizedInteractions(events, trimIn, trimOut) {
    const input = events || {};
    const cursor = (Array.isArray(input.cursor) ? input.cursor : [])
      .map((point, index) => ({
        time: Number(point && point.time),
        xPct: Number(point && point.xPct),
        yPct: Number(point && point.yPct),
        index,
      }))
      .filter((point) => Number.isFinite(point.time)
        && Number.isFinite(point.xPct)
        && Number.isFinite(point.yPct))
      .sort((left, right) => left.time - right.time || left.index - right.index);

    const clicks = (Array.isArray(input.clicks) ? input.clicks : [])
      .map((click, index) => {
        const time = Number(click && click.time);
        const cursorPoint = Number.isFinite(time) ? nearestCursorPoint(time, cursor) : null;
        const rawX = Number(click && click.xPct);
        const rawY = Number(click && click.yPct);
        return {
          time,
          xPct: clamp(Number.isFinite(rawX) ? rawX : cursorPoint ? cursorPoint.xPct : 0.5, 0, 1),
          yPct: clamp(Number.isFinite(rawY) ? rawY : cursorPoint ? cursorPoint.yPct : 0.5, 0, 1),
          index,
        };
      })
      .filter((click) => Number.isFinite(click.time)
        && click.time >= trimIn
        && click.time <= trimOut)
      .sort((left, right) => left.time - right.time || left.index - right.index);

    const keys = (Array.isArray(input.keys) ? input.keys : [])
      .map((key, index) => ({ time: Number(key && key.time), index }))
      .filter((key) => Number.isFinite(key.time)
        && key.time >= trimIn
        && key.time <= trimOut)
      .sort((left, right) => left.time - right.time || left.index - right.index);

    return { clicks, keys };
  }

  function dedupeClicks(clicks, profile) {
    const result = [];
    for (const click of clicks) {
      const previous = result[result.length - 1];
      const isDuplicate = previous
        && click.time - previous.time <= profile.dedupeWindow
        && distance(click, previous) <= profile.dedupeDistance;
      if (!isDuplicate) result.push(click);
    }
    return result;
  }

  function groupClicks(clicks, profile) {
    const groups = [];

    for (const click of clicks) {
      const group = groups[groups.length - 1];
      if (!group) {
        groups.push({ clicks: [click], center: { xPct: click.xPct, yPct: click.yPct } });
        continue;
      }

      const previous = group.clicks[group.clicks.length - 1];
      const relatedInTime = click.time - previous.time <= profile.groupWindow;
      const relatedInSpace = distance(click, group.center) <= profile.groupDistance;
      if (!relatedInTime || !relatedInSpace) {
        groups.push({ clicks: [click], center: { xPct: click.xPct, yPct: click.yPct } });
        continue;
      }

      group.clicks.push(click);
      const count = group.clicks.length;
      group.center = {
        xPct: ((group.center.xPct * (count - 1)) + click.xPct) / count,
        yPct: ((group.center.yPct * (count - 1)) + click.yPct) / count,
      };
    }

    return groups;
  }

  function safeFocus(point, webcamPos, captions) {
    let xPct = clamp(point.xPct, 0.08, 0.92);
    let yPct = clamp(point.yPct, 0.08, 0.92);
    if (captions) yPct = Math.min(yPct, 0.72);

    const aliases = {
      'bottom-right': 'br',
      bottomRight: 'br',
      'bottom-left': 'bl',
      bottomLeft: 'bl',
      'top-right': 'tr',
      topRight: 'tr',
      'top-left': 'tl',
      topLeft: 'tl',
    };
    const corner = aliases[webcamPos] || webcamPos;
    const inLeft = xPct <= 0.28;
    const inRight = xPct >= 0.72;
    const inTop = yPct <= 0.32;
    const inBottom = yPct >= 0.68;

    if (corner === 'tl' && inLeft && inTop) xPct = 0.32;
    if (corner === 'tr' && inRight && inTop) xPct = 0.68;
    if (corner === 'bl' && inLeft && inBottom) xPct = 0.32;
    if (corner === 'br' && inRight && inBottom) xPct = 0.68;

    return { xPct: round(xPct), yPct: round(yPct) };
  }

  function fitShot(start, end, trimIn, trimOut, profile) {
    const available = Math.max(0, trimOut - trimIn);
    if (available <= EPSILON) return null;

    const minimum = Math.min(available, Math.max(0, profile.minShotDuration));
    const maximum = Math.min(available, Math.max(minimum, profile.maxShotDuration));
    const duration = clamp(Math.max(end - start, minimum), minimum, maximum);
    const fittedStart = clamp(start, trimIn, trimOut - duration);
    return {
      start: round(fittedStart),
      end: round(fittedStart + duration),
      duration: round(duration),
    };
  }

  function generateDirectorKeyframes(options) {
    const input = options || {};
    const trimIn = toFiniteNumber(input.trimIn, 0);
    const trimOut = Math.max(trimIn, toFiniteNumber(input.trimOut, trimIn));
    if (trimOut - trimIn <= EPSILON) return [];

    const resolved = resolveProfile(input.profile);
    const profile = resolved.values;
    const interactions = normalizedInteractions(input.events, trimIn, trimOut);
    const clicks = dedupeClicks(interactions.clicks, profile);
    const groups = groupClicks(clicks, profile);
    const zoomLevel = Math.max(1, toFiniteNumber(input.zoomLevel, 2));

    return groups.map((group, index) => {
      const first = group.clicks[0];
      const last = group.clicks[group.clicks.length - 1];
      const relevantKeyTimes = interactions.keys
        .map((key) => key.time)
        .filter((time) => time >= first.time - profile.leadIn
          && time <= last.time + profile.keyWindow);
      const lastKeyTime = relevantKeyTimes.length
        ? relevantKeyTimes[relevantKeyTimes.length - 1]
        : -Infinity;
      const desiredStart = first.time - profile.leadIn;
      const desiredEnd = Math.max(
        last.time + profile.tail,
        Number.isFinite(lastKeyTime) ? lastKeyTime + profile.keyTail : -Infinity,
      );
      const shot = fitShot(desiredStart, desiredEnd, trimIn, trimOut, profile);
      const focus = safeFocus(group.center, input.webcamPos, !!input.captions);

      return {
        id: DIRECTOR_ID_BASE + index,
        type: 'zoom',
        time: shot.start,
        duration: shot.duration,
        xPct: focus.xPct,
        yPct: focus.yPct,
        zoomLevel: round(zoomLevel),
        easing: profile.easing,
        profile: resolved.name,
        source: 'action-director',
      };
    });
  }

  return Object.freeze({
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
  });
}));
