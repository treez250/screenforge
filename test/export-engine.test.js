'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildExportPlan, exportArtifactPolicy, validateRendererFilterChain } = require('../export-engine');
const SAFE_COLOR_FILTER = "lutrgb=r='clip((val*1.0000-127.5)*1.0500+127.5\\,0\\,255)':g='clip((val*1.0000-127.5)*1.0500+127.5\\,0\\,255)':b='clip((val*1.0000-127.5)*1.0500+127.5\\,0\\,255)'";

function filterGraph(plan) {
  const index = plan.args.indexOf('-filter_complex');
  assert.notEqual(index, -1, 'plan must use a filter_complex graph');
  return plan.args[index + 1];
}

function optionValues(args, option) {
  const values = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === option) values.push(args[index + 1]);
  }
  return values;
}

test('builds an explicitly mapped trimmed H.264 plan without audio', () => {
  const plan = buildExportPlan({
    inputPath: '/tmp/input.webm',
    outputPath: '/tmp/output.mp4',
    trimIn: 2,
    trimOut: 12,
    hasAudio: false,
  });

  assert.equal(plan.outputPath, '/tmp/output.mp4');
  assert.equal(plan.expectedDuration, 10);
  assert.equal(plan.hasOutputAudio, false);
  assert.deepEqual(
    plan.args.slice(0, 9),
    ['-hide_banner', '-nostdin', '-y', '-ss', '2', '-t', '10', '-i', '/tmp/input.webm'],
  );
  assert.deepEqual(optionValues(plan.args, '-map'), ['[vout]']);
  assert.ok(plan.args.includes('-an'));
  assert.equal(optionValues(plan.args, '-c:v').at(-1), 'libx264');
  assert.equal(plan.args.at(-1), plan.outputPath);
  assert.match(filterGraph(plan), /^\[0:v:0\]setpts=PTS-STARTPTS\[vbase\]/);
  assert.match(filterGraph(plan), /\[vbase\]fps=30\[vout\]$/);
});

test('merges, clamps, and removes source-time ranges from video and audio', () => {
  const plan = buildExportPlan({
    inputPath: '/tmp/input.mov',
    outputPath: '/tmp/output.mp4',
    trimIn: 10,
    trimOut: 30,
    removedRanges: [
      { start: 8, end: 12 },
      { startTime: 15, endTime: 20 },
      { start: 18, end: 25 },
      { start: 30, end: 35 },
      { start: Number.NaN, end: 27 },
    ],
    hasAudio: true,
  });

  const graph = filterGraph(plan);
  const selection = "not(gte(t\\,0)*lt(t\\,2)+gte(t\\,5)*lt(t\\,15))";
  const clockShift = "PTS-(gte(PTS*TB\\,2)*2/TB+gte(PTS*TB\\,15)*10/TB)";

  assert.equal(plan.expectedDuration, 8);
  assert.equal(plan.hasOutputAudio, true);
  assert.ok(graph.includes(`select='${selection}',setpts='${clockShift}'`));
  assert.match(
    graph,
    /\[0:a:0\]asetpts=PTS-STARTPTS,asegment=timestamps=2\|5\|15\[asegment0\]\[asegment1\]\[asegment2\]\[asegment3\]/,
  );
  assert.match(graph, /\[asegment0\]anullsink/);
  assert.match(graph, /\[asegment1\]asetpts=PTS-STARTPTS\[acut0\]/);
  assert.match(graph, /\[asegment2\]anullsink/);
  assert.match(graph, /\[asegment3\]asetpts=PTS-STARTPTS\[acut1\]/);
  assert.match(graph, /\[acut0\]\[acut1\]concat=n=2:v=0:a=1\[acutbase\]/);
  assert.doesNotMatch(graph, /aselect=/);
  assert.deepEqual(optionValues(plan.args, '-map'), ['[vout]', '[aout]']);
  assert.equal(optionValues(plan.args, '-c:a').at(-1), 'aac');
});

test('quantizes cuts and mapped overlays onto the same deterministic clock', () => {
  const plan = buildExportPlan({
    inputPath: '/tmp/input.mov',
    outputPath: '/tmp/output.mp4',
    trimIn: 0,
    trimOut: 1,
    removedRanges: [{ start: 0.10000049, end: 0.15000051 }],
    watermark: {
      text: 'Clock',
      startTime: 0.15000051,
      endTime: 0.2,
    },
    speedMultiplier: 2,
    hasAudio: true,
  });

  const graph = filterGraph(plan);
  const selection = "not(gte(t\\,0.1)*lt(t\\,0.150001))";
  const clockShift = "PTS-(gte(PTS*TB\\,0.150001)*0.050001/TB)";

  assert.equal(plan.expectedDuration, 0.475);
  assert.ok(graph.includes(`select='${selection}',setpts='${clockShift}'`));
  assert.match(graph, /asegment=timestamps=0\.1\|0\.150001/);
  assert.match(graph, /\[asegment1\]anullsink/);
  assert.match(graph, /\[acut0\]\[acut1\]concat=n=2:v=0:a=1\[acutbase\]/);
  assert.match(graph, /enable='between\(t\\,0\.1\\,0\.149999\)'/);
  assert.ok(graph.indexOf(clockShift) < graph.indexOf("drawtext=text='Clock'"));
  assert.match(graph, /setpts=PTS\/2,fps=30\[vout\]/);
  assert.match(
    graph,
    /\[acutbase\]aresample=48000,atempo=2,adelay=640S:all=1,apad,atrim=duration=0\.475,asetpts=PTS-STARTPTS\[aout\]/,
  );
});

test('validates declared source frame rates across common production clocks', () => {
  const cases = [
    { value: 24, normalized: 24, frameDuration: 0.041667 },
    { value: 30000 / 1001, normalized: 29.97003, frameDuration: 0.033367 },
    { value: 30, normalized: 30, frameDuration: 0.033333 },
    { value: 60, normalized: 60, frameDuration: 0.016667 },
  ];

  for (const item of cases) {
    const plan = buildExportPlan({
      inputPath: '/tmp/input.mov',
      outputPath: '/tmp/output.mp4',
      trimOut: 1,
      removedRanges: [{ start: 0.005, end: 0.055 }],
      sourceFrameRate: item.value,
      hasAudio: true,
    });
    assert.equal(plan.sourceFrameRate, item.normalized);
    assert.equal(Number((1 / plan.sourceFrameRate).toFixed(6)), item.frameDuration);
    assert.match(
      filterGraph(plan),
      new RegExp(`\\[vbase\\]fps=${String(item.normalized).replace('.', '\\.')}\\[vout\\]`),
    );
    assert.match(filterGraph(plan), /asegment=timestamps=0\.005\|0\.055/);
    assert.match(filterGraph(plan), /\[acutbase\]anull\[aout\]/);
  }

  for (const invalid of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 241, 'invalid']) {
    const plan = buildExportPlan({
      inputPath: '/tmp/input.mov',
      outputPath: '/tmp/output.mp4',
      trimOut: 1,
      sourceFrameRate: invalid,
      hasAudio: false,
    });
    assert.equal(plan.sourceFrameRate, 30);
  }
});

test('segments source audio once and bounds adversarial cut counts', () => {
  const removedRanges = Array.from({ length: 1000 }, (_, index) => ({
    start: index * 0.01 + 0.002,
    end: index * 0.01 + 0.005,
  }));
  const plan = buildExportPlan({
    inputPath: '/tmp/input.mov',
    outputPath: '/tmp/output.mp4',
    trimOut: 10,
    removedRanges,
    hasAudio: true,
  });
  const graph = filterGraph(plan);

  assert.equal((graph.match(/\[0:a:0\]/g) || []).length, 1);
  assert.equal((graph.match(/asegment=timestamps=/g) || []).length, 1);
  assert.equal((graph.match(/anullsink/g) || []).length, 1000);
  assert.match(graph, /concat=n=1001:v=0:a=1\[acutbase\]/);
  assert.doesNotMatch(graph, /aselect=|atrim=start=/);

  const tooManyRanges = Array.from({ length: 1001 }, (_, index) => ({
    start: index * 0.01 + 0.002,
    end: index * 0.01 + 0.005,
  }));
  assert.throws(
    () => buildExportPlan({
      inputPath: '/tmp/input.mov',
      outputPath: '/tmp/output.mp4',
      trimOut: 11,
      removedRanges: tooManyRanges,
      hasAudio: true,
    }),
    /Too many cut ranges/,
  );
});

test('maps regional blur ranges onto the collapsed timeline with a valid graph', () => {
  const plan = buildExportPlan({
    inputPath: '/tmp/input.webm',
    outputPath: '/tmp/output.mp4',
    trimIn: 10,
    trimOut: 40,
    removedRanges: [
      { start: 12, end: 15 },
      { start: 20, end: 25 },
    ],
    blurZones: [{
      startTime: 11,
      endTime: 30,
      xPct: 0.15,
      yPct: 0.2,
      wPct: 0.3,
      hPct: 0.25,
      radius: 24,
    }],
    hasAudio: false,
  });

  const graph = filterGraph(plan);
  assert.equal(plan.expectedDuration, 22);
  assert.match(graph, /\[vbase\]split=2\[vkeep0\]\[vcropin0\]/);
  assert.match(graph, /\[vcropin0\]crop=w=iw\*0\.3:h=ih\*0\.25:x=iw\*0\.15:y=ih\*0\.2,boxblur=luma_radius='min\(24\\,min\(w\\,h\)\/2\)':luma_power=1:chroma_radius='min\(24\\,min\(cw\\,ch\)\/2\)':chroma_power=1\[vblur0\]/);
  assert.match(graph, /\[vkeep0\]\[vblur0\]overlay=x=main_w\*0\.15:y=main_h\*0\.2:enable='between\(t\\,1\\,12\)'\[vblurred0\]/);
  assert.doesNotMatch(graph, /boxblur=[^;]*:(?:x|y|w|h)=/);
});

test('sanitizes watermark text and clamps watermark values', () => {
  const plan = buildExportPlan({
    inputPath: '/tmp/input.webm',
    outputPath: '/tmp/output.mp4',
    trimOut: 20,
    watermark: {
      text: "Creator's: 100% [demo]\nnext",
      size: 999,
      opacity: 5,
      position: 'invalid',
      startTime: 5,
      endTime: 8,
    },
    hasAudio: false,
  });

  const graph = filterGraph(plan);
  assert.match(graph, /drawtext=text='Creator s 100 demo next'/);
  assert.match(graph, /fontsize=256:fontcolor=white@1/);
  assert.match(graph, /x=w-text_w-24:y=h-text_h-24/);
  assert.match(graph, /enable='between\(t\\,5\\,8\)'/);
  assert.doesNotMatch(graph, /Creator's|100%|\[demo\]/);
});

test('changes video and source-audio speed within the supported export range', () => {
  const fast = buildExportPlan({
    inputPath: '/tmp/input.webm',
    outputPath: '/tmp/fast.mp4',
    trimOut: 20,
    speedMultiplier: 16,
    hasAudio: true,
  });
  const slow = buildExportPlan({
    inputPath: '/tmp/input.webm',
    outputPath: '/tmp/slow.mp4',
    trimOut: 20,
    speedMultiplier: 0.25,
    hasAudio: true,
  });

  assert.equal(fast.expectedDuration, 5);
  assert.match(filterGraph(fast), /setpts=PTS\/4,fps=30\[vout\]/);
  assert.match(
    filterGraph(fast),
    /aresample=48000,atempo=2,atempo=2,adelay=960S:all=1,apad,atrim=duration=5,asetpts=PTS-STARTPTS\[aout\]/,
  );
  assert.equal(slow.expectedDuration, 40);
  assert.match(filterGraph(slow), /setpts=PTS\/0\.5,fps=30\[vout\]/);
  assert.match(
    filterGraph(slow),
    /aresample=48000,atempo=0\.5,adelay=2560S:all=1,apad,atrim=duration=40,asetpts=PTS-STARTPTS\[aout\]/,
  );
});

test('loops, gains, ducks, and mixes background music under source audio', () => {
  const plan = buildExportPlan({
    inputPath: '/tmp/input.webm',
    outputPath: '/tmp/output.mp4',
    trimOut: 15,
    hasAudio: true,
    backgroundMusic: {
      path: '/tmp/music.wav',
      duration: 3,
      volume: 0.35,
      ducking: true,
    },
  });

  const graph = filterGraph(plan);
  const loopIndex = plan.args.indexOf('-stream_loop');
  assert.equal(plan.hasOutputAudio, true);
  assert.notEqual(loopIndex, -1);
  assert.deepEqual(
    plan.args.slice(loopIndex, loopIndex + 4),
    ['-stream_loop', '4', '-i', '/tmp/music.wav'],
  );
  assert.match(graph, /\[1:a:0\]asetpts=PTS-STARTPTS,volume=0\.35,atrim=duration=15,asetpts=PTS-STARTPTS\[bgbase\]/);
  assert.match(graph, /\[asource\]asplit=2\[voice_mix\]\[voice_side\]/);
  assert.match(graph, /\[bgbase\]\[voice_side\]sidechaincompress=/);
  assert.match(graph, /\[voice_mix\]\[bgduck\]amix=inputs=2:duration=first:dropout_transition=2:normalize=0\[aout\]/);
  assert.ok(plan.args.includes('-shortest'));
});

test('uses looped background music as the only output audio when source audio is absent', () => {
  const plan = buildExportPlan({
    inputPath: '/tmp/input.webm',
    outputPath: '/tmp/output.webm',
    trimOut: 9,
    format: 'vp9',
    hasAudio: false,
    backgroundMusic: {
      path: '/tmp/music.mp3',
      duration: 2,
      volume: 5,
      ducking: true,
    },
  });

  const graph = filterGraph(plan);
  assert.equal(plan.hasOutputAudio, true);
  assert.doesNotMatch(graph, /\[0:a:0\]/);
  assert.match(graph, /\[1:a:0\]asetpts=PTS-STARTPTS,volume=2,/);
  assert.doesNotMatch(graph, /sidechaincompress|amix=/);
  assert.match(graph, /\[bgbase\]anull\[aout\]/);
  assert.deepEqual(optionValues(plan.args, '-map'), ['[vout]', '[aout]']);
});

test('selects explicit codecs and audio behavior for every supported format', () => {
  const cases = [
    { format: 'h264', path: '/tmp/a.mp4', video: 'libx264', audio: 'aac' },
    { format: 'hevc', path: '/tmp/b.mp4', video: 'libx265', audio: 'aac' },
    { format: 'vp9', path: '/tmp/c.webm', video: 'libvpx-vp9', audio: 'libopus' },
    { format: 'gif', path: '/tmp/d.gif', video: 'gif', audio: null },
  ];

  for (const item of cases) {
    const plan = buildExportPlan({
      inputPath: '/tmp/input.webm',
      outputPath: item.path,
      trimOut: 5,
      format: item.format,
      hasAudio: true,
      backgroundMusic: { path: '/tmp/music.wav', volume: 0.5, ducking: true },
    });

    assert.equal(optionValues(plan.args, '-c:v').at(-1), item.video, item.format);
    assert.equal(optionValues(plan.args, '-c:a').at(-1) || null, item.audio, item.format);
    if (item.audio) {
      assert.equal(plan.hasOutputAudio, true, item.format);
      assert.deepEqual(optionValues(plan.args, '-map'), ['[vout]', '[aout]'], item.format);
    } else {
      assert.equal(plan.hasOutputAudio, false, item.format);
      assert.deepEqual(optionValues(plan.args, '-map'), ['[vout]'], item.format);
      assert.ok(plan.args.includes('-an'), item.format);
      assert.doesNotMatch(filterGraph(plan), /\[[01]:a:0\]/, item.format);
    }
  }
});

test('binds each export codec family to its safe container extension', () => {
  assert.deepEqual(exportArtifactPolicy('gif'), { extension: '.gif', extensions: ['.gif'] });
  assert.deepEqual(exportArtifactPolicy('vp9'), { extension: '.webm', extensions: ['.webm'] });
  assert.deepEqual(exportArtifactPolicy('webm'), { extension: '.webm', extensions: ['.webm'] });
  assert.deepEqual(exportArtifactPolicy('h264'), { extension: '.mp4', extensions: ['.mp4'] });
  assert.deepEqual(exportArtifactPolicy('mp4_hevc'), { extension: '.mp4', extensions: ['.mp4'] });
  assert.deepEqual(exportArtifactPolicy('unexpected'), { extension: '.mp4', extensions: ['.mp4'] });
});

test('allows only ScreenForge-owned filter vocabulary and font files', () => {
  const validOverlay = "drawtext=text='Hello; world\\, safe':expansion=none:fontfile='/System/Library/Fonts/Supplemental/Arial Bold.ttf':fontsize=28:fontcolor=white:x=(w-text_w)/2:y=h-text_h:enable='between(t\\,0\\,1)'";
  assert.equal(validateRendererFilterChain(validOverlay, 'overlay'), true);
  assert.throws(
    () => validateRendererFilterChain('subtitles=/private/secret.srt', 'overlay'),
    /Malformed|Unsupported/,
  );
  assert.throws(
    () => validateRendererFilterChain("drawtext=text='safe':textfile=/private/secret.txt:expansion=none:fontfile='/System/Library/Fonts/Supplemental/Arial.ttf':fontsize=20:fontcolor=white:x=0:y=0:enable='between(t\\,0\\,1)'", 'overlay'),
    /Unsupported|Missing/,
  );
  assert.throws(
    () => validateRendererFilterChain("drawtext=text='safe':expansion=none:fontfile='/private/font.ttf':fontsize=20:fontcolor=white:x=0:y=0:enable='between(t\\,0\\,1)'", 'overlay'),
    /font file/,
  );
  assert.throws(
    () => validateRendererFilterChain("drawtext=text='safe':expansion=none:fontfile='/System/Library/Fonts/Supplemental/Arial.ttf':fontsize=20:fontcolor=white:x=0:y=0:enable='between(t\\,0\\,1)';movie=/private/video.mov", 'overlay'),
    /injection/,
  );
  assert.throws(
    () => validateRendererFilterChain('highpass=f=84', 'audio'),
    /Unsupported audio/,
  );
});

test('accepts optional filter chains and never emits invalid numeric tokens', () => {
  const plan = buildExportPlan({
    inputPath: '/tmp/input.webm',
    outputPath: '/tmp/output.mp4',
    trimIn: -50,
    trimOut: Number.POSITIVE_INFINITY,
    crf: Number.NaN,
    speedMultiplier: 0,
    filters: SAFE_COLOR_FILTER,
    audioFilters: 'highpass=f=85,lowpass=f=13500,afftdn=nf=-25,acompressor=threshold=-18dB:ratio=2.5:attack=12:release=180:makeup=2dB,loudnorm=I=-16:TP=-1.5:LRA=11',
    blurZones: [{ xPct: Number.NaN, yPct: -1, wPct: 9, hPct: 0, radius: Number.NaN }],
    watermark: { text: '\u0000\u0008', size: Number.NaN, opacity: Number.NaN },
    hasAudio: true,
  });

  const rendered = JSON.stringify(plan);
  assert.equal(plan.expectedDuration, null);
  assert.ok(filterGraph(plan).includes(SAFE_COLOR_FILTER));
  assert.match(filterGraph(plan), /highpass=f=85/);
  assert.doesNotMatch(rendered, /undefined|NaN|Infinity/);
  assert.ok(plan.args.every(value => typeof value === 'string'));
});

test('orders source effects, redaction, camera, presentation, and HUD overlays', () => {
  const plan = buildExportPlan({
    inputPath: '/tmp/input.webm',
    outputPath: '/tmp/output.mp4',
    trimOut: 4,
    filters: SAFE_COLOR_FILTER,
    blurZones: [{ startTime: 0, endTime: 4, xPct: 0.1, yPct: 0.1, wPct: 0.2, hPct: 0.2, radius: 12 }],
    sourceOverlays: "drawtext=text='Source':expansion=none:fontfile='/System/Library/Fonts/Supplemental/Arial.ttf':fontsize=20:fontcolor=white:x=10:y=10:enable='between(t\\,0\\,4)'",
    cameraFilters: "scale=w='ceil(640/2)*2':h='ceil(360/2)*2':eval=frame,crop=w=320:h=180:x='80':y='45'",
    presentation: {
      width: 1280,
      height: 720,
      styled: true,
      colors: ['#102040', '#501060'],
      padding: 0.08,
      blur: 0.4,
      frame: true,
    },
    postFilters: "drawtext=text='HUD':expansion=none:fontfile='/System/Library/Fonts/Supplemental/Arial Bold.ttf':fontsize=24:fontcolor=white:x=20:y=20:enable='between(t\\,0\\,4)'",
    hasAudio: false,
  });

  const graph = filterGraph(plan);
  const stages = [
    graph.indexOf(SAFE_COLOR_FILTER),
    graph.indexOf('boxblur='),
    graph.indexOf('[vsourceoverlays]'),
    graph.indexOf('[vcamera]'),
    graph.indexOf('[vpresent]'),
    graph.indexOf('[vpost]'),
  ];
  assert.ok(stages.every(index => index >= 0));
  assert.deepEqual(stages, [...stages].sort((a, b) => a - b));
  assert.match(graph, /\[vfiltered\]split=2\[vpresentationbackground\]\[vpresentationforeground\]/);
  assert.match(graph, /\[vpresentationbackground\].*\[vpresentationbackgroundcamera\]/);
  assert.doesNotMatch(graph, /\[vsourceoverlays\]split=2\[vpbginput\]/);
  assert.match(graph, /drawtext=text='●':expansion=none/);
  assert.match(graph, /gradients=s=\d+x\d+:r=30:c0=0x3d3d3f:c1=0x2c2c2e/);
  assert.match(graph, /geq=lum='if\(lte\(/);
  assert.doesNotMatch(graph, /drawbox=[^,;]*color=0xff5f57/);
});
