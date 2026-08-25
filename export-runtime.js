'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SCRIPT_THRESHOLD = 64 * 1024;

function materializeFilterComplexArgs(rawArgs, options = {}) {
  if (!Array.isArray(rawArgs) || rawArgs.some(value => typeof value !== 'string')) {
    throw new TypeError('FFmpeg arguments must be strings');
  }

  const args = rawArgs.slice();
  const filterIndex = args.indexOf('-filter_complex');
  const threshold = Math.max(0, Number(options.threshold ?? DEFAULT_SCRIPT_THRESHOLD));
  if (filterIndex < 0 || typeof args[filterIndex + 1] !== 'string'
      || Buffer.byteLength(args[filterIndex + 1], 'utf8') <= threshold) {
    return { args, scriptPath: null, cleanup() {} };
  }

  const tempRoot = path.resolve(options.tempRoot || os.tmpdir());
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, 'screenforge-filter-')));
  fs.chmodSync(directory, 0o700);
  const scriptPath = path.join(directory, 'filter-complex.txt');
  let descriptor = null;
  let cleaned = false;

  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    descriptor = fs.openSync(
      scriptPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeFileSync(descriptor, args[filterIndex + 1], 'utf8');
    fs.closeSync(descriptor);
    descriptor = null;
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(scriptPath); } catch {}
    try { fs.rmdirSync(directory); } catch {}
    throw error;
  }

  args.splice(filterIndex, 2, '-filter_complex_script', scriptPath);
  return {
    args,
    scriptPath,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      try { fs.unlinkSync(scriptPath); } catch {}
      try { fs.rmdirSync(directory); } catch {}
    },
  };
}

module.exports = {
  DEFAULT_SCRIPT_THRESHOLD,
  materializeFilterComplexArgs,
};
