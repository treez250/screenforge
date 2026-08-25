'use strict';

const MAX_DURATION_SECONDS = 365 * 24 * 60 * 60;

function buildNormalizeAudioArgs({ inputPath, outputPath } = {}) {
  const input = requiredPath(inputPath, 'inputPath');
  const output = requiredPath(outputPath, 'outputPath');
  return [
    '-hide_banner', '-nostdin', '-y',
    '-i', input,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-movflags', '+faststart',
    output,
  ];
}

function buildMergeClipsArgs({ clips, metadata, outputPath } = {}) {
  if (!Array.isArray(clips) || clips.length < 2 || clips.length > 100) {
    throw new TypeError('clips must contain between 2 and 100 paths');
  }
  if (!Array.isArray(metadata) || metadata.length !== clips.length) {
    throw new TypeError('metadata must describe every clip');
  }

  const inputs = clips.map((clip, index) => requiredPath(clip, `clips[${index}]`));
  const output = requiredPath(outputPath, 'outputPath');
  const width = evenDimension(metadata[0]?.width, 1920);
  const height = evenDimension(metadata[0]?.height, 1080);
  const fps = finiteNumber(metadata[0]?.fps, 30, 1, 120);
  const args = ['-hide_banner', '-nostdin', '-y'];
  for (const input of inputs) args.push('-i', input);

  const graph = [];
  const concatInputs = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const details = metadata[index] || {};
    const duration = finiteNumber(details.duration, 0, 0.01, MAX_DURATION_SECONDS);
    if (duration <= 0.01) throw new TypeError(`metadata[${index}].duration must be positive`);

    graph.push(
      `[${index}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,`
      + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,`
      + `setsar=1,fps=${numberToken(fps)},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${index}]`
    );

    if (details.hasAudio === true) {
      graph.push(
        `[${index}:a:0]aresample=48000:async=1:first_pts=0,`
        + `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,`
        + `apad,atrim=duration=${numberToken(duration)},asetpts=PTS-STARTPTS[a${index}]`
      );
    } else {
      graph.push(
        `anullsrc=channel_layout=stereo:sample_rate=48000,`
        + `atrim=duration=${numberToken(duration)},asetpts=PTS-STARTPTS[a${index}]`
      );
    }
    concatInputs.push(`[v${index}][a${index}]`);
  }

  graph.push(`${concatInputs.join('')}concat=n=${inputs.length}:v=1:a=1[vout][aout]`);
  args.push(
    '-filter_complex', graph.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-movflags', '+faststart',
    output,
  );
  return args;
}

function evenDimension(value, fallback) {
  const rounded = Math.round(finiteNumber(value, fallback, 16, 7680));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function finiteNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(maximum, Math.max(minimum, safe));
}

function numberToken(value) {
  return String(Math.round(Number(value) * 1000) / 1000);
}

function requiredPath(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

module.exports = {
  buildMergeClipsArgs,
  buildNormalizeAudioArgs,
};
