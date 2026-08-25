'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, filePathToUrl, safeImageDataUrl } = require('../renderer/safe-render');

test('escapeHtml neutralizes markup and attribute boundaries', () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('x')">&`),
    '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;',
  );
});

test('safeImageDataUrl accepts raster base64 and rejects active URLs', () => {
  assert.equal(safeImageDataUrl('data:image/png;base64,aGVsbG8='), 'data:image/png;base64,aGVsbG8=');
  assert.equal(safeImageDataUrl('data:image/svg+xml,<svg onload=alert(1)>'), '');
  assert.equal(safeImageDataUrl('javascript:alert(1)'), '');
});

test('filePathToUrl encodes special characters and rejects non-absolute paths', () => {
  assert.equal(filePathToUrl('/tmp/a #1.jpg'), 'file:///tmp/a%20%231.jpg');
  assert.equal(filePathToUrl('../private.jpg'), '');
});
