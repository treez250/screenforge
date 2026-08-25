(function exposeSourceDiscovery(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScreenForgeSourceDiscovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSourceDiscovery() {
  'use strict';

  const ACCESS_STATUSES = new Set([
    'not-determined',
    'granted',
    'denied',
    'restricted',
    'unknown',
  ]);

  function normalizePermission(value, platform = 'darwin') {
    if (platform !== 'darwin') return 'granted';
    const normalized = String(value || '').trim().toLowerCase();
    return ACCESS_STATUSES.has(normalized) ? normalized : 'unknown';
  }

  function readScreenCapturePermission(systemPreferences, platform = 'darwin') {
    if (platform !== 'darwin') return 'granted';
    try {
      return normalizePermission(systemPreferences?.getMediaAccessStatus?.('screen'), platform);
    } catch {
      return 'unknown';
    }
  }

  function isPermissionBlocked(permission) {
    return permission === 'denied' || permission === 'restricted';
  }

  function failureResult(permission, platform = 'darwin') {
    const normalized = normalizePermission(permission, platform);
    const permissionFailure = isPermissionBlocked(normalized) || normalized === 'not-determined';
    return {
      ok: false,
      permission: normalized,
      code: permissionFailure ? 'SCREEN_RECORDING_PERMISSION' : 'SOURCE_DISCOVERY_FAILED',
      message: permissionFailure
        ? 'Screen Recording access is required to capture a display or window.'
        : 'ScreenForge could not load capture sources. Try again.',
      canOpenSettings: platform === 'darwin',
      restartRequired: platform === 'darwin' && permissionFailure,
      sources: [],
    };
  }

  async function discoverCaptureSources({
    platform = 'darwin',
    systemPreferences,
    enumerateSources,
    transformSources = value => value,
    onError = () => {},
  } = {}) {
    try {
      const nativeSources = await enumerateSources();
      const sources = transformSources(nativeSources);
      if (!Array.isArray(sources)) throw new TypeError('Source discovery returned an invalid list');
      const latestPermission = readScreenCapturePermission(systemPreferences, platform);
      return {
        ok: true,
        permission: latestPermission === 'granted' ? 'granted' : 'unknown',
        sources,
      };
    } catch (error) {
      const latestPermission = readScreenCapturePermission(systemPreferences, platform);
      try { onError(error, latestPermission); } catch {}
      return failureResult(latestPermission, platform);
    }
  }

  function normalizeSourceDiscoveryResponse(value, platform = 'darwin') {
    if (Array.isArray(value)) {
      return { ok: true, permission: 'unknown', sources: value };
    }
    if (value?.ok === true && Array.isArray(value.sources)) {
      return {
        ok: true,
        permission: normalizePermission(value.permission, platform) === 'granted' ? 'granted' : 'unknown',
        sources: value.sources,
      };
    }
    if (value?.ok === false && Array.isArray(value.sources)) {
      const fallback = failureResult(value.permission, platform);
      return {
        ...fallback,
        code: value.code === 'SCREEN_RECORDING_PERMISSION'
          ? 'SCREEN_RECORDING_PERMISSION'
          : fallback.code,
        message: typeof value.message === 'string' && value.message.trim()
          ? value.message.slice(0, 240)
          : fallback.message,
        canOpenSettings: value.canOpenSettings === true && platform === 'darwin',
        restartRequired: value.restartRequired === true && platform === 'darwin',
      };
    }
    return failureResult('unknown', platform);
  }

  function reconcileSourceSelection(sources, selectedId, activeTab = 'screen') {
    const safeSources = Array.isArray(sources) ? sources.filter(source => source && typeof source.id === 'string') : [];
    const filtered = safeSources.filter(source => activeTab === 'screen' ? source.isScreen === true : source.isScreen !== true);
    const selected = filtered.find(source => source.id === selectedId) || filtered[0] || null;
    return {
      filtered,
      selected,
      sourceBounds: selected?.bounds || null,
    };
  }

  function createSingleFlight() {
    let active = null;
    return {
      run(task) {
        if (active) return active;
        active = Promise.resolve()
          .then(task)
          .finally(() => { active = null; });
        return active;
      },
    };
  }

  return {
    createSingleFlight,
    discoverCaptureSources,
    failureResult,
    isPermissionBlocked,
    normalizePermission,
    normalizeSourceDiscoveryResponse,
    readScreenCapturePermission,
    reconcileSourceSelection,
  };
});
