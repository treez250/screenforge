'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSingleFlight,
  discoverCaptureSources,
  normalizeSourceDiscoveryResponse,
  reconcileSourceSelection,
} = require('../renderer/source-discovery');

test('denied Screen Recording still performs one native registration attempt', async () => {
  let enumerations = 0;
  const result = await discoverCaptureSources({
    platform: 'darwin',
    systemPreferences: { getMediaAccessStatus: () => 'denied' },
    enumerateSources: async () => {
      enumerations += 1;
      throw new Error('Failed to get sources.');
    },
  });

  assert.equal(enumerations, 1);
  assert.deepEqual(result, {
    ok: false,
    permission: 'denied',
    code: 'SCREEN_RECORDING_PERMISSION',
    message: 'Screen Recording access is required to capture a display or window.',
    canOpenSettings: true,
    restartRequired: true,
    sources: [],
  });
  assert.doesNotMatch(JSON.stringify(result), /Failed to get sources|remote method/i);
});

test('successful native discovery wins when the cached permission status is denied', async () => {
  const result = await discoverCaptureSources({
    platform: 'darwin',
    systemPreferences: { getMediaAccessStatus: () => 'denied' },
    enumerateSources: async () => [{ id: 'screen:1:0', isScreen: true }],
  });

  assert.deepEqual(result, {
    ok: true,
    permission: 'unknown',
    sources: [{ id: 'screen:1:0', isScreen: true }],
  });
});

test('not-determined permission plus native rejection becomes a permission result', async () => {
  let logged;
  const result = await discoverCaptureSources({
    platform: 'darwin',
    systemPreferences: { getMediaAccessStatus: () => 'not-determined' },
    enumerateSources: async () => { throw new Error('Failed to get sources.'); },
    onError: (error, permission) => { logged = { error, permission }; },
  });

  assert.equal(result.code, 'SCREEN_RECORDING_PERMISSION');
  assert.equal(result.permission, 'not-determined');
  assert.equal(logged.error.message, 'Failed to get sources.');
  assert.equal(logged.permission, 'not-determined');
});

test('granted permission plus native rejection stays a source discovery failure', async () => {
  const result = await discoverCaptureSources({
    platform: 'darwin',
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
    enumerateSources: async () => { throw new Error('Failed to get sources.'); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.permission, 'granted');
  assert.equal(result.code, 'SOURCE_DISCOVERY_FAILED');
  assert.equal(result.canOpenSettings, true);
  assert.equal(result.restartRequired, false);
});

test('successful discovery maps sources into the success envelope', async () => {
  const result = await discoverCaptureSources({
    platform: 'darwin',
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
    enumerateSources: async () => [{ id: 'screen:1:0' }],
    transformSources: sources => sources.map(source => ({ ...source, name: 'Studio Display' })),
  });

  assert.deepEqual(result, {
    ok: true,
    permission: 'granted',
    sources: [{ id: 'screen:1:0', name: 'Studio Display' }],
  });
});

test('renderer normalizes legacy arrays and rejects malformed envelopes', () => {
  assert.deepEqual(normalizeSourceDiscoveryResponse([{ id: 'screen:1:0' }]), {
    ok: true,
    permission: 'unknown',
    sources: [{ id: 'screen:1:0' }],
  });

  const malformed = normalizeSourceDiscoveryResponse({ ok: true, sources: 'invalid' });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'SOURCE_DISCOVERY_FAILED');
  assert.deepEqual(malformed.sources, []);
});

test('selection reconciliation removes stale selections and synchronizes current bounds', () => {
  const sources = [
    { id: 'screen:2:0', isScreen: true, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
    { id: 'window:9:0', isScreen: false, bounds: null },
  ];

  const screenState = reconcileSourceSelection(sources, 'screen:old:0', 'screen');
  assert.equal(screenState.selected.id, 'screen:2:0');
  assert.deepEqual(screenState.sourceBounds, sources[0].bounds);
  assert.deepEqual(screenState.filtered, [sources[0]]);

  const windowState = reconcileSourceSelection(sources, 'screen:2:0', 'window');
  assert.equal(windowState.selected.id, 'window:9:0');
  assert.equal(windowState.sourceBounds, null);
});

test('single-flight source discovery prevents overlapping enumerations', async () => {
  let calls = 0;
  let release;
  const gate = createSingleFlight();
  const task = () => {
    calls += 1;
    return new Promise(resolve => { release = resolve; });
  };

  const first = gate.run(task);
  const second = gate.run(task);
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  release('ready');
  assert.equal(await first, 'ready');
  assert.equal(await second, 'ready');
  assert.equal(await gate.run(async () => 'again'), 'again');
});
