(function exposePresentationEngine(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScreenForgePresentationEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPresentationEngine() {
  'use strict';

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function makeEven(value) {
    const rounded = Math.max(0, Math.round(Number(value) || 0));
    return rounded - (rounded % 2);
  }

  function color(value, fallback) {
    const raw = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : fallback;
  }

  function normalizePresentation(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const width = makeEven(clamp(Math.round(Number(raw.width) || 0), 16, 7680));
    const height = makeEven(clamp(Math.round(Number(raw.height) || 0), 16, 7680));
    if (width < 16 || height < 16) return null;
    const colors = Array.isArray(raw.colors) ? raw.colors.slice(0, 2) : [];
    const sourceWidth = makeEven(clamp(Math.round(Number(raw.sourceWidth) || width), 16, 7680));
    const sourceHeight = makeEven(clamp(Math.round(Number(raw.sourceHeight) || height), 16, 7680));
    return {
      width,
      height,
      sourceWidth,
      sourceHeight,
      styled: raw.styled === true,
      mode: raw.mode === 'solid' ? 'solid' : 'gradient',
      colors: [color(colors[0], '#2563eb'), color(colors[1], '#7c3aed')],
      solidColor: color(raw.solidColor, '#090d18'),
      padding: raw.styled === true ? clamp(Number(raw.padding) || 0, 0, 0.22) : 0,
      blur: raw.styled === true ? clamp(Number(raw.blur) || 0, 0, 1) : 0,
      frame: raw.styled === true && raw.frame === true,
    };
  }

  function presentationGeometry(rawPresentation, sourceWidth, sourceHeight) {
    const presentation = normalizePresentation(rawPresentation);
    if (!presentation) return null;
    const { width, height } = presentation;
    const padX = Math.round(width * presentation.padding);
    const padY = Math.round(height * presentation.padding);
    const frameHeight = presentation.frame ? Math.max(18, makeEven(Math.round(height * 0.042))) : 0;
    const availableWidth = makeEven(Math.max(16, width - padX * 2));
    const availableContentHeight = makeEven(Math.max(16, height - padY * 2 - frameHeight));
    const srcW = Math.max(1, Number(sourceWidth) || presentation.sourceWidth || width);
    const srcH = Math.max(1, Number(sourceHeight) || presentation.sourceHeight || height);
    const scale = Math.min(availableWidth / srcW, availableContentHeight / srcH);
    const videoWidth = makeEven(Math.max(16, Math.floor(srcW * scale)));
    const videoHeight = makeEven(Math.max(16, Math.floor(srcH * scale)));
    const innerWidth = videoWidth;
    const contentHeight = videoHeight;
    const frameBoxHeight = contentHeight + frameHeight;
    const cornerRadius = presentation.styled
      ? Math.max(6, makeEven(Math.round(Math.min(innerWidth, frameBoxHeight) * 0.012)))
      : 0;
    const boxX = (width - innerWidth) / 2;
    const boxY = (height - frameBoxHeight) / 2;
    const videoX = boxX;
    const videoY = boxY + frameHeight;
    return {
      ...presentation,
      padX,
      padY,
      availableWidth,
      availableContentHeight,
      frameHeight,
      innerWidth,
      frameBoxHeight,
      cornerRadius,
      contentHeight,
      boxX,
      boxY,
      videoX,
      videoY,
      videoWidth,
      videoHeight,
    };
  }

  function mapSourcePoint(rawPresentation, sourceWidth, sourceHeight, xPct, yPct) {
    const geometry = presentationGeometry(rawPresentation, sourceWidth, sourceHeight);
    if (!geometry) return { xPct: Number(xPct), yPct: Number(yPct) };
    const sourceX = Number.isFinite(Number(xPct)) ? Number(xPct) : 0.5;
    const sourceY = Number.isFinite(Number(yPct)) ? Number(yPct) : 0.5;
    return {
      xPct: (geometry.videoX + sourceX * geometry.videoWidth) / geometry.width,
      yPct: (geometry.videoY + sourceY * geometry.videoHeight) / geometry.height,
    };
  }

  function backgroundCameraGeometry(sourceWidth, sourceHeight, displayWidth, displayHeight, rawCamera = {}) {
    const srcW = Math.max(1, Number(sourceWidth) || 1);
    const srcH = Math.max(1, Number(sourceHeight) || 1);
    const outW = Math.max(1, Number(displayWidth) || 1);
    const outH = Math.max(1, Number(displayHeight) || 1);
    const scale = clamp(Number(rawCamera.scale) || 1, 1, 4);
    const focusX = clamp(Number(rawCamera.xPct ?? 0.5), 0, 1);
    const focusY = clamp(Number(rawCamera.yPct ?? 0.5), 0, 1);
    const coverScale = Math.max(outW / srcW, outH / srcH);
    const coverWidth = srcW * coverScale;
    const coverHeight = srcH * coverScale;
    return {
      left: (outW - coverWidth) / 2 - (scale - 1) * focusX * coverWidth,
      top: (outH - coverHeight) / 2 - (scale - 1) * focusY * coverHeight,
      width: coverWidth * scale,
      height: coverHeight * scale,
      coverScale,
      scale,
      focusX,
      focusY,
    };
  }

  return { backgroundCameraGeometry, makeEven, mapSourcePoint, normalizePresentation, presentationGeometry };
});
