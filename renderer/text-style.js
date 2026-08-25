(function exposeTextStyle(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScreenForgeTextStyle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTextStyle() {
  'use strict';

  const FONT_DIR = '/System/Library/Fonts/Supplemental';
  const FONT_FILES = Object.freeze({
    Arial: ['Arial.ttf', 'Arial Bold.ttf', 'Arial Italic.ttf', 'Arial Bold Italic.ttf'],
    Georgia: ['Georgia.ttf', 'Georgia Bold.ttf', 'Georgia Italic.ttf', 'Georgia Bold Italic.ttf'],
    'Courier New': ['Courier New.ttf', 'Courier New Bold.ttf', 'Courier New Italic.ttf', 'Courier New Bold Italic.ttf'],
    Impact: ['Impact.ttf', 'Impact.ttf', 'Arial Italic.ttf', 'Arial Bold Italic.ttf'],
  });

  function supportsBold(cssFont) {
    return !/Impact/i.test(String(cssFont || ''));
  }

  function drawtextFontFile(cssFont, bold, italic) {
    const raw = String(cssFont || '');
    const family = /Georgia/i.test(raw) ? 'Georgia'
      : /Courier/i.test(raw) ? 'Courier New'
      : /Impact/i.test(raw) ? 'Impact'
      : 'Arial';
    const variant = (bold && supportsBold(raw) ? 1 : 0) + (italic ? 2 : 0);
    return `${FONT_DIR}/${FONT_FILES[family][variant]}`;
  }

  function ffFilterPath(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  function ffText(value) {
    const normalized = String(value ?? '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .slice(0, 2000);
    const trailingBackslashes = normalized.match(/\\+$/)?.[0]?.length || 0;
    const body = trailingBackslashes ? normalized.slice(0, -trailingBackslashes) : normalized;
    const escape = '\\'.repeat(3);
    return body
      .replace(/\\/g, '\\'.repeat(4))
      .replace(/[':,;\[\]()]/g, character => escape + character)
      + '\\'.repeat(trailingBackslashes * 4);
  }

  function previewFontFamily(cssFont, bold, italic) {
    const raw = String(cssFont || '');
    if (/Georgia/i.test(raw)) return 'Georgia, serif';
    if (/Courier/i.test(raw)) return '"Courier New", monospace';
    if (/Impact/i.test(raw) && !italic) return 'Impact, sans-serif';
    return 'Arial, sans-serif';
  }

  return { FONT_DIR, FONT_FILES, drawtextFontFile, ffFilterPath, ffText, previewFontFamily, supportsBold };
});
