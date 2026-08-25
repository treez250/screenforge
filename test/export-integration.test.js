'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ffmpegPath = require('ffmpeg-static');
const { buildExportPlan } = require('../export-engine');
const { materializeFilterComplexArgs } = require('../export-runtime');
const SAFE_COLOR_FILTER = "lutrgb=r='clip((val*1.0000-127.5)*1.0500+127.5\\,0\\,255)':g='clip((val*1.0000-127.5)*1.0500+127.5\\,0\\,255)':b='clip((val*1.0000-127.5)*1.0500+127.5\\,0\\,255)'";

function runFfmpeg(args, label) {
  const result = spawnSync(ffmpegPath, args, {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `${label} failed\n${result.stderr || result.stdout}`,
  );
  return result;
}

function probeMedia(filePath) {
  const result = runFfmpeg(['-hide_banner', '-i', filePath, '-f', 'null', '-'], 'media probe');
  const duration = result.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return {
    duration: duration
      ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
      : 0,
    hasAudio: /Audio:/i.test(result.stderr),
    hasVideo: /Video:/i.test(result.stderr),
    frameRate: Number(result.stderr.match(/Video:.*?\b(\d+(?:\.\d+)?) fps\b/i)?.[1] || 0),
  };
}

function decodedStreamDuration(filePath, stream) {
  const result = runFfmpeg([
    '-hide_banner', '-i', filePath,
    '-map', stream,
    '-f', 'null', '-',
  ], `${stream} duration probe`);
  const matches = [...result.stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const match = matches.at(-1);
  assert.ok(match, `expected decoded duration for ${stream}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function firstBrightFrameTime(filePath) {
  const result = runFfmpeg([
    '-hide_banner', '-i', filePath,
    '-vf', 'signalstats,metadata=print',
    '-an', '-f', 'null', '-',
  ], 'video marker probe');
  let frameTime = null;
  for (const line of result.stderr.split(/\r?\n/)) {
    const frame = line.match(/frame:\d+\s+pts:\S+\s+pts_time:([\d.]+)/);
    if (frame) frameTime = Number(frame[1]);
    const luminance = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
    if (luminance && Number(luminance[1]) > 100 && frameTime !== null) return frameTime;
  }
  assert.fail('expected a bright video marker');
}

function firstAudioSignalTime(filePath) {
  const result = runFfmpeg([
    '-hide_banner', '-i', filePath,
    '-vn',
    '-af', 'silencedetect=noise=-30dB:d=0.02',
    '-f', 'null', '-',
  ], 'audio marker probe');
  const marker = result.stderr.match(/silence_end: ([\d.]+)/);
  assert.ok(marker, 'expected an audio marker after initial silence');
  return Number(marker[1]);
}

function firstAudioChannelSignalTime(filePath, channel) {
  const result = runFfmpeg([
    '-hide_banner', '-i', filePath,
    '-vn',
    '-af', `pan=mono|c0=c${channel},silencedetect=noise=-30dB:d=0.02`,
    '-f', 'null', '-',
  ], `audio channel ${channel} marker probe`);
  const marker = result.stderr.match(/silence_end: ([\d.]+)/);
  assert.ok(marker, `expected an audio marker on channel ${channel}`);
  return Number(marker[1]);
}

test('encodes the combined creator export graph into synchronized media', { timeout: 45000 }, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-export-test-'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const musicPath = path.join(tempDir, 'music.wav');
  const outputPath = path.join(tempDir, 'output.mp4');

  try {
    runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', 'testsrc2=size=320x180:rate=60:duration=6',
      '-f', 'lavfi',
      '-i', 'sine=frequency=880:sample_rate=48000:duration=6',
      '-shortest',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      inputPath,
    ], 'fixture video creation');

    runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', 'sine=frequency=220:sample_rate=48000:duration=2',
      '-c:a', 'pcm_s16le',
      musicPath,
    ], 'fixture music creation');

    const plan = buildExportPlan({
      inputPath,
      outputPath,
      trimIn: 0,
      trimOut: 6,
      removedRanges: [{ start: 2, end: 3 }],
      hasAudio: true,
      speedMultiplier: 1.25,
      filters: SAFE_COLOR_FILTER,
      sourceOverlays: "drawtext=text='○':expansion=none:fontfile='/System/Library/Fonts/Supplemental/Arial Bold.ttf':fontsize=28:fontcolor=0x5eead4DD:x='w*0.25-text_w/2':y='h*0.25-text_h/2':enable='between(t\\,0.2\\,3.5)'",
      cameraFilters: "scale=w='ceil(400/2)*2':h='ceil(226/2)*2':eval=frame,crop=w=320:h=180:x='46':y='23'",
      blurZones: [{
        startTime: 1,
        endTime: 5,
        xPct: 0.1,
        yPct: 0.15,
        wPct: 0.25,
        hPct: 0.25,
        radius: 10,
      }],
      presentation: {
        width: 640,
        height: 360,
        styled: true,
        mode: 'gradient',
        colors: ['#102040', '#501060'],
        padding: 0.08,
        blur: 0.35,
        frame: true,
      },
      postFilters: "drawtext=text='Creator':expansion=none:fontfile='/System/Library/Fonts/Supplemental/Arial Bold.ttf':fontsize='28*(0.84+0.16*(1-pow(1-min(clip((t-0.2)/0.3\\,0\\,1)\\,clip((3.5-t)/0.3\\,0\\,1))\\,3)))':fontcolor=white:x=(w-text_w)/2:y=h-text_h-h*0.08:enable='between(t\\,0.2\\,3.5)'",
      watermark: { text: 'ScreenForge test', opacity: 0.65, position: 'br' },
      backgroundMusic: { path: musicPath, duration: 2, volume: 0.08, ducking: true },
      format: 'h264',
      crf: 24,
    });

    const runtimePlan = materializeFilterComplexArgs(plan.args, { threshold: 1, tempRoot: tempDir });
    try {
      assert.ok(runtimePlan.scriptPath, 'the integration test must exercise FFmpeg filter scripts');
      runFfmpeg(runtimePlan.args, 'combined export');
    } finally {
      runtimePlan.cleanup();
    }
    const media = probeMedia(outputPath);

    assert.ok(fs.statSync(outputPath).size > 10000);
    assert.equal(media.hasVideo, true);
    assert.equal(media.hasAudio, true);
    assert.equal(media.frameRate, 60);
    assert.ok(Math.abs(media.duration - plan.expectedDuration) <= 0.2, {
      actual: media.duration,
      expected: plan.expectedDuration,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('keeps off-grid short-cut content aligned across source frame clocks', { timeout: 45000 }, () => {
  const cases = [
    { label: '30 fps at 0.5 speed', rate: '30', sourceFrameRate: 30, trimIn: 0, offset: 0.011, speed: 0.5 },
    { label: '24 fps at 0.75 speed', rate: '24', sourceFrameRate: 24, trimIn: 0, offset: 0.007, speed: 0.75 },
    { label: '29.97 fps', rate: '30000/1001', sourceFrameRate: 30000 / 1001, trimIn: 0, offset: 0.005, speed: 1 },
    { label: '30 fps at 1.25 speed with nonzero trim', rate: '30', sourceFrameRate: 30, trimIn: 1, offset: 0.013, speed: 1.25 },
    { label: '60 fps at 2 speed', rate: '60', sourceFrameRate: 60, trimIn: 0, offset: 0.019, speed: 2 },
    { label: '30 fps at 4 speed', rate: '30', sourceFrameRate: 30, trimIn: 0, offset: 0.023, speed: 4 },
  ];

  for (const item of cases) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-cut-clock-test-'));
    const inputPath = path.join(tempDir, 'input.mp4');
    const outputPath = path.join(tempDir, 'output.mp4');
    const sourceDuration = item.trimIn + 10;
    const markerFrame = Math.ceil((item.trimIn + 8.5) * item.sourceFrameRate - 1e-7);
    const markerSourceTime = markerFrame / item.sourceFrameRate;
    const markerEndTime = (markerFrame + 3) / item.sourceFrameRate;
    const removedRanges = Array.from({ length: 40 }, (_, index) => ({
      start: Number((item.trimIn + item.offset + index * 0.2).toFixed(6)),
      end: Number((item.trimIn + item.offset + 0.05 + index * 0.2).toFixed(6)),
    }));

    try {
      runFfmpeg([
        '-y',
        '-f', 'lavfi',
        '-i', `color=black:size=160x90:rate=${item.rate}:duration=${sourceDuration},drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,${markerSourceTime},${markerEndTime})'`,
        '-f', 'lavfi',
        '-i', `aevalsrc=if(between(t\\,${markerSourceTime}\\,${markerEndTime})\\,0.9*sin(2*PI*1000*t)\\,0):s=48000:d=${sourceDuration}`,
        '-shortest',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        inputPath,
      ], `${item.label} short-cut fixture creation`);

      const plan = buildExportPlan({
        inputPath,
        outputPath,
        trimIn: item.trimIn,
        trimOut: item.trimIn + 10,
        removedRanges,
        hasAudio: true,
        sourceFrameRate: item.sourceFrameRate,
        speedMultiplier: item.speed,
        format: 'h264',
        crf: 24,
      });
      const runtimePlan = materializeFilterComplexArgs(plan.args, { threshold: 1, tempRoot: tempDir });
      try {
        runFfmpeg(runtimePlan.args, `${item.label} repeated short-cut export`);
      } finally {
        runtimePlan.cleanup();
      }

      const videoDuration = decodedStreamDuration(outputPath, '0:v:0');
      const audioDuration = decodedStreamDuration(outputPath, '0:a:0');
      const videoMarker = firstBrightFrameTime(outputPath);
      const audioMarker = firstAudioSignalTime(outputPath);
      const expectedMarker = (markerSourceTime - item.trimIn - 2) / item.speed;
      const videoFrameDuration = 1 / item.sourceFrameRate;
      const frameClockTolerance = videoFrameDuration + 1 / 48000;
      const audioClockTolerance = Math.min(0.012, videoFrameDuration) + 1 / 48000;

      assert.equal(plan.expectedDuration, Number((8 / item.speed).toFixed(6)), item.label);
      assert.equal(
        plan.sourceFrameRate,
        Number(item.sourceFrameRate.toFixed(6)),
        item.label,
      );
      assert.ok(
        Math.abs(videoDuration - audioDuration) <= 0.05,
        `${item.label} stream durations differ: video=${videoDuration}, audio=${audioDuration}`,
      );
      assert.ok(
        Math.abs(videoDuration - plan.expectedDuration) <= 0.08,
        `${item.label} video duration ${videoDuration}, expected ${plan.expectedDuration}`,
      );
      assert.ok(
        Math.abs(audioDuration - plan.expectedDuration) <= 0.08,
        `${item.label} audio duration ${audioDuration}, expected ${plan.expectedDuration}`,
      );
      assert.ok(
        Math.abs(videoMarker - audioMarker) <= frameClockTolerance,
        `${item.label} content markers differ: video=${videoMarker}, audio=${audioMarker}`,
      );
      assert.ok(
        Math.abs(videoMarker - expectedMarker) <= frameClockTolerance,
        `${item.label} video marker ${videoMarker}, expected ${expectedMarker}`,
      );
      assert.ok(
        Math.abs(audioMarker - expectedMarker) <= audioClockTolerance,
        `${item.label} audio marker ${audioMarker}, expected ${expectedMarker}`,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('does not leak cut-contained audio across a collapsed seam', { timeout: 45000 }, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-audio-seam-test-'));
  const inputPath = path.join(tempDir, 'input.mkv');
  const outputPath = path.join(tempDir, 'output.mp4');

  try {
    runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', "color=black:size=160x90:rate=30:duration=8,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,7,7.1)'",
      '-f', 'lavfi',
      '-i', 'aevalsrc=if(between(t\\,4.001\\,4.016)+between(t\\,7\\,7.1)\\,0.9*sin(2*PI*1000*t)\\,0):s=48000:d=8',
      '-shortest',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'pcm_s16le',
      inputPath,
    ], 'audio seam fixture creation');

    const plan = buildExportPlan({
      inputPath,
      outputPath,
      trimOut: 8,
      removedRanges: [{ start: 4, end: 6 }],
      hasAudio: true,
      sourceFrameRate: 30,
      format: 'h264',
      crf: 24,
    });
    const runtimePlan = materializeFilterComplexArgs(plan.args, { threshold: 1, tempRoot: tempDir });
    try {
      runFfmpeg(runtimePlan.args, 'audio seam export');
    } finally {
      runtimePlan.cleanup();
    }

    const videoMarker = firstBrightFrameTime(outputPath);
    const audioMarker = firstAudioSignalTime(outputPath);
    assert.ok(audioMarker > 4.9, `cut-contained audio leaked at ${audioMarker}`);
    assert.ok(Math.abs(videoMarker - audioMarker) <= 0.004, {
      videoMarker,
      audioMarker,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('keeps identical stereo pulse timing equal through WSOLA compensation', { timeout: 45000 }, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-stereo-tempo-test-'));
  const inputPath = path.join(tempDir, 'input.mkv');
  const speeds = [0.5, 2, 4];

  try {
    runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', "color=black:size=160x90:rate=30:duration=8,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,7,7.2)'",
      '-f', 'lavfi',
      '-i', 'aevalsrc=if(between(t\\,7\\,7.2)\\,0.9*sin(2*PI*1000*t)\\,0):s=48000:d=8,pan=stereo|c0=c0|c1=c0',
      '-shortest',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'pcm_s16le',
      inputPath,
    ], 'stereo tempo fixture creation');

    for (const speed of speeds) {
      const outputPath = path.join(tempDir, `output-${speed}.mp4`);
      const plan = buildExportPlan({
        inputPath,
        outputPath,
        trimOut: 8,
        removedRanges: [{ start: 2, end: 4 }],
        hasAudio: true,
        sourceFrameRate: 30,
        speedMultiplier: speed,
        format: 'h264',
        crf: 24,
      });
      const runtimePlan = materializeFilterComplexArgs(plan.args, { threshold: 1, tempRoot: tempDir });
      try {
        runFfmpeg(runtimePlan.args, `stereo tempo export at ${speed}`);
      } finally {
        runtimePlan.cleanup();
      }

      const videoMarker = firstBrightFrameTime(outputPath);
      const leftMarker = firstAudioChannelSignalTime(outputPath, 0);
      const rightMarker = firstAudioChannelSignalTime(outputPath, 1);
      const expectedMarker = 5 / speed;
      const sampleTolerance = 1 / 48000;
      const frameTolerance = 1 / 30 + sampleTolerance;

      assert.ok(
        Math.abs(leftMarker - rightMarker) <= sampleTolerance,
        `${speed} stereo markers differ: left=${leftMarker}, right=${rightMarker}`,
      );
      assert.ok(
        Math.abs(videoMarker - leftMarker) <= frameTolerance,
        `${speed} A/V markers differ: video=${videoMarker}, audio=${leftMarker}`,
      );
      assert.ok(
        Math.abs(leftMarker - expectedMarker) <= frameTolerance,
        `${speed} audio marker ${leftMarker}, expected ${expectedMarker}`,
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runs a single-pass 1000-cut audio graph on long media', { timeout: 45000 }, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-cut-stress-test-'));
  const inputPath = path.join(tempDir, 'input.mkv');
  const outputPath = path.join(tempDir, 'output.mp4');
  const removedRanges = Array.from({ length: 1000 }, (_, index) => ({
    start: index * 0.1 + 0.02,
    end: index * 0.1 + 0.03,
  }));

  try {
    runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', 'color=black:size=32x32:rate=1:duration=120',
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:sample_rate=48000:duration=120',
      '-shortest',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'pcm_s16le',
      inputPath,
    ], 'long cut stress fixture creation');

    const plan = buildExportPlan({
      inputPath,
      outputPath,
      trimOut: 120,
      removedRanges,
      hasAudio: true,
      sourceFrameRate: 1,
      format: 'h264',
      crf: 30,
    });
    const runtimePlan = materializeFilterComplexArgs(plan.args, { threshold: 1, tempRoot: tempDir });
    try {
      assert.ok(runtimePlan.scriptPath, 'the stress graph must use a filter script');
      runFfmpeg(runtimePlan.args, '1000-cut long export');
    } finally {
      runtimePlan.cleanup();
    }

    const media = probeMedia(outputPath);
    assert.equal(plan.expectedDuration, 110);
    assert.equal(media.hasVideo, true);
    assert.equal(media.hasAudio, true);
    assert.ok(Math.abs(media.duration - plan.expectedDuration) <= 0.1, {
      actual: media.duration,
      expected: plan.expectedDuration,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
