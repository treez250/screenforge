(function exposeSafeRender(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScreenForgeSafeRender = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSafeRender() {
  'use strict';

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeImageDataUrl(value) {
    const raw = String(value || '');
    return /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(raw) ? raw : '';
  }

  function filePathToUrl(value) {
    const raw = String(value || '');
    if (!raw.startsWith('/') || raw.includes('\0')) return '';
    try {
      const url = new URL('file:///');
      url.pathname = raw;
      return url.href;
    } catch {
      return '';
    }
  }

  return { escapeHtml, filePathToUrl, safeImageDataUrl };
});
