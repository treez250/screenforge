'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const packageJson = require('../package.json');

test('package includes every main-process export module and targets native Apple silicon', () => {
  assert.ok(packageJson.build.files.includes('export-engine.js'));
  assert.ok(packageJson.build.files.includes('export-runtime.js'));
  assert.ok(packageJson.build.files.includes('media-transforms.js'));
  assert.ok(packageJson.build.files.includes('security-utils.js'));
  assert.ok(packageJson.build.files.includes('renderer/**/*'));
  assert.deepEqual(packageJson.build.mac.target, [{ target: 'dmg', arch: ['arm64'] }]);
  assert.equal(packageJson.build.dmg?.sign, true, 'release DMG must be Developer ID signed');
  assert.match(
    packageJson.build.mac.extendInfo?.NSScreenCaptureUsageDescription || '',
    /screen recording/i,
    'the packaged app must explain why Screen Recording access is needed',
  );
});
