'use strict';

const PresentationEngine = require('./renderer/presentation-engine');

const MAX_TIME_SECONDS = 365 * 24 * 60 * 60;
const MIN_SPEED = 0.5;
const MAX_SPEED = 4;
const EPSILON = 1e-6;
const CUT_CLOCK_HZ = 1_000_000;
const DEFAULT_SOURCE_FRAME_RATE = 30;
const MIN_SOURCE_FRAME_RATE = 1;
const MAX_SOURCE_FRAME_RATE = 240;
const MAX_REMOVED_RANGES = 1000;
const MAX_RAW_REMOVED_RANGES = 5000;
const ATEMPO_SAMPLE_RATE = 48_000;
const ATEMPO_WINDOW_SAMPLES = 2048;
// Center FFmpeg's WSOLA onset phase across the supported 0.5x to 4x export range.
const ATEMPO_ALIGNMENT_SAMPLES = ATEMPO_WINDOW_SAMPLES * 5 / 8;

function buildExportPlan(options = {}) {
  const inputPath = requiredPath(options.inputPath, 'inputPath');
  const outputPath = requiredPath(options.outputPath, 'outputPath');
  const format = normalizeFormat(options.format);
  const trim = normalizeTrim(options.trimIn, options.trimOut);
  const removedRanges = normalizeRemovedRanges(options.removedRanges, trim);
  const sourceFrameRate = normalizeSourceFrameRate(options.sourceFrameRate);
  const speed = finiteNumber(options.speedMultiplier, 1, MIN_SPEED, MAX_SPEED);
  const sourceDuration = trim.duration === null
    ? null
    : Math.max(0, trim.duration - totalRemovedDuration(removedRanges));
  const expectedDuration = sourceDuration === null
    ? null
    : roundedNumber(sourceDuration / speed);
  const music = format === 'gif' ? null : normalizeBackgroundMusic(options.backgroundMusic);
  const hasSourceAudio = format !== 'gif' && options.hasAudio === true;
  const hasOutputAudio = format !== 'gif' && (hasSourceAudio || Boolean(music));
  const args = ['-hide_banner', '-nostdin', '-y'];

  if (trim.start > 0) args.push('-ss', numberToken(trim.start));
  if (trim.duration !== null) args.push('-t', numberToken(trim.duration));
  args.push('-i', inputPath);

  if (music) {
    const loopCount = finiteMusicLoopCount(expectedDuration, music.duration);
    if (loopCount > 0) args.push('-stream_loop', numberToken(loopCount));
    args.push('-i', music.path);
  }

  const graph = [];
  const cutClock = buildCutClock(removedRanges, trim.start);
  let videoLabel = 'vbase';
  let videoChain = 'setpts=PTS-STARTPTS';

  if (cutClock.selection) {
    videoChain += `,select='${cutClock.selection}',setpts='${cutClock.ptsExpression}'`;
  }
  graph.push(`[0:v:0]${videoChain}[${videoLabel}]`);

  const videoFilters = normalizeFilterChain(options.filters, 'source');
  if (videoFilters) {
    graph.push(`[${videoLabel}]${videoFilters}[vfiltered]`);
    videoLabel = 'vfiltered';
  }

  const presentation = normalizePresentation(options.presentation);
  let presentationBackgroundLabel = null;
  if (presentation?.styled) {
    graph.push(`[${videoLabel}]split=2[vpresentationbackground][vpresentationforeground]`);
    presentationBackgroundLabel = 'vpresentationbackground';
    videoLabel = 'vpresentationforeground';
  }

  const blurZones = normalizeBlurZones(options.blurZones, trim, removedRanges);
  for (let index = 0; index < blurZones.length; index += 1) {
    const zone = blurZones[index];
    const keepLabel = `vkeep${index}`;
    const cropInputLabel = `vcropin${index}`;
    const blurredLabel = `vblur${index}`;
    const outputLabel = `vblurred${index}`;
    const blurRadius = `min(${numberToken(zone.radius)}\\,min(w\\,h)/2)`;
    const chromaRadius = `min(${numberToken(zone.radius)}\\,min(cw\\,ch)/2)`;

    graph.push(`[${videoLabel}]split=2[${keepLabel}][${cropInputLabel}]`);
    graph.push(
      `[${cropInputLabel}]crop=w=iw*${numberToken(zone.width)}:`
      + `h=ih*${numberToken(zone.height)}:`
      + `x=iw*${numberToken(zone.x)}:`
      + `y=ih*${numberToken(zone.y)},`
      + `boxblur=luma_radius='${blurRadius}':luma_power=1:`
      + `chroma_radius='${chromaRadius}':chroma_power=1[${blurredLabel}]`
    );

    const enable = zone.enable ? `:enable='${zone.enable}'` : '';
    graph.push(
      `[${keepLabel}][${blurredLabel}]overlay=`
      + `x=main_w*${numberToken(zone.x)}:`
      + `y=main_h*${numberToken(zone.y)}`
      + `${enable}[${outputLabel}]`
    );
    videoLabel = outputLabel;
  }

  const sourceOverlays = normalizeFilterChain(options.sourceOverlays, 'overlay');
  if (sourceOverlays) {
    graph.push(`[${videoLabel}]${sourceOverlays}[vsourceoverlays]`);
    videoLabel = 'vsourceoverlays';
  }

  const cameraFilters = normalizeFilterChain(options.cameraFilters, 'camera');
  if (cameraFilters) {
    graph.push(`[${videoLabel}]${cameraFilters}[vcamera]`);
    videoLabel = 'vcamera';
    if (presentationBackgroundLabel) {
      graph.push(`[${presentationBackgroundLabel}]${cameraFilters}[vpresentationbackgroundcamera]`);
      presentationBackgroundLabel = 'vpresentationbackgroundcamera';
    }
  }

  if (presentation) {
    videoLabel = appendPresentationGraph(graph, videoLabel, presentation, presentationBackgroundLabel);
  }

  const postFilters = normalizeFilterChain(options.postFilters, 'overlay');
  if (postFilters) {
    graph.push(`[${videoLabel}]${postFilters}[vpost]`);
    videoLabel = 'vpost';
  }

  const watermark = normalizeWatermark(options.watermark, trim, removedRanges);
  if (watermark) {
    const enable = watermark.enable ? `:enable='${watermark.enable}'` : '';
    graph.push(
      `[${videoLabel}]drawtext=text='${watermark.text}':`
      + `fontsize=${numberToken(watermark.size)}:`
      + `fontcolor=white@${numberToken(watermark.opacity)}:`
      + `${watermark.position}${enable}[vwatermark]`
    );
    videoLabel = 'vwatermark';
  }

  if (format === 'gif') {
    if (!approximatelyEqual(speed, 1)) {
      graph.push(`[${videoLabel}]settb=AVTB,setpts=PTS/${numberToken(speed)}[vspeed]`);
      videoLabel = 'vspeed';
    }
    graph.push(`[${videoLabel}]fps=15,split=2[gifframes][gifpalettein]`);
    graph.push('[gifpalettein]palettegen[gifpalette]');
    graph.push('[gifframes][gifpalette]paletteuse[vout]');
  } else if (!approximatelyEqual(speed, 1)) {
    const frameClock = cutClock.selection ? ',fps=source_fps' : '';
    graph.push(`[${videoLabel}]settb=AVTB,setpts=PTS/${numberToken(speed)}${frameClock}[vout]`);
  } else if (cutClock.selection) {
    graph.push(`[${videoLabel}]fps=source_fps[vout]`);
  } else {
    graph.push(`[${videoLabel}]null[vout]`);
  }

  if (hasOutputAudio) {
    buildAudioGraph({
      graph,
      hasSourceAudio,
      trim,
      removedRanges,
      audioFilters: normalizeFilterChain(options.audioFilters, 'audio'),
      speed,
      music,
      expectedDuration,
    });
  }

  args.push('-filter_complex', graph.join(';'));
  args.push('-map', '[vout]');
  if (hasOutputAudio) args.push('-map', '[aout]');
  else args.push('-an');

  appendCodecArgs(args, format, options.crf, hasOutputAudio);

  if (music) args.push('-shortest');
  if (expectedDuration !== null && expectedDuration > 0) {
    args.push('-t', numberToken(expectedDuration));
  }
  args.push(outputPath);

  return {
    args: args.map(String),
    outputPath,
    expectedDuration,
    hasOutputAudio,
    sourceFrameRate,
  };
}

function normalizePresentation(rawPresentation) {
  return PresentationEngine.normalizePresentation(rawPresentation);
}

function roundedAlphaExpression(radius) {
  const safeRadius = Math.max(1, Math.round(Number(radius) || 1));
  const dx = `max(${safeRadius}-X\\,0)+max(X-(W-${safeRadius})\\,0)`;
  const dy = `max(${safeRadius}-Y\\,0)+max(Y-(H-${safeRadius})\\,0)`;
  return `if(lte(pow(${dx}\\,2)+pow(${dy}\\,2)\\,pow(${safeRadius}\\,2))\\,255\\,0)`;
}

function appendPresentationGraph(graph, inputLabel, presentation, cleanBackgroundLabel = null) {
  const { width, height } = presentation;
  if (!presentation.styled) {
    graph.push(
      `[${inputLabel}]scale=${width}:${height}:force_original_aspect_ratio=decrease,`
      + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x090d18,setsar=1[vpresent]`
    );
    return 'vpresent';
  }

  const geometry = PresentationEngine.presentationGeometry(
    presentation,
    presentation.sourceWidth,
    presentation.sourceHeight,
  );
  const { frameHeight, innerWidth, frameBoxHeight, contentHeight, cornerRadius } = geometry;
  let backgroundInput = cleanBackgroundLabel;
  let foregroundInput = inputLabel;
  if (!backgroundInput) {
    backgroundInput = 'vpbginput';
    foregroundInput = 'vpfginput';
    graph.push(`[${inputLabel}]split=2[${backgroundInput}][${foregroundInput}]`);
  }

  if (presentation.blur > 0) {
    const sigma = roundedNumber(4 + presentation.blur * 32);
    graph.push(
      `[${backgroundInput}]scale=${width}:${height}:force_original_aspect_ratio=increase,`
      + `crop=${width}:${height},gblur=sigma=${numberToken(sigma)}[vpbackgroundbase]`
    );
  } else {
    graph.push(
      `[${backgroundInput}]scale=${width}:${height}:force_original_aspect_ratio=increase,`
      + `crop=${width}:${height}[vpbackgroundbase]`
    );
  }

  let foregroundChain = `scale=${innerWidth}:${contentHeight}:force_original_aspect_ratio=decrease,`
    + `pad=${innerWidth}:${contentHeight}:(ow-iw)/2:(oh-ih)/2:color=0x08090c`;
  let roundedInputLabel;
  if (presentation.frame) {
    foregroundChain += `,pad=${innerWidth}:${frameBoxHeight}:0:${frameHeight}:color=0x2c2c2e`;
    const dotSize = Math.max(5, Math.round(frameHeight * 0.28));
    const dotGap = Math.max(4, Math.round(dotSize * 0.65));
    const dotX = Math.max(8, Math.round(frameHeight * 0.55));
    const dotFontSize = Math.max(10, Math.round(frameHeight * 0.56));
    const dotFont = '/System/Library/Fonts/Supplemental/Arial.ttf';
    const drawDot = (x, color) => `drawtext=text='●':expansion=none:fontfile='${dotFont}':`
      + `fontsize=${dotFontSize}:fontcolor=${color}:x=${x}:y=(${frameHeight}-text_h)/2`;
    graph.push(`[${foregroundInput}]${foregroundChain},setsar=1[vpframebase]`);
    graph.push(
      `gradients=s=${innerWidth}x${frameHeight}:r=30:c0=0x3d3d3f:c1=0x2c2c2e:`
      + `x0=0:y0=0:x1=0:y1=${frameHeight}:type=linear[vptitlebar]`
    );
    graph.push(
      `[vpframebase][vptitlebar]overlay=x=0:y=0:shortest=1,`
      + `drawbox=x=0:y=${Math.max(0, frameHeight - 1)}:w=iw:h=1:color=white@0.12:t=fill,`
      + `${drawDot(dotX, '0xff5f57')},`
      + `${drawDot(dotX + dotSize + dotGap, '0xfebc2e')},`
      + `${drawDot(dotX + (dotSize + dotGap) * 2, '0x28c840')},`
      + `drawbox=x=0:y=0:w=iw:h=ih:color=white@0.10:t=1[vpforegrounddecorated]`
    );
    roundedInputLabel = 'vpforegrounddecorated';
  } else {
    graph.push(`[${foregroundInput}]${foregroundChain},setsar=1[vpforegrounddecorated]`);
    roundedInputLabel = 'vpforegrounddecorated';
  }
  graph.push(
    `color=c=black:s=${innerWidth}x${frameBoxHeight}:r=1:d=1,format=gray,`
    + `geq=lum='${roundedAlphaExpression(cornerRadius)}',`
    + `loop=loop=-1:size=1:start=0,setpts=N/(30*TB)[vproundedmask]`
  );
  graph.push(`[${roundedInputLabel}]format=rgba[vpforegroundrgba]`);
  graph.push('[vpforegroundrgba][vproundedmask]alphamerge=shortest=1[vpforeground]');

  const [firstColor, secondColor] = presentation.colors.map(color => color.slice(1));
  const backgroundSource = presentation.mode === 'solid'
    ? `color=c=0x${presentation.solidColor.slice(1)}:s=${width}x${height}:r=30`
    : `gradients=s=${width}x${height}:r=30:c0=0x${firstColor}:c1=0x${secondColor}:x0=0:y0=0:x1=${width}:y1=${height}:type=linear`;

  const washAlpha = presentation.blur > 0 ? 0.68 : 1;
  graph.push(`${backgroundSource},format=rgba,colorchannelmixer=aa=${washAlpha}[vpcolorwash]`);
  graph.push('[vpbackgroundbase][vpcolorwash]overlay=shortest=1[vpbackground]');
  graph.push('[vpbackground][vpforeground]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2:shortest=1[vpresent]');
  return 'vpresent';
}

function buildAudioGraph({
  graph,
  hasSourceAudio,
  trim,
  removedRanges,
  audioFilters,
  speed,
  music,
  expectedDuration,
}) {
  if (hasSourceAudio) {
    const cutAudioLabel = removedRanges.length
      ? appendRetainedAudioGraph(graph, trim, removedRanges)
      : null;
    const sourceInput = cutAudioLabel || '0:a:0';
    const sourceFilters = [];
    if (!cutAudioLabel) sourceFilters.push('asetpts=PTS-STARTPTS');
    if (audioFilters) sourceFilters.push(audioFilters);

    const tempo = buildAtempoChain(speed);
    if (tempo) {
      sourceFilters.push(`aresample=${ATEMPO_SAMPLE_RATE}`);
      sourceFilters.push(tempo);
      if (expectedDuration !== null && expectedDuration > 0) {
        sourceFilters.push(`adelay=${atempoDelaySamples(speed)}S:all=1`);
        sourceFilters.push(
          `apad,atrim=duration=${numberToken(expectedDuration)},asetpts=PTS-STARTPTS`,
        );
      }
    }
    if (!sourceFilters.length) sourceFilters.push('anull');
    graph.push(`[${sourceInput}]${sourceFilters.join(',')}[${music ? 'asource' : 'aout'}]`);
  }

  if (!music) return;

  let musicChain = `asetpts=PTS-STARTPTS,volume=${numberToken(music.volume)}`;
  if (expectedDuration !== null && expectedDuration > 0) {
    musicChain += `,atrim=duration=${numberToken(expectedDuration)},asetpts=PTS-STARTPTS`;
  }
  graph.push(`[1:a:0]${musicChain}[bgbase]`);

  if (!hasSourceAudio) {
    graph.push('[bgbase]anull[aout]');
    return;
  }

  if (music.ducking.enabled) {
    graph.push('[asource]asplit=2[voice_mix][voice_side]');
    graph.push(
      '[bgbase][voice_side]sidechaincompress='
      + `threshold=${numberToken(music.ducking.threshold)}:`
      + `ratio=${numberToken(music.ducking.ratio)}:`
      + `attack=${numberToken(music.ducking.attack)}:`
      + `release=${numberToken(music.ducking.release)}[bgduck]`
    );
    graph.push('[voice_mix][bgduck]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]');
    return;
  }

  graph.push('[asource][bgbase]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]');
}

function appendRetainedAudioGraph(graph, trim, removedRanges) {
  const duration = trim.duration;
  const events = [];
  let startsRemoved = false;

  for (const range of removedRanges) {
    const start = quantizedTimelineTime(range.start - trim.start);
    const end = quantizedTimelineTime(range.end - trim.start);
    if (start <= EPSILON) {
      startsRemoved = true;
    } else if (duration === null || start < duration - EPSILON) {
      events.push({ time: start, removed: true });
    }
    if (duration === null || end < duration - EPSILON) {
      events.push({ time: end, removed: false });
    }
  }

  if (startsRemoved && !events.length) {
    throw new RangeError('Cut ranges remove the entire export');
  }

  const outputLabels = Array.from(
    { length: events.length + 1 },
    (_, index) => `asegment${index}`,
  );
  const timestamps = events.map(event => numberToken(event.time)).join('|');
  graph.push(
    `[0:a:0]asetpts=PTS-STARTPTS,asegment=timestamps=${timestamps}`
    + outputLabels.map(label => `[${label}]`).join(''),
  );

  const retainedLabels = [];
  let removed = startsRemoved;
  for (let index = 0; index < outputLabels.length; index += 1) {
    const inputLabel = outputLabels[index];
    if (removed) {
      graph.push(`[${inputLabel}]anullsink`);
    } else {
      const retainedLabel = `acut${retainedLabels.length}`;
      graph.push(`[${inputLabel}]asetpts=PTS-STARTPTS[${retainedLabel}]`);
      retainedLabels.push(retainedLabel);
    }
    if (events[index]) removed = events[index].removed;
  }

  if (!retainedLabels.length) throw new RangeError('Cut ranges remove the entire export');
  if (retainedLabels.length === 1) return retainedLabels[0];
  graph.push(
    `${retainedLabels.map(label => `[${label}]`).join('')}`
    + `concat=n=${retainedLabels.length}:v=0:a=1[acutbase]`,
  );
  return 'acutbase';
}

function appendCodecArgs(args, format, rawCrf, hasOutputAudio) {
  if (format === 'gif') {
    args.push('-c:v', 'gif', '-loop', '0');
    return;
  }

  if (format === 'vp9') {
    const crf = Math.round(finiteNumber(rawCrf, 30, 0, 63));
    args.push(
      '-c:v', 'libvpx-vp9',
      '-crf', numberToken(crf),
      '-b:v', '0',
      '-row-mt', '1',
      '-pix_fmt', 'yuv420p'
    );
    if (hasOutputAudio) args.push('-c:a', 'libopus', '-b:a', '160k');
    return;
  }

  const crf = Math.round(finiteNumber(rawCrf, format === 'hevc' ? 22 : 18, 0, 51));
  if (format === 'hevc') {
    args.push(
      '-c:v', 'libx265',
      '-tag:v', 'hvc1',
      '-crf', numberToken(crf),
      '-preset', 'medium',
      '-pix_fmt', 'yuv420p'
    );
  } else {
    args.push(
      '-c:v', 'libx264',
      '-crf', numberToken(crf),
      '-preset', 'medium',
      '-pix_fmt', 'yuv420p'
    );
  }

  if (hasOutputAudio) args.push('-c:a', 'aac', '-b:a', '192k');
  args.push('-movflags', '+faststart');
}

function normalizeTrim(rawStart, rawEnd) {
  const start = quantizedTimelineTime(finiteNumber(rawStart, 0, 0, MAX_TIME_SECONDS));
  const parsedEnd = Number(rawEnd);
  if (!Number.isFinite(parsedEnd)) {
    return { start, end: null, duration: null };
  }

  const end = Math.max(
    start,
    quantizedTimelineTime(finiteNumber(parsedEnd, start, start, MAX_TIME_SECONDS)),
  );
  return {
    start,
    end,
    duration: roundedNumber(Math.max(0, end - start)),
  };
}

function normalizeRemovedRanges(rawRanges, trim) {
  if (!Array.isArray(rawRanges)) return [];
  if (rawRanges.length > MAX_RAW_REMOVED_RANGES) {
    throw new RangeError('Too many raw cut ranges');
  }

  const ranges = [];
  for (const rawRange of rawRanges) {
    if (!rawRange || typeof rawRange !== 'object') continue;
    const rawStart = firstFinite(rawRange.start, rawRange.startTime);
    const rawEnd = firstFinite(rawRange.end, rawRange.endTime);
    if (rawStart === null || rawEnd === null || rawEnd <= rawStart) continue;

    const start = quantizedTimelineTime(Math.max(trim.start, rawStart));
    const end = quantizedTimelineTime(
      trim.end === null ? rawEnd : Math.min(trim.end, rawEnd),
    );
    if (end - start <= EPSILON) continue;
    ranges.push({ start, end });
  }

  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + EPSILON) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  if (merged.length > MAX_REMOVED_RANGES) throw new RangeError('Too many cut ranges');
  return merged;
}

function normalizeBlurZones(rawZones, trim, removedRanges) {
  if (!Array.isArray(rawZones)) return [];
  const zones = [];

  for (const rawZone of rawZones) {
    if (!rawZone || typeof rawZone !== 'object') continue;
    const x = finiteNumber(rawZone.xPct, 0.1, 0, 0.999);
    const y = finiteNumber(rawZone.yPct, 0.1, 0, 0.999);
    const width = Math.min(finiteNumber(rawZone.wPct, 0.3, 0.001, 1), 1 - x);
    const height = Math.min(finiteNumber(rawZone.hPct, 0.2, 0.001, 1), 1 - y);
    const radius = Math.round(finiteNumber(rawZone.radius, 20, 1, 100));
    const timedRange = normalizeMappedRange(rawZone, trim, removedRanges);
    if (timedRange && timedRange.empty) continue;

    zones.push({
      x: roundedNumber(x),
      y: roundedNumber(y),
      width: roundedNumber(Math.max(0.001, width)),
      height: roundedNumber(Math.max(0.001, height)),
      radius,
      enable: timedRange ? timedRange.enable : '',
    });
  }
  return zones;
}

function normalizeWatermark(rawWatermark, trim, removedRanges) {
  if (!rawWatermark || typeof rawWatermark !== 'object') return null;
  const text = sanitizeWatermarkText(rawWatermark.text);
  if (!text) return null;

  const positions = {
    br: 'x=w-text_w-24:y=h-text_h-24',
    bl: 'x=24:y=h-text_h-24',
    tr: 'x=w-text_w-24:y=24',
    tl: 'x=24:y=24',
    bc: 'x=(w-text_w)/2:y=h-text_h-24',
    tc: 'x=(w-text_w)/2:y=24',
    center: 'x=(w-text_w)/2:y=(h-text_h)/2',
  };
  const timedRange = normalizeMappedRange(rawWatermark, trim, removedRanges);
  if (timedRange && timedRange.empty) return null;

  return {
    text,
    size: Math.round(finiteNumber(rawWatermark.size, 18, 8, 256)),
    opacity: roundedNumber(finiteNumber(rawWatermark.opacity, 0.5, 0, 1)),
    position: positions[rawWatermark.position] || positions.br,
    enable: timedRange ? timedRange.enable : '',
  };
}

function normalizeMappedRange(rawRange, trim, removedRanges) {
  const rawStart = firstFinite(rawRange.start, rawRange.startTime);
  const rawEnd = firstFinite(rawRange.end, rawRange.endTime);
  if (rawStart === null && rawEnd === null) return null;

  const sourceStart = rawStart === null ? trim.start : Math.max(trim.start, rawStart);
  const boundedEnd = rawEnd === null ? trim.end : rawEnd;
  if (boundedEnd === null) {
    const mappedStart = mapSourceTime(sourceStart, trim, removedRanges);
    return { empty: false, enable: `gte(t\\,${numberToken(mappedStart)})` };
  }

  const sourceEnd = trim.end === null ? boundedEnd : Math.min(trim.end, boundedEnd);
  if (sourceEnd <= sourceStart) return { empty: true, enable: '' };
  const mappedStart = mapSourceTime(sourceStart, trim, removedRanges);
  const mappedEnd = mapSourceTime(sourceEnd, trim, removedRanges);
  if (mappedEnd - mappedStart <= EPSILON) return { empty: true, enable: '' };

  return {
    empty: false,
    enable: `between(t\\,${numberToken(mappedStart)}\\,${numberToken(mappedEnd)})`,
  };
}

function mapSourceTime(rawTime, trim, removedRanges) {
  let time = quantizedTimelineTime(Math.max(trim.start, rawTime));
  if (trim.end !== null) time = Math.min(trim.end, time);
  let removedBefore = 0;

  for (const range of removedRanges) {
    if (time >= range.end) {
      removedBefore += range.end - range.start;
      continue;
    }
    if (time > range.start) removedBefore += time - range.start;
    break;
  }

  return roundedNumber(Math.max(0, time - trim.start - removedBefore));
}

function buildCutClock(removedRanges, trimStart) {
  if (!removedRanges.length) return { selection: '', ptsExpression: '' };
  const intervals = removedRanges.map(range => {
    const start = quantizedTimelineTime(range.start - trimStart);
    const end = quantizedTimelineTime(range.end - trimStart);
    return {
      start,
      end,
      duration: quantizedTimelineTime(end - start),
    };
  });
  const selection = `not(${intervals.map(interval => (
    `gte(t\\,${numberToken(interval.start)})*lt(t\\,${numberToken(interval.end)})`
  )).join('+')})`;
  const shift = intervals.map(interval => (
    `gte(PTS*TB\\,${numberToken(interval.end)})*${numberToken(interval.duration)}/TB`
  )).join('+');
  return {
    selection,
    ptsExpression: `PTS-(${shift})`,
  };
}

function totalRemovedDuration(ranges) {
  return roundedNumber(ranges.reduce((total, range) => total + range.end - range.start, 0));
}

function normalizeBackgroundMusic(rawMusic) {
  if (!rawMusic || typeof rawMusic !== 'object') return null;
  if (typeof rawMusic.path !== 'string' || !rawMusic.path.trim()) return null;

  return {
    path: rawMusic.path,
    volume: roundedNumber(finiteNumber(rawMusic.volume, 0.25, 0, 2)),
    duration: roundedNumber(finiteNumber(rawMusic.duration, 0, 0, MAX_TIME_SECONDS)),
    ducking: normalizeDucking(rawMusic.ducking),
  };
}

function finiteMusicLoopCount(expectedDuration, musicDuration) {
  if (!Number.isFinite(expectedDuration) || expectedDuration <= 0) return 0;
  if (!Number.isFinite(musicDuration) || musicDuration <= 0) return 0;
  return Math.max(0, Math.min(10000, Math.ceil(expectedDuration / musicDuration) - 1));
}

function normalizeDucking(rawDucking) {
  const enabled = rawDucking === true
    || (typeof rawDucking === 'number' && Number.isFinite(rawDucking) && rawDucking > 0)
    || (rawDucking && typeof rawDucking === 'object' && rawDucking.enabled !== false);
  const settings = rawDucking && typeof rawDucking === 'object' ? rawDucking : {};

  return {
    enabled: Boolean(enabled),
    threshold: roundedNumber(finiteNumber(settings.threshold, 0.05, 0.0001, 1)),
    ratio: roundedNumber(finiteNumber(settings.ratio, 8, 1, 20)),
    attack: roundedNumber(finiteNumber(settings.attack, 20, 0.01, 2000)),
    release: roundedNumber(finiteNumber(settings.release, 300, 0.01, 5000)),
  };
}

function buildAtempoChain(speed) {
  return buildAtempoFactors(speed).map(factor => `atempo=${numberToken(factor)}`).join(',');
}

function buildAtempoFactors(speed) {
  if (approximatelyEqual(speed, 1)) return [];
  const parts = [];
  let remaining = speed;

  while (remaining > 2 + EPSILON) {
    parts.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5 - EPSILON) {
    parts.push(0.5);
    remaining /= 0.5;
  }
  if (!approximatelyEqual(remaining, 1)) {
    parts.push(remaining);
  }
  return parts;
}

function atempoDelaySamples(speed) {
  let cumulativeTempo = 1;
  let delay = 0;
  for (const factor of buildAtempoFactors(speed)) {
    cumulativeTempo *= factor;
    delay += ATEMPO_ALIGNMENT_SAMPLES / cumulativeTempo;
  }
  return Math.max(0, Math.round(delay));
}

function normalizeFilterChain(value, channel) {
  const values = Array.isArray(value) ? value : [value];
  const chain = values
    .filter(item => typeof item === 'string')
    .map(item => item.trim().replace(/^,+|,+$/g, ''))
    .filter(Boolean)
    .join(',');
  if (!chain) return '';
  validateRendererFilterChain(chain, channel);
  return chain;
}

const FILTER_FONT_FILES = new Set([
  'Arial.ttf', 'Arial Bold.ttf', 'Arial Italic.ttf', 'Arial Bold Italic.ttf',
  'Georgia.ttf', 'Georgia Bold.ttf', 'Georgia Italic.ttf', 'Georgia Bold Italic.ttf',
  'Courier New.ttf', 'Courier New Bold.ttf', 'Courier New Italic.ttf', 'Courier New Bold Italic.ttf',
  'Impact.ttf',
].map(name => `/System/Library/Fonts/Supplemental/${name}`));
const FILTER_EXPRESSION_IDENTIFIERS = new Set([
  't', 'iw', 'ih', 'w', 'h', 'text_w', 'text_h', 'val',
  'if', 'between', 'lt', 'gt', 'ceil', 'cos', 'clip', 'min', 'pow',
]);
const DRAW_TEXT_OPTIONS = new Set([
  'text', 'expansion', 'fontfile', 'fontsize', 'fontcolor', 'x', 'y', 'enable',
  'box', 'boxcolor', 'boxborderw', 'shadowx', 'shadowy', 'shadowcolor',
  'borderw', 'bordercolor', 'alpha',
]);
const FIXED_AUDIO_FILTERS = 'highpass=f=85,lowpass=f=13500,afftdn=nf=-25,'
  + 'acompressor=threshold=-18dB:ratio=2.5:attack=12:release=180:makeup=2dB,'
  + 'loudnorm=I=-16:TP=-1.5:LRA=11';

function validateRendererFilterChain(chain, channel) {
  if (typeof chain !== 'string' || !channel) throw new TypeError('Invalid export filter chain');
  if (Buffer.byteLength(chain, 'utf8') > 12 * 1024 * 1024) throw new Error('Export filter chain is too large');
  if (channel === 'audio') {
    if (chain !== FIXED_AUDIO_FILTERS) throw new Error('Unsupported audio filter chain');
    return true;
  }

  const parts = splitFilterSyntax(chain, ',');
  if (parts.length > 6000) throw new Error('Export filter chain has too many filters');
  const names = parts.map(part => validateFilterPart(part, channel));
  if (channel === 'source') {
    if (parts.length > 2 || names.some(name => name !== 'lutrgb' && name !== 'colorchannelmixer')) {
      throw new Error('Unsupported source filter chain');
    }
    if (new Set(names).size !== names.length) throw new Error('Duplicate source filter');
  } else if (channel === 'camera') {
    if (names.length !== 2 || names[0] !== 'scale' || names[1] !== 'crop') {
      throw new Error('Unsupported camera filter chain');
    }
  } else if (channel === 'overlay') {
    if (names.some(name => name !== 'drawtext')) throw new Error('Unsupported overlay filter chain');
  } else {
    throw new Error('Unknown export filter channel');
  }
  return true;
}

function validateFilterPart(rawPart, channel) {
  const part = rawPart.trim();
  const match = part.match(/^([a-z][a-z0-9_]*)=(.+)$/i);
  if (!match) throw new Error('Malformed export filter');
  const name = match[1].toLowerCase();
  const options = parseFilterOptions(match[2]);

  if (name === 'lutrgb' && channel === 'source') {
    validateOptionKeys(options, new Set(['r', 'g', 'b']), ['r', 'g', 'b']);
    for (const key of ['r', 'g', 'b']) validateExpression(options[key]);
  } else if (name === 'colorchannelmixer' && channel === 'source') {
    const matrixKeys = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'];
    validateOptionKeys(options, new Set(matrixKeys), matrixKeys);
    for (const key of matrixKeys) validateFiniteOption(options[key], -4, 4);
  } else if (name === 'scale' && channel === 'camera') {
    validateOptionKeys(options, new Set(['w', 'h', 'eval']), ['w', 'h', 'eval']);
    validateExpression(options.w);
    validateExpression(options.h);
    if (options.eval !== 'frame') throw new Error('Scale evaluation must be frame based');
  } else if (name === 'crop' && channel === 'camera') {
    validateOptionKeys(options, new Set(['w', 'h', 'x', 'y']), ['w', 'h', 'x', 'y']);
    for (const key of ['w', 'h', 'x', 'y']) validateExpression(options[key]);
  } else if (name === 'drawtext' && channel === 'overlay') {
    validateDrawTextOptions(options);
  } else {
    throw new Error(`Unsupported ${channel} filter`);
  }
  return name;
}

function parseFilterOptions(rawOptions) {
  const result = Object.create(null);
  for (const rawOption of splitFilterSyntax(rawOptions, ':')) {
    const match = rawOption.match(/^([a-z][a-z0-9_]*)=(.*)$/i);
    if (!match) throw new Error('Malformed export filter option');
    const key = match[1].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error('Duplicate export filter option');
    result[key] = match[2].trim();
  }
  return result;
}

function splitFilterSyntax(value, separator) {
  if (/[\u0000\r\n]/.test(value)) throw new Error('Invalid control character in export filter');
  const parts = [];
  let current = '';
  let quoted = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\') {
      if (!['\\', ',', ':', "'", ';', '[', ']', '(', ')'].includes(value[index + 1])) {
        throw new Error('Unsupported escape in export filter');
      }
      current += character + value[index + 1];
      index += 1;
      continue;
    }
    if (character === "'") {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (!quoted) {
      if (character === ';' || character === '[' || character === ']') {
        throw new Error('Export filter graph injection was blocked');
      }
      if (character === '(') depth += 1;
      if (character === ')') {
        depth -= 1;
        if (depth < 0) throw new Error('Unbalanced export filter expression');
      }
      if (character === separator && depth === 0) {
        if (!current.trim()) throw new Error('Empty export filter');
        parts.push(current.trim());
        current = '';
        continue;
      }
    }
    current += character;
  }
  if (quoted || depth !== 0) throw new Error('Unbalanced export filter expression');
  if (!current.trim()) throw new Error('Empty export filter');
  parts.push(current.trim());
  return parts;
}

function validateOptionKeys(options, allowed, required) {
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new Error(`Unsupported export filter option: ${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(options, key)) throw new Error(`Missing export filter option: ${key}`);
  }
}

function validateDrawTextOptions(options) {
  validateOptionKeys(options, DRAW_TEXT_OPTIONS, [
    'text', 'expansion', 'fontfile', 'fontsize', 'fontcolor', 'x', 'y', 'enable',
  ]);
  validateDrawTextToken(options.text);
  if (options.expansion !== 'none') throw new Error('Drawtext expansion must be disabled');
  const fontFile = unquoteLiteral(options.fontfile);
  if (!FILTER_FONT_FILES.has(fontFile)) throw new Error('Unsupported drawtext font file');
  validateExpression(options.fontsize);
  validateColor(options.fontcolor);
  for (const key of ['x', 'y', 'enable']) validateExpression(options[key]);
  for (const key of ['alpha']) {
    if (Object.prototype.hasOwnProperty.call(options, key)) validateExpression(options[key]);
  }
  for (const key of ['box', 'boxborderw', 'shadowx', 'shadowy', 'borderw']) {
    if (Object.prototype.hasOwnProperty.call(options, key)) validateFiniteOption(options[key], 0, 256);
  }
  for (const key of ['boxcolor', 'shadowcolor', 'bordercolor']) {
    if (Object.prototype.hasOwnProperty.call(options, key)) validateColor(options[key]);
  }
}

function validateDrawTextToken(rawValue) {
  const value = String(rawValue);
  if (/^'[^']{0,4096}'$/u.test(value)) return;
  if (!value || value.length > 24000) throw new Error('Invalid drawtext literal');
  const escapedSpecials = new Set(["'", ':', ',', ';', '[', ']', '(', ')']);
  let decodedLength = 0;
  for (let index = 0; index < value.length;) {
    const character = value[index];
    if (character !== '\\') {
      if (escapedSpecials.has(character) || /[\u0000-\u001f\u007f]/u.test(character)) {
        throw new Error('Invalid drawtext literal');
      }
      decodedLength += 1;
      index += 1;
      continue;
    }
    let end = index;
    while (value[end] === '\\') end += 1;
    const count = end - index;
    const next = value[end];
    if (next === undefined) {
      if (count % 4 !== 0) throw new Error('Invalid drawtext escape');
      decodedLength += count / 4;
      index = end;
      continue;
    }
    if (escapedSpecials.has(next)) {
      if (count < 3 || (count - 3) % 4 !== 0) throw new Error('Invalid drawtext escape');
      decodedLength += (count - 3) / 4 + 1;
      index = end + 1;
      continue;
    }
    if (count % 4 !== 0) throw new Error('Invalid drawtext escape');
    decodedLength += count / 4;
    index = end;
  }
  if (decodedLength > 2000) throw new Error('Drawtext literal is too long');
}

function unquoteLiteral(value) {
  const match = String(value).match(/^'([^']*)'$/u);
  if (!match) throw new Error('Expected a quoted export filter literal');
  return match[1];
}

function validateExpression(rawValue) {
  const value = String(rawValue);
  const expression = value.startsWith("'") || value.endsWith("'") ? unquoteLiteral(value) : value;
  if (!expression || expression.length > 256 * 1024) throw new Error('Invalid export filter expression');
  if (!/^[0-9A-Za-z_+*/().,\\\s-]+$/.test(expression)) throw new Error('Unsafe export filter expression');
  for (const identifier of expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
    if (!FILTER_EXPRESSION_IDENTIFIERS.has(identifier)) {
      throw new Error(`Unsupported export expression identifier: ${identifier}`);
    }
  }
}

function validateFiniteOption(rawValue, minimum, maximum) {
  if (!/^-?(?:\d+\.?\d*|\.\d+)(?:dB)?$/.test(String(rawValue))) {
    throw new Error('Export filter option must be numeric');
  }
  const value = Number(String(rawValue).replace(/dB$/, ''));
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error('Export filter option is outside its safe range');
  }
}

function validateColor(value) {
  if (!/^(?:0x[0-9a-f]{6,8}|white|black)(?:@(?:0|1|0?\.\d+))?$/i.test(String(value))) {
    throw new Error('Unsupported export filter color');
  }
}

function sanitizeWatermarkText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\':,%\[\];]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function normalizeFormat(value) {
  const format = String(value || 'h264').trim().toLowerCase();
  if (format === 'gif') return 'gif';
  if (format === 'vp9' || format === 'webm') return 'vp9';
  if (format === 'hevc' || format === 'h265' || format === 'mp4_hevc') return 'hevc';
  return 'h264';
}

function normalizeSourceFrameRate(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)
    || parsed < MIN_SOURCE_FRAME_RATE
    || parsed > MAX_SOURCE_FRAME_RATE) {
    return DEFAULT_SOURCE_FRAME_RATE;
  }
  return roundedNumber(parsed);
}

function exportArtifactPolicy(value) {
  const format = normalizeFormat(value);
  if (format === 'gif') return { extension: '.gif', extensions: ['.gif'] };
  if (format === 'vp9') return { extension: '.webm', extensions: ['.webm'] };
  return { extension: '.mp4', extensions: ['.mp4'] };
}

function requiredPath(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return finiteNumber(parsed, 0, 0, MAX_TIME_SECONDS);
  }
  return null;
}

function finiteNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(maximum, Math.max(minimum, safe));
}

function roundedNumber(value) {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function quantizedTimelineTime(value) {
  if (!Number.isFinite(value)) return 0;
  const quantized = Math.round(value * CUT_CLOCK_HZ) / CUT_CLOCK_HZ;
  return Object.is(quantized, -0) ? 0 : quantized;
}

function makeEven(value) {
  return PresentationEngine.makeEven(value);
}

function numberToken(value) {
  return String(roundedNumber(value));
}

function approximatelyEqual(left, right) {
  return Math.abs(left - right) <= EPSILON;
}

module.exports = {
  buildExportPlan,
  exportArtifactPolicy,
  validateRendererFilterChain,
};
