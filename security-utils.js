'use strict';

const fs = require('fs');
const path = require('path');

const VIDEO_EXTENSIONS = Object.freeze(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);

function resolveContainedPath(root, candidate, options = {}) {
  const rootPath = path.resolve(String(root || ''));
  const raw = String(candidate || '');
  if (!rootPath || !raw || raw.includes('\0')) {
    throw new Error('Invalid path');
  }

  const resolved = path.resolve(rootPath, raw);
  const relative = path.relative(rootPath, resolved);
  if (relative === '' && options.allowRoot !== true) {
    throw new Error('A file path is required');
  }
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Path is outside the allowed directory');
  }
  if (options.directChild === true && path.dirname(resolved) !== rootPath) {
    throw new Error('Path must be a direct child of the allowed directory');
  }

  const extensions = Array.isArray(options.extensions)
    ? options.extensions.map(value => String(value).toLowerCase())
    : [];
  if (extensions.length && !extensions.includes(path.extname(resolved).toLowerCase())) {
    throw new Error('Unsupported file type');
  }
  if (options.namePattern && !options.namePattern.test(path.basename(resolved))) {
    throw new Error('Invalid filename');
  }
  return resolved;
}

function cleanDisplayText(value, fallback = '', maxLength = 160) {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(1, Number(maxLength) || 160));
  return cleaned || String(fallback || '').slice(0, maxLength);
}

function cleanFilenameStem(value, fallback = 'Recording', maxLength = 120) {
  return cleanDisplayText(value, fallback, maxLength)
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/^\.+|[. ]+$/g, '')
    .slice(0, maxLength) || fallback;
}

function reserveContainedFile(root, candidate, options = {}) {
  const resolved = resolveContainedPath(root, candidate, options);
  const rootRealPath = fs.realpathSync(path.resolve(String(root)));
  const parentRealPath = fs.realpathSync(path.dirname(resolved));
  if (parentRealPath !== rootRealPath) throw new Error('Output parent is outside the allowed directory');
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(resolved, flags, options.mode ?? 0o600);
  fs.closeSync(descriptor);
  return resolved;
}

function readBoundedRegularFile(rawPath, maxBytes) {
  const filePath = String(rawPath || '');
  const limit = Math.floor(Number(maxBytes));
  if (!filePath || filePath.includes('\0') || !Number.isFinite(limit) || limit < 1) {
    throw new Error('Invalid bounded file read');
  }

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(filePath, flags);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('A regular file is required');
    if (stat.size > limit) throw new Error('File is too large');

    const buffer = Buffer.allocUnsafe(limit + 1);
    let total = 0;
    while (total <= limit) {
      const bytesRead = fs.readSync(descriptor, buffer, total, limit + 1 - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > limit) throw new Error('File is too large');
    return Buffer.from(buffer.subarray(0, total));
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = {
  VIDEO_EXTENSIONS,
  cleanDisplayText,
  cleanFilenameStem,
  readBoundedRegularFile,
  reserveContainedFile,
  resolveContainedPath,
};
