'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const { validateRendererFilterChain } = require('../export-engine');
const { materializeFilterComplexArgs } = require('../export-runtime');

const rendererSource = fs.readFileSync(require.resolve('../renderer/app.js'), 'utf8');
const rendererHtml = fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8');

function loadRendererExportContract() {
  const context = {
    console,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    alert() {},
    prompt() { return null; },
    navigator: {},
    document: {},
    window: {
      addEventListener() {},
      matchMedia() { return { matches: false, addEventListener() {} }; },
      ScreenForgeCreatorEngine: require('../renderer/creator-engine'),
      ScreenForgeTextStyle: require('../renderer/text-style'),
      ScreenForgeSafeRender: require('../renderer/safe-render'),
      ScreenForgeSourceDiscovery: require('../renderer/source-discovery'),
      ScreenForgePresentationEngine: require('../renderer/presentation-engine'),
      ScreenForgeCursorEngine: require('../renderer/cursor-engine'),
    },
  };
  context.globalThis = context;
  context.$ = () => null;
  vm.createContext(context);
  const source = rendererSource
    + '\n;globalThis.__contract = { S, buildFilters, normalizeEditorKeyframes, enforceZoomSegmentBudget, selectedRecordingOutputSize, MAX_ZOOM_SHOTS };';
  vm.runInContext(source, context, { filename: 'renderer/app.js' });
  return context.__contract;
}

test('GIF preset has a real resolution and source overlays are clipped inside the video viewport', () => {
  assert.match(rendererSource, /gif:\s*\{ res: '960:540'/);
  assert.match(rendererHtml, /<option value="960:540">960 × 540<\/option>/);
  assert.match(rendererHtml, /id="previewVideoViewport"[\s\S]*id="sourceOverlayPreviewLayer"[\s\S]*<\/div>\s*<div id="textOverlayPreview"/);
  assert.match(rendererHtml, /data-frame-dot="0"/);
  assert.match(rendererSource, /bar\.querySelectorAll\('\[data-frame-dot\]'\)/);
});

test('cut-split camera moves share the same 80-segment preview and export budget', () => {
  const contract = loadRendererExportContract();
  const keyframes = Array.from({ length: 50 }, (_, index) => ({
    id: index + 1,
    type: 'zoom',
    time: index * 3,
    duration: 2,
    zoomLevel: 1.8,
    xPct: 0.5,
    yPct: 0.5,
  }));
  const removedRanges = keyframes.map(keyframe => ({
    start: keyframe.time + 1,
    end: keyframe.time + 1.2,
  }));
  configureProject(contract, {
    dur: 160,
    trimOut: 160,
    keyframes,
    removedRanges,
  });
  assert.equal(contract.enforceZoomSegmentBudget(), 10);
  assert.equal(contract.S.keyframes.filter(keyframe => keyframe.type === 'zoom').length, 40);
  const bundle = contract.buildFilters('source', false);
  const segmentCount = (bundle.cameraFilters.match(/between\(t\\,/g) || []).length / 4;
  assert.equal(segmentCount, 80);
  assert.equal(validateRendererFilterChain(bundle.cameraFilters, 'camera'), true);
});

test('recorder setup preview uses the shared presentation geometry and selected blur', () => {
  assert.match(rendererSource, /PresentationEngine\.normalizePresentation\(\{/);
  assert.match(rendererSource, /PresentationEngine\.presentationGeometry/);
  assert.match(rendererSource, /presentation\.blur > 0\.001/);
  assert.match(rendererSource, /ctx\.filter = `blur\(\$\{\(\(4 \+ presentation\.blur \* 32\) \* displayScale\)/);
  assert.match(rendererSource, /PresentationEngine\.backgroundCameraGeometry/);
  const contract = loadRendererExportContract();
  contract.S.selected = { bounds: { width: 1440, height: 900 }, scaleFactor: 2 };
  contract.S.cfg.captureArea = null;
  assert.deepEqual({ ...contract.selectedRecordingOutputSize({ naturalWidth: 640, naturalHeight: 360 }) }, {
    width: 1920,
    height: 1200,
    scale: 2 / 3,
  });
  contract.S.selected = { bounds: { width: 2560, height: 1440 }, scaleFactor: 2 };
  contract.S.cfg.captureArea = { xPct: 0, yPct: 0, wPct: 0.2, hPct: 0.2 };
  assert.deepEqual({ ...contract.selectedRecordingOutputSize({ naturalWidth: 640, naturalHeight: 360 }) }, {
    width: 1024,
    height: 576,
    scale: 1,
  });
  contract.S.selected = { bounds: null, scaleFactor: 1 };
  contract.S.cfg.captureArea = null;
  assert.deepEqual({ ...contract.selectedRecordingOutputSize({ naturalWidth: 640, naturalHeight: 360 }) }, {
    width: 1920,
    height: 1080,
    scale: 1,
  });
  assert.doesNotMatch(rendererSource, /_bgAnimTimer\s*=\s*setInterval/);
});

test('text builder previews the chosen motion and timing controls', () => {
  assert.match(rendererSource, /const animation = \['fade', 'slide-up', 'pop', 'none'\]\.includes\(\$\('textAnim'\)/);
  assert.match(rendererSource, /const fadeIn = Math\.min\(duration \* 0\.5/);
  assert.match(rendererSource, /el\.animate\(motionFrames/);
  assert.match(rendererSource, /fontSize: `\$\{\(scaledSize \* popScale\)/);
  assert.doesNotMatch(rendererSource, /animation === 'pop'[\s\S]{0,180}scale\(/);
  assert.match(rendererSource, /iterations: Infinity/);
  assert.match(rendererHtml, /id="textDuration"[\s\S]*liveTextPreview\(\)/);
  assert.match(rendererHtml, /id="textFadeIn"[\s\S]*liveTextPreview\(\)/);
  assert.match(rendererHtml, /id="textFadeOut"[\s\S]*liveTextPreview\(\)/);
  assert.match(rendererHtml, /id="textMotionPreviewLabel"/);
});

function configureProject(contract, values = {}) {
  Object.assign(contract.S, {
    videoW: 320,
    videoH: 180,
    dur: 10,
    trimIn: 0,
    trimOut: 10,
    removedRanges: [],
    keyframes: [],
    recEvents: { cursor: [], clicks: [], keys: [] },
    ...values,
  });
  Object.assign(contract.S.cfg, {
    pad: false,
    frame: false,
    cursor: false,
    cursorTrail: true,
    cursorTheme: 'accent',
    cursorSize: 1,
  });
}

test('the exact camera ceiling initializes in bundled FFmpeg without parser failure', () => {
  const contract = loadRendererExportContract();
  configureProject(contract);
  const rawShots = Array.from({ length: 600 }, (_, index) => ({
    id: index + 1,
    type: 'zoom',
    time: index * 2,
    duration: 1,
    zoomLevel: 1.7,
    xPct: 0.5,
    yPct: 0.5,
  }));
  const shots = contract.normalizeEditorKeyframes(rawShots);
  assert.equal(shots.length, contract.MAX_ZOOM_SHOTS);
  contract.S.keyframes = shots;
  contract.S.trimOut = 1200;
  contract.S.dur = 1200;
  const bundle = contract.buildFilters('source', false);
  assert.match(bundle.cameraFilters, /between\(t\\,158\.00\\,159\.00\)/);
  assert.doesNotMatch(bundle.cameraFilters, /between\(t\\,160\.00\\,161\.00\)/);
  assert.equal(validateRendererFilterChain(bundle.cameraFilters, 'camera'), true);

  const graph = `[0:v]${bundle.cameraFilters}[vout]`;
  const runtime = materializeFilterComplexArgs([
    '-hide_banner', '-v', 'error', '-f', 'lavfi',
    '-i', 'color=c=black:s=320x180:r=1:d=0.1',
    '-filter_complex', graph, '-map', '[vout]',
    '-frames:v', '1', '-f', 'null', '-',
  ], { threshold: 1 });
  try {
    const result = spawnSync(ffmpegPath, runtime.args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    runtime.cleanup();
  }
});

test('cut-overlap zoom and text keep their source phase in a valid FFmpeg graph', { timeout: 30000 }, () => {
  const contract = loadRendererExportContract();
  configureProject(contract, {
    dur: 8,
    trimOut: 8,
    removedRanges: [{ start: 2, end: 4 }],
    keyframes: [
      { id: 1, type: 'zoom', time: 2.5, duration: 2, zoomLevel: 2, xPct: 0.7, yPct: 0.4 },
      {
        id: 2,
        type: 'text',
        time: 2.5,
        duration: 2,
        text: 'Cut phase',
        font: 'Arial',
        size: 28,
        color: '#ffffff',
        bgOpacity: 0,
        position: 'bc',
        animation: 'fade',
        fadeIn: 0.3,
        fadeOut: 0.3,
      },
    ],
  });
  const bundle = contract.buildFilters('source', false);
  assert.match(bundle.cameraFilters, /\(t-2\.00\+1\.500\)/);
  assert.match(bundle.postFilters, /\(t-2\.000000\+1\.500000\)/);
  assert.equal(validateRendererFilterChain(bundle.cameraFilters, 'camera'), true);
  assert.equal(validateRendererFilterChain(bundle.postFilters, 'overlay'), true);

  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-v', 'error', '-f', 'lavfi',
    '-i', 'color=c=black:s=320x180:r=30:d=3',
    '-vf', `${bundle.cameraFilters},${bundle.postFilters}`,
    '-frames:v', '75', '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('cursor export makes a hard positional jump at a removed-range seam', () => {
  const contract = loadRendererExportContract();
  configureProject(contract, {
    removedRanges: [{ start: 4, end: 6 }],
    recEvents: {
      cursor: [
        { time: 0, xPct: 0, yPct: 0.2 },
        { time: 10, xPct: 1, yPct: 0.8 },
      ],
      clicks: [],
      keys: [],
    },
  });
  contract.S.cfg.cursor = true;
  const bundle = contract.buildFilters('source', false);
  assert.match(bundle.sourceOverlays, /0\.40000/);
  assert.match(bundle.sourceOverlays, /0\.60000/);
  assert.match(bundle.sourceOverlays, /enable='between\(t\\,0\.000000\\,4\.000000\)\*lt\(t\\,4\.000000\)'/);
  assert.match(bundle.sourceOverlays, /enable='between\(t\\,4\.000000\\,8\.060000\)'/);
  assert.equal(validateRendererFilterChain(bundle.sourceOverlays, 'overlay'), true);
});

test('cut-split text owns each collapsed seam exactly once', { timeout: 30000 }, () => {
  const contract = loadRendererExportContract();
  configureProject(contract, {
    removedRanges: [{ start: 4, end: 6 }],
    keyframes: [{
      id: 1,
      type: 'text',
      time: 0,
      duration: 10,
      text: 'Seam',
      font: 'Arial, sans-serif',
      size: 32,
      color: '#ffffff',
      position: 'tl',
      animation: 'slide-up',
      fadeIn: 1,
      fadeOut: 1,
    }],
  });
  const filters = contract.buildFilters('source', false).postFilters;
  assert.match(filters, /enable='between\(t\\,0\.000000\\,4\.000000\)\*lt\(t\\,4\.000000\)'/);
  assert.match(filters, /enable='between\(t\\,4\.000000\\,8\.000000\)'/);
  assert.equal(validateRendererFilterChain(filters, 'overlay'), true);
  const segments = filters.split(/,(?=drawtext=)/);
  assert.equal(segments.length, 2);
  const render = chain => spawnSync(ffmpegPath, [
    '-hide_banner', '-v', 'error', '-f', 'lavfi',
    '-i', 'color=c=black:s=320x180:r=30:d=0.1',
    '-vf', `setpts=PTS+4/TB,${chain}`,
    '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
  ], { timeout: 30000, maxBuffer: 1024 * 1024 });
  const combined = render(filters);
  const postCutOnly = render(segments[1]);
  assert.equal(combined.status, 0, combined.stderr?.toString() || 'combined seam render failed');
  assert.equal(postCutOnly.status, 0, postCutOnly.stderr?.toString() || 'post-cut seam render failed');
  assert.deepEqual(combined.stdout, postCutOnly.stdout);
});
