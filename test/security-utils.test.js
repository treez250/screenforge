'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  VIDEO_EXTENSIONS,
  cleanDisplayText,
  cleanFilenameStem,
  readBoundedRegularFile,
  reserveContainedFile,
  resolveContainedPath,
} = require('../security-utils');

test('resolveContainedPath accepts direct media children', () => {
  const root = path.join(path.sep, 'tmp', 'screenforge-library');
  assert.equal(
    resolveContainedPath(root, 'clip.mp4', { directChild: true, extensions: VIDEO_EXTENSIONS }),
    path.join(root, 'clip.mp4'),
  );
});

test('video allowlist includes QuickTime and browser recording formats', () => {
  assert.deepEqual(VIDEO_EXTENSIONS, ['.mp4', '.mov', '.webm', '.mkv', '.m4v']);
});

test('resolveContainedPath rejects traversal, nested files, and unsupported extensions', () => {
  const root = path.join(path.sep, 'tmp', 'screenforge-library');
  assert.throws(() => resolveContainedPath(root, '../private.txt'), /outside/);
  assert.throws(() => resolveContainedPath(root, 'nested/clip.mp4', { directChild: true }), /direct child/);
  assert.throws(
    () => resolveContainedPath(root, 'clip.command', { extensions: VIDEO_EXTENSIONS }),
    /Unsupported/,
  );
});

test('resolveContainedPath validates recovery filenames', () => {
  const root = path.join(path.sep, 'tmp', 'screenforge-recovery');
  const options = { directChild: true, namePattern: /^recovery-[a-z0-9_-]+\.webm$/i };
  assert.equal(resolveContainedPath(root, 'recovery-session_1.webm', options), path.join(root, 'recovery-session_1.webm'));
  assert.throws(() => resolveContainedPath(root, 'other.webm', options), /Invalid filename/);
});

test('display text and filename stems are bounded and filesystem safe', () => {
  assert.equal(cleanDisplayText('  My\n  recording  '), 'My recording');
  assert.equal(cleanFilenameStem(' ../Bad:name?.mp4 '), '-Bad-name-.mp4');
  assert.equal(cleanFilenameStem('', 'Recording'), 'Recording');
  assert.equal(cleanDisplayText('abcdef', '', 3), 'abc');
});

test('exclusive output reservations reject existing and dangling symlink candidates', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-reservation-test-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-reservation-outside-'));
  try {
    const reserved = reserveContainedFile(tempDir, 'export.mp4', {
      directChild: true,
      extensions: VIDEO_EXTENSIONS,
    });
    assert.equal(fs.lstatSync(reserved).isFile(), true);
    assert.throws(
      () => reserveContainedFile(tempDir, 'export.mp4', { directChild: true, extensions: VIDEO_EXTENSIONS }),
      /EEXIST|exist/i,
    );

    const dangling = path.join(tempDir, 'escape.mp4');
    const outsideTarget = path.join(outsideDir, 'outside.mp4');
    fs.symlinkSync(outsideTarget, dangling);
    assert.throws(
      () => reserveContainedFile(tempDir, 'escape.mp4', { directChild: true, extensions: VIDEO_EXTENSIONS }),
      /EEXIST|ELOOP|exist|symbolic/i,
    );
    assert.equal(fs.existsSync(outsideTarget), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('bounded regular-file reads reject oversized files and symbolic links', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-bounded-read-'));
  try {
    const subtitlePath = path.join(tempDir, 'captions.srt');
    fs.writeFileSync(subtitlePath, '1\n00:00:00,000 --> 00:00:01,000\nHello\n');
    assert.equal(readBoundedRegularFile(subtitlePath, 1024).toString('utf8').includes('Hello'), true);

    const oversizedPath = path.join(tempDir, 'oversized.srt');
    fs.writeFileSync(oversizedPath, Buffer.alloc(1025));
    assert.throws(() => readBoundedRegularFile(oversizedPath, 1024), /too large/i);

    const linkedPath = path.join(tempDir, 'linked.srt');
    fs.symlinkSync(subtitlePath, linkedPath);
    assert.throws(() => readBoundedRegularFile(linkedPath, 1024), /ELOOP|symbolic|regular/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
