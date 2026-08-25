'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ffmpegPath = require('ffmpeg-static');
const { buildMergeClipsArgs, buildNormalizeAudioArgs } = require('../media-transforms');

function runFfmpeg(args, label) {
  const result = spawnSync(ffmpegPath, args, {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${label} failed\n${result.stderr || result.stdout}`);
  return result;
}

function inspectMedia(filePath) {
  const result = runFfmpeg(['-hide_banner', '-i', filePath, '-f', 'null', '-'], 'media inspection');
  return result.stderr;
}

test('normalizes and merges ScreenForge WebM recordings into compatible MP4 media', { timeout: 45000 }, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-transforms-test-'));
  const webmPath = path.join(tempDir, 'screenforge.webm');
  const mp4Path = path.join(tempDir, 'second.mp4');
  const normalizedPath = path.join(tempDir, 'normalized.mp4');
  const mergedPath = path.join(tempDir, 'merged.mp4');

  try {
    runFfmpeg([
      '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=0.6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.6',
      '-shortest', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8',
      '-c:a', 'libopus', webmPath,
    ], 'ScreenForge WebM fixture');

    runFfmpeg([
      '-y', '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=24:duration=0.4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', mp4Path,
    ], 'mixed-codec MP4 fixture');

    const normalizeArgs = buildNormalizeAudioArgs({ inputPath: webmPath, outputPath: normalizedPath });
    assert.equal(normalizeArgs.includes('copy'), false);
    runFfmpeg(normalizeArgs, 'VP8 and Opus normalization');
    const normalized = inspectMedia(normalizedPath);
    assert.match(normalized, /Video:\s*h264/i);
    assert.match(normalized, /Audio:\s*aac/i);

    const mergeArgs = buildMergeClipsArgs({
      clips: [webmPath, mp4Path],
      metadata: [
        { width: 160, height: 90, fps: 30, duration: 0.6, hasAudio: true },
        { width: 128, height: 96, fps: 24, duration: 0.4, hasAudio: false },
      ],
      outputPath: mergedPath,
    });
    assert.equal(mergeArgs.includes('copy'), false);
    runFfmpeg(mergeArgs, 'mixed-codec merge');
    const merged = inspectMedia(mergedPath);
    assert.match(merged, /Video:\s*h264/i);
    assert.match(merged, /Audio:\s*aac/i);
    assert.match(merged, /160x90/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
