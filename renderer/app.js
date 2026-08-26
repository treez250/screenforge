'use strict';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  STATE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const S = {
  // ── Recorder ──
  sources:   [],
  filtered:  [],
  selected:  null,
  activeTab: 'screen',
  sourceDiscovery: null,
  cfg: {
    zoom: true, cursor: true, pad: true, shortcuts: true, clickRings: true,
    mic: false, systemAudio: false, audioCleanup: false, audioCleanupDefaultVersion: 2,
    webcam: false, zoomLevel: 2, webcamPos: 'br', frame: true,
    webcamRect: null, webcamAvoidCursor: true,
    captureArea: null,
    cursorTheme: 'accent', cursorSize: 1, cursorTrail: true,
    captions: true,
    // New in v2
    fps: 30, quality: 'high', countdown: 3, autoSaveToLibrary: true,
    micDefaultVersion: 2, countdownDefaultVersion: 3, fpsDefaultVersion: 2,
    micDeviceId: '', camDeviceId: '',
    webcamShape: 'rounded',     // 'circle' | 'rounded' | 'rect'
    webcamBorderColor: '#ffffff', webcamBorderWidth: 2,
    outputDir: '',              // empty = Desktop
    speedMultiplier: 1,         // export-time speed (0.5/1/2/4)
    watermark: { enabled: false, text: '', position: 'br', opacity: 0.5, size: 18 },
    directorProfile: 'tutorial',
    silenceThreshold: -35,
    silenceMinDuration: 0.5,
    silencePadding: 0.12,
    musicVolume: 0.12,
    musicDucking: true,
    bgMode: 'gradient',
    bgSolidColor: '#1a1a2e',
    bgPadding: 0.05,
    bgBlur: 0.4,
  },
  bgPreset: 0,
  // Blur zones for privacy redaction
  blurZones: [],   // [{ startTime, endTime, xPct, yPct, wPct, hPct, radius }]
  recSessionId: null,
  autoSaveTimer: null,

  // Recording uses a direct stream, so no canvas is needed.
  rawStream: null,
  micStream: null,
  camStream: null,
  canvasStream: null,
  audioStream: null,
  audioContext: null,
  audioNodes: [],
  audioInfo: null,
  nativeMic: null,
  nativeMicStopPromise: null,
  useNativeMic: false,
  compositeVideos: [],
  drawLoop: null,
  drawTimer: null,
  recorder:  null,
  chunks:    [],
  isRec:     false,
  isPaused:  false,
  recStartedAt: 0,
  recPerfStartedAt: 0,
  recPausedAt: 0,
  recPausedTotal: 0,
  recEvents: { clicks: [], keys: [], cursor: [] },
  sourceBounds: null,

  // ── Editor ──
  videoPath:  null,
  dur:        0,
  videoW:     0,
  videoH:     0,
  videoFps:   30,
  videoHasAudio: false,
  trimIn:     0,
  trimOut:    0,
  isDragTrim: null,
  dragX0:     0,
  dragV0:     0,
  keyframes:  [],   // { id, type:'zoom'|'text'|'key'|'click'|'marker', time, ...props }
  cuts:       [],   // [ seconds, ... ], split points
  removedRanges: [], // [{ start, end, source }] - non-destructive timeline removals
  razorMode:  false,
  adj:        { b: 0, c: 0, s: 0 },
  transcript: { text: '', cues: [], srt: '', srtPath: null },

  // ── Text overlay builder ──
  selectedPreset: 'lower-third',
  textPos:        'bl',
  textStyle:      { bold: true, italic: false, shadow: false, outline: false },
};

// Bundled FFmpeg is parser-tested through 80 nested camera segments. The same
// budget is enforced at authoring, cut editing, preview, and export so a shot
// can never disappear only in the rendered file.
const MAX_ZOOM_SHOTS = 80;

const CreatorEngine = window.ScreenForgeCreatorEngine;
const TextStyle = window.ScreenForgeTextStyle;
const SafeRender = window.ScreenForgeSafeRender;
const PresentationEngine = window.ScreenForgePresentationEngine;
const CursorEngine = window.ScreenForgeCursorEngine;
const SourceDiscovery = window.ScreenForgeSourceDiscovery;
const { escapeHtml, filePathToUrl, safeImageDataUrl } = SafeRender;

const IS_ELECTRON = !!window.sf;
const REDUCED_MOTION_QUERY = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
const prefersReducedMotion = () => Boolean(REDUCED_MOTION_QUERY?.matches);
const MAX_RECORDING_WIDTH = 1920;
const MAX_RECORDING_HEIGHT = 1200;
const screenforgeApi = window.sf || {
  async getSources() {
    return {
      ok: true,
      permission: 'unknown',
      sources: [{
        id: 'browser-display',
        name: 'Browser display capture',
        thumbnail: null,
        appIcon: null,
        isScreen: true,
        bounds: null,
        browserFallback: true,
      }],
    };
  },
  async openScreenRecordingSettings() { return false; },
  setSourceBounds() {},
  setCaptureSource() {},
  audioDiagnostic() {},
  startCursorPoll() {},
  stopCursorPoll() {},
  recordingStarted() {},
  recordingStopped() {},
  async saveRecording({ buffer }) {
    const blob = new Blob([buffer], { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ScreenForge-${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.webm`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return url;
  },
  async startNativeMicRecording() { return { ok: false, reason: 'Native microphone capture is unavailable.' }; },
  async stopNativeMicRecording() { return { ok: false, reason: 'Native microphone capture is unavailable.' }; },
  async probeVideo(filePath) {
    return new Promise(resolve => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => resolve({
        duration: v.duration || 0,
        width: v.videoWidth || 0,
        height: v.videoHeight || 0,
        fps: 30,
        hasAudio: undefined,
      });
      v.onerror = () => resolve({ duration: 0, width: 0, height: 0, fps: 30, hasAudio: undefined });
      v.src = filePath;
    });
  },
  onGlobalStop() {},
  onFloatPause() {},
  onFloatMarker() {},
  onFloatScreenshot() {},
  onExportProgress() {},
  onCursorMove() {},
  onMouseDown() {},
  onKeyDown() {},
};


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TEXT PRESETS: every property locked in, user only picks color + duration
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PRESETS = [
  {
    id: 'lower-third',
    label: 'Lower Third',
    font: 'Inter,sans-serif', size: 32, bold: true, italic: false,
    shadow: false, outline: false,
    bgColor: '#070b14', bgOpacity: 88,
    position: 'bl', animation: 'slide-up',
    // mini card preview HTML (shown at ~110×62px)
    card: `<div style="position:absolute;bottom:0;left:0;right:0;
             background:rgba(7,11,20,0.9);padding:5px 8px;
             border-left:2px solid #4da6ff;">
             <div style="font:700 9px/1.3 Inter,sans-serif;color:#fff;letter-spacing:.3px">LOWER THIRD</div>
             <div style="font:400 7px/1.2 Inter,sans-serif;color:rgba(255,255,255,.55);margin-top:1px">Your subtitle here</div>
           </div>`,
  },
  {
    id: 'big-title',
    label: 'Big Title',
    font: 'Inter,sans-serif', size: 68, bold: true, italic: false,
    shadow: true, outline: false,
    bgColor: '#000000', bgOpacity: 0,
    position: 'mc', animation: 'fade',
    card: `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
             <div style="font:800 17px/1 Inter,sans-serif;color:#fff;
                         text-shadow:0 3px 16px rgba(0,0,0,1),0 1px 4px rgba(0,0,0,.9);
                         letter-spacing:-0.5px">HEADLINE</div>
           </div>`,
  },
  {
    id: 'caption',
    label: 'Caption',
    font: 'Inter,sans-serif', size: 26, bold: false, italic: false,
    shadow: false, outline: false,
    bgColor: '#000000', bgOpacity: 78,
    position: 'bc', animation: 'fade',
    card: `<div style="position:absolute;bottom:6px;left:0;right:0;display:flex;justify-content:center;">
             <div style="font:400 9px/1.4 Inter,sans-serif;color:#fff;
                         background:rgba(0,0,0,0.78);padding:3px 10px;border-radius:3px;
                         max-width:88%;text-align:center">Caption text goes here</div>
           </div>`,
  },
  {
    id: 'callout',
    label: 'Callout',
    font: 'Inter,sans-serif', size: 24, bold: true, italic: false,
    shadow: false, outline: false,
    bgColor: '#4da6ff', bgOpacity: 95,
    position: 'bl', animation: 'slide-up',
    card: `<div style="position:absolute;bottom:7px;left:7px;">
             <div style="font:700 8px/1 Inter,sans-serif;color:#090d18;
                         background:rgba(77,166,255,0.95);padding:4px 9px;
                         border-radius:999px">✦ Callout text</div>
           </div>`,
  },
  {
    id: 'kinetic',
    label: 'Kinetic',
    font: 'Inter,sans-serif', size: 80, bold: true, italic: false,
    shadow: true, outline: false,
    bgColor: '#000000', bgOpacity: 0,
    position: 'mc', animation: 'pop',
    card: `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
             <div style="font:900 22px/1 Inter,sans-serif;color:#fff;
                         text-shadow:0 4px 20px rgba(0,0,0,1);letter-spacing:-1px;
                         transform:scale(1.05)">WORD</div>
           </div>`,
  },
  {
    id: 'news-bar',
    label: 'News Bar',
    font: 'Inter,sans-serif', size: 22, bold: false, italic: false,
    shadow: false, outline: false,
    bgColor: '#0d1117', bgOpacity: 94,
    position: 'bc', animation: 'slide-up',
    card: `<div style="position:absolute;bottom:0;left:0;right:0;
             background:rgba(13,17,23,0.94);padding:4px 8px;display:flex;align-items:center;gap:5px;">
             <div style="width:3px;height:12px;background:#4da6ff;border-radius:1px;flex-shrink:0"></div>
             <div style="font:400 8px/1 Inter,sans-serif;color:#dce8f8;letter-spacing:.6px;text-transform:uppercase">Breaking news • info bar text here</div>
           </div>`,
  },
  {
    id: 'whisper',
    label: 'Whisper',
    font: 'Inter,sans-serif', size: 18, bold: false, italic: true,
    shadow: true, outline: false,
    bgColor: '#000000', bgOpacity: 0,
    position: 'tr', animation: 'fade',
    card: `<div style="position:absolute;top:6px;right:7px;">
             <div style="font:400 italic 8px/1.3 Inter,sans-serif;color:rgba(255,255,255,0.7);
                         text-shadow:0 1px 5px rgba(0,0,0,.9)">subtle note here</div>
           </div>`,
  },
  {
    id: 'quote',
    label: 'Quote',
    font: 'Georgia,serif', size: 36, bold: false, italic: true,
    shadow: true, outline: false,
    bgColor: '#000000', bgOpacity: 0,
    position: 'mc', animation: 'fade',
    card: `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:8px;">
             <div style="font:italic 11px/1.5 Georgia,serif;color:#fff;text-align:center;
                         text-shadow:0 2px 10px rgba(0,0,0,1);">"Your quote here"</div>
           </div>`,
  },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BACKGROUND PRESETS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Mesh gradient presets with vivid, saturated Screen-Studio-style blobs
const BG_PRESETS = [
  {
    label: 'Ocean',
    swatch: ['#3b82f6', '#8b5cf6'],
    base: '#04060f',
    blobs: [
      { x:0.10, y:0.15, r:0.85, color:'#2563eb' },
      { x:0.90, y:0.85, r:0.75, color:'#7c3aed' },
      { x:0.55, y:0.45, r:0.50, color:'#3b82f6' },
    ],
  },
  {
    label: 'Dusk',
    swatch: ['#a855f7', '#ec4899'],
    base: '#08040f',
    blobs: [
      { x:0.08, y:0.20, r:0.75, color:'#9333ea' },
      { x:0.90, y:0.70, r:0.70, color:'#db2777' },
      { x:0.45, y:0.88, r:0.50, color:'#a855f7' },
    ],
  },
  {
    label: 'Ember',
    swatch: ['#f97316', '#ec4899'],
    base: '#0f0406',
    blobs: [
      { x:0.12, y:0.30, r:0.72, color:'#ea580c' },
      { x:0.85, y:0.22, r:0.65, color:'#e11d48' },
      { x:0.50, y:0.82, r:0.55, color:'#c2410c' },
    ],
  },
  {
    label: 'Forest',
    swatch: ['#10b981', '#3b82f6'],
    base: '#02080a',
    blobs: [
      { x:0.15, y:0.25, r:0.72, color:'#059669' },
      { x:0.82, y:0.72, r:0.68, color:'#2563eb' },
      { x:0.48, y:0.08, r:0.48, color:'#10b981' },
    ],
  },
  {
    label: 'Gold',
    swatch: ['#f59e0b', '#ec4899'],
    base: '#0a0604',
    blobs: [
      { x:0.18, y:0.18, r:0.68, color:'#d97706' },
      { x:0.82, y:0.78, r:0.68, color:'#db2777' },
      { x:0.52, y:0.52, r:0.42, color:'#f59e0b' },
    ],
  },
  {
    label: 'Noir',
    swatch: ['#334155', '#1e293b'],
    base: '#050505',
    blobs: [
      { x:0.20, y:0.20, r:0.80, color:'#1e293b' },
      { x:0.85, y:0.80, r:0.60, color:'#0f172a' },
    ],
  },
];

const DIALOG_IDS = ['exportModal', 'textModal', 'shortcutsModal', 'libraryPanel'];
const dialogReturnFocus = new WeakMap();

function dialogFocusables(dialog) {
  return [...dialog.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter(element => {
    if (element.closest('[hidden], .hidden')) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

function openAccessibleDialog(id, preferredFocusId) {
  const dialog = $(id);
  if (!dialog) return;
  if (document.activeElement instanceof HTMLElement && !dialog.contains(document.activeElement)) {
    dialogReturnFocus.set(dialog, document.activeElement);
  }
  dialog.classList.remove('hidden');
  dialog.setAttribute('aria-hidden', 'false');
  setTimeout(() => {
    const preferred = preferredFocusId ? $(preferredFocusId) : null;
    (preferred || dialogFocusables(dialog)[0])?.focus();
  }, 0);
}

function closeAccessibleDialog(id, { restoreFocus = true } = {}) {
  const dialog = $(id);
  if (!dialog) return;
  dialog.classList.add('hidden');
  dialog.setAttribute('aria-hidden', 'true');
  const restore = dialogReturnFocus.get(dialog);
  dialogReturnFocus.delete(dialog);
  if (restoreFocus) setTimeout(() => restore?.isConnected && restore.focus(), 0);
}

function handleAccessibleDialogKeydown(event) {
  const dialog = DIALOG_IDS.map($).reverse().find(element => element && !element.classList.contains('hidden'));
  if (!dialog) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (dialog.id === 'textModal') closeTextModal();
    else if (dialog.id === 'exportModal') closeExportPanel();
    else if (dialog.id === 'libraryPanel') hideLibraryPanel();
    else hideShortcutsHelp();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusables = dialogFocusables(dialog);
  if (!focusables.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  INIT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

window.addEventListener('DOMContentLoaded', async () => {
  showRuntimeMode();
  initBgSwatches();
  initBgCanvas();
  loadSources();
  loadDevices();
  syncConfigControls();
  initializeAccessibility();
  syncCaptureNav();
  checkRecoverySessions();
  loadPersistedSettings().then(() => syncRecordMeBtn());
  loadRemoteUrl();

  if (IS_ELECTRON) {
    screenforgeApi.onGlobalStop(()        => stopRecording());
    screenforgeApi.onFloatPause(()        => togglePauseRecording());
    screenforgeApi.onFloatMarker(()       => addMarker());
    screenforgeApi.onFloatScreenshot(()   => takeScreenshotDuringRecording());
    screenforgeApi.onExportProgress(t     => onExportTick(t));
    screenforgeApi.onCursorMove(d         => ingestCursor(d));
    screenforgeApi.onMouseDown(d          => ingestClick(d));
    screenforgeApi.onKeyDown(d            => ingestKey(d));
    screenforgeApi.onMainError?.(d        => reportMainFault(d));
  }

  installRendererFaultHooks();

  const vid = $('videoPreview');
  vid.addEventListener('loadedmetadata', onVideoLoaded);
  vid.addEventListener('timeupdate',     onTimeUpdate);
  vid.addEventListener('play',           () => syncPreviewBackdrop(vid.currentTime));
  vid.addEventListener('pause',          () => syncPreviewBackdrop(vid.currentTime));
  vid.addEventListener('seeked',         () => {
    syncPreviewBackdrop(vid.currentTime);
    onTimeUpdate();
  });
  vid.addEventListener('ended', () => { $('playBtn').textContent = '▶'; });
  if (window.ResizeObserver) {
    new ResizeObserver(syncPreviewStageGeometry).observe($('previewArea'));
  }

  document.addEventListener('mousemove', e => { doTrimDrag(e); doMiniTrimDrag(e); doBlurZoneDrag(e); });
  document.addEventListener('mouseup',   () => { endTrimDrag(); endMiniTrimDrag(); endBlurZoneDrag(); });
  document.addEventListener('keydown', handleAccessibleDialogKeydown);

  document.addEventListener('keydown', e => {
    if (!$('screenEditor').classList.contains('flex')) return;
    if (e.defaultPrevented) return;
    if (DIALOG_IDS.some(id => {
      const dialog = $(id);
      return dialog && !dialog.classList.contains('hidden');
    })) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('button, a, input, textarea, select, summary, [contenteditable="true"], [role="button"], [role="switch"], [role="slider"]')) return;
    if (e.code === 'Space')      { e.preventDefault(); togglePlay(); }
    if (e.key  === 'k')          togglePlay();
    if (e.key  === 'j')          seekRelative(-10);
    if (e.key  === 'l')          seekRelative(10);
    // Clip in/out/cut shortcuts
    if (e.key  === 'i' || e.key === 'I') { e.preventDefault(); setInPoint(); }
    if (e.key  === 'o' || e.key === 'O') { e.preventDefault(); setOutPoint(); }
    if (e.key  === 'c' || e.key === 'C') { e.preventDefault(); cutAtPlayhead(); }
    // Arrow: plain = 5s seek, Shift = single frame step
    if (e.code === 'ArrowLeft')  { e.shiftKey ? frameStep(-1) : seekRelative(-5); }
    if (e.code === 'ArrowRight') { e.shiftKey ? frameStep(1)  : seekRelative(5); }
  });

  initializeBrowserEditorPreview();
});

function showRuntimeMode() {
  if (IS_ELECTRON) return;
  if (new URLSearchParams(location.search).has('preview')) return;
  const banner = document.createElement('div');
  banner.className = 'nd';
  banner.style.cssText = `
    position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:9999;
    padding:7px 12px;border-radius:999px;
    background:rgba(251,191,36,.13);border:1px solid rgba(251,191,36,.28);
    color:#fde68a;font:700 11px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;
    box-shadow:0 10px 30px rgba(0,0,0,.28);pointer-events:none;
  `;
  banner.textContent = 'Browser preview mode: recording downloads as WebM. Launch Electron for project saving and MP4 export.';
  document.body.appendChild(banner);
}

function initializeAccessibility() {
  const humanize = value => String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/^./, letter => letter.toUpperCase());

  document.querySelectorAll('input, select, textarea').forEach(control => {
    if (control.getAttribute('aria-label') || control.getAttribute('aria-labelledby')) return;
    if (control.id && document.querySelector(`label[for="${CSS.escape(control.id)}"]`)) return;
    if (control.closest('label')) return;
    const fallback = control.title || control.placeholder || humanize(control.id || control.name || control.type);
    control.setAttribute('aria-label', fallback || 'Editor control');
  });

  document.querySelectorAll('.option-row').forEach(row => {
    const state = row.querySelector('[id^="toggle-"]');
    const key = state?.id?.replace(/^toggle-/, '');
    if (!key) return;
    state.setAttribute('aria-hidden', 'true');
    state.removeAttribute('aria-pressed');
    state.removeAttribute('aria-checked');
    row.setAttribute('role', 'switch');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-checked', String(Boolean(S.cfg[key])));
    row.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      row.click();
    });
  });

  document.querySelectorAll('.insp-icon[title]').forEach(button => {
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(button.classList.contains('active')));
  });

  document.querySelectorAll('.export-chip').forEach(button => {
    button.setAttribute('aria-pressed', String(button.classList.contains('active')));
  });

  ['bold', 'italic', 'shadow', 'outline'].forEach(key => {
    const button = $(`btn-${key}`);
    if (!button) return;
    button.setAttribute('aria-label', humanize(key));
    button.setAttribute('aria-pressed', String(Boolean(S.textStyle[key])));
  });

  const textPositions = {
    tl: 'Top left', tc: 'Top center', tr: 'Top right',
    ml: 'Middle left', mc: 'Middle center', mr: 'Middle right',
    bl: 'Bottom left', bc: 'Bottom center', br: 'Bottom right',
  };
  document.querySelectorAll('.pos-btn').forEach(button => {
    const key = button.id.replace(/^pos-/, '');
    button.setAttribute('aria-label', textPositions[key] || 'Text position');
    button.setAttribute('aria-pressed', String(key === S.textPos));
  });

  document.querySelectorAll('[id^="toggle-"]').forEach(toggle => {
    if (toggle.closest('.option-row')) return;
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('tabindex', '0');
    toggle.setAttribute('aria-label', humanize(toggle.id.replace(/^toggle-/, '')));
    toggle.removeAttribute('aria-pressed');
    const sync = () => toggle.setAttribute('aria-checked', String(toggle.classList.contains('toggle-on')));
    sync();
    toggle.addEventListener('click', () => queueMicrotask(sync));
    toggle.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle.click();
    });
  });

  const seekByKeyboard = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const video = $('videoPreview');
    if (!video) return;
    event.preventDefault();
    if (event.key === 'Home') video.currentTime = S.trimIn;
    else if (event.key === 'End') video.currentTime = S.trimOut;
    else {
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const step = event.shiftKey ? 1 / Math.max(1, Number(S.videoFps) || 30) : 1;
      video.currentTime = clamp(video.currentTime + direction * step, S.trimIn, S.trimOut);
    }
    updateTimelineAria();
  };
  ['scrubBar', 'mainTrack', 'kfTrack', 'miniTimeline'].forEach(id => {
    const track = $(id);
    if (!track) return;
    track.setAttribute('role', 'slider');
    track.setAttribute('tabindex', '0');
    track.setAttribute('aria-label', id === 'miniTimeline' ? 'Clip timeline' : 'Editor playhead');
    track.addEventListener('keydown', seekByKeyboard);
  });

  [['trimLeft', 'in'], ['trimRight', 'out'], ['mtHandleIn', 'in'], ['mtHandleOut', 'out']].forEach(([id, edge]) => {
    const handle = $(id);
    if (!handle) return;
    handle.setAttribute('role', 'slider');
    handle.setAttribute('tabindex', '0');
    handle.setAttribute('aria-label', `${edge === 'in' ? 'In' : 'Out'} trim point`);
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const step = event.shiftKey ? 1 / Math.max(1, Number(S.videoFps) || 30) : 0.1;
      if (edge === 'in') S.trimIn = clamp(S.trimIn + direction * step, 0, Math.max(0, S.trimOut - 0.1));
      else S.trimOut = clamp(S.trimOut + direction * step, Math.min(S.dur, S.trimIn + 0.1), S.dur);
      updateTrimDisplay();
      updateTrimHandles();
      updateTimelineAria();
      commitTrimCameraBudget();
    });
  });

  document.querySelectorAll('div[onclick], span[onclick]').forEach(control => {
    if (control.hasAttribute('role')) return;
    control.setAttribute('role', 'button');
    control.setAttribute('tabindex', '0');
    if (!control.getAttribute('aria-label')) {
      control.setAttribute('aria-label', control.title || humanize(control.id) || 'Editor action');
    }
    control.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      control.click();
    });
  });

  const stats = $('recStatsBar');
  if (stats) {
    stats.setAttribute('role', 'status');
    stats.setAttribute('aria-live', 'polite');
  }
  updateTimelineAria();
}

function updateTimelineAria() {
  const video = $('videoPreview');
  const current = Number(video?.currentTime) || 0;
  ['scrubBar', 'mainTrack', 'kfTrack', 'miniTimeline'].forEach(id => {
    const track = $(id);
    if (!track) return;
    track.setAttribute('aria-valuemin', String(Number(S.trimIn) || 0));
    track.setAttribute('aria-valuemax', String(Number(S.trimOut) || Number(S.dur) || 0));
    track.setAttribute('aria-valuenow', String(current));
    track.setAttribute('aria-valuetext', fmtTime(current));
  });
  ['trimLeft', 'mtHandleIn'].forEach(id => {
    const handle = $(id);
    if (!handle) return;
    handle.setAttribute('aria-valuemin', '0');
    handle.setAttribute('aria-valuemax', String(Math.max(0, Number(S.trimOut) - 0.1)));
    handle.setAttribute('aria-valuenow', String(Number(S.trimIn) || 0));
    handle.setAttribute('aria-valuetext', fmtTime(Number(S.trimIn) || 0));
  });
  ['trimRight', 'mtHandleOut'].forEach(id => {
    const handle = $(id);
    if (!handle) return;
    handle.setAttribute('aria-valuemin', String(Math.min(Number(S.dur) || 0, Number(S.trimIn) + 0.1)));
    handle.setAttribute('aria-valuemax', String(Number(S.dur) || 0));
    handle.setAttribute('aria-valuenow', String(Number(S.trimOut) || 0));
    handle.setAttribute('aria-valuetext', fmtTime(Number(S.trimOut) || 0));
  });
}

function initializeBrowserEditorPreview() {
  if (IS_ELECTRON) return;
  const params = new URLSearchParams(location.search);
  if (params.get('preview') !== 'editor') return;
  S.dur = 72;
  S.videoW = 1920;
  S.videoH = 1080;
  S.trimIn = 2;
  S.trimOut = 68;
  S.keyframes = [
    { id: 91001, type: 'zoom', time: 8, duration: 5, zoomLevel: 1.55, source: 'action-director' },
    { id: 91002, type: 'zoom', time: 25, duration: 4.5, zoomLevel: 1.7, source: 'action-director' },
    { id: 91003, type: 'text', time: 42, duration: 5, text: 'Chapter two' },
  ];
  S.cuts = [18, 36, 54];
  S.removedRanges = [{ start: 31, end: 34, source: 'silence' }];
  const previewResolutionAliases = { vertical: '1080:1920', square: '1080:1080', portrait: '1080:1350' };
  const requestedResolution = previewResolutionAliases[params.get('res')] || params.get('res');
  const resolutionControl = $('exportRes');
  if (resolutionControl && [...resolutionControl.options].some(option => option.value === requestedResolution)) {
    resolutionControl.value = requestedResolution;
  }
  showScreen('editor');
  updateTrimHandles();
  updateTrimDisplay();
  drawKfLayer();
  renderKfLists();
  if (params.get('panel')) switchInspPanel(params.get('panel'));
  requestAnimationFrame(() => {
    const viewport = $('previewVideoViewport');
    if (viewport && !$('browserPreviewMock')) {
      const mock = document.createElement('div');
      mock.id = 'browserPreviewMock';
      mock.setAttribute('aria-hidden', 'true');
      mock.style.cssText = 'position:absolute;inset:0;z-index:0;background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,BlinkMacSystemFont,sans-serif;overflow:hidden';
      mock.innerHTML = `
        <div style="height:7%;display:flex;align-items:center;gap:1.1%;padding:0 2%;background:rgba(255,255,255,.92);border-bottom:1px solid rgba(0,0,0,.08)">
          <span style="width:1.1%;aspect-ratio:1;border-radius:50%;background:#ff5f57"></span><span style="width:1.1%;aspect-ratio:1;border-radius:50%;background:#febc2e"></span><span style="width:1.1%;aspect-ratio:1;border-radius:50%;background:#28c840"></span>
          <div style="margin-left:3%;width:38%;height:43%;border-radius:999px;background:#ececef"></div>
        </div>
        <div style="display:flex;height:93%">
          <aside style="width:18%;padding:3% 2%;background:#fbfbfc;border-right:1px solid rgba(0,0,0,.07)">
            <div style="font-size:clamp(8px,1.25vw,18px);font-weight:750;margin-bottom:20%;color:#111">Northstar</div>
            ${['Overview','Analytics','Campaigns','Audience','Library'].map((label, index) => `<div style="padding:7% 9%;margin-bottom:4%;border-radius:7px;font-size:clamp(6px,.82vw,13px);font-weight:600;background:${index === 0 ? '#e8f1ff' : 'transparent'};color:${index === 0 ? '#0969da' : '#6e6e73'}">${label}</div>`).join('')}
          </aside>
          <main style="flex:1;padding:3.5% 4%;background:linear-gradient(145deg,#f7f7fa,#eef2f8)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3%"><div><div style="font-size:clamp(10px,1.7vw,26px);font-weight:760">Creator overview</div><div style="font-size:clamp(6px,.78vw,12px);color:#86868b;margin-top:3%">Performance across your latest releases</div></div><div style="padding:1.2% 2.1%;border-radius:7px;background:#0a84ff;color:white;font-size:clamp(6px,.75vw,12px);font-weight:700">New project</div></div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:2.2%;margin-bottom:3%">${[['Views','284K','+18%'],['Watch time','18.4K h','+12%'],['Subscribers','8,942','+24%']].map(([label,value,delta]) => `<div style="padding:9%;border-radius:12px;background:rgba(255,255,255,.94);box-shadow:0 8px 30px rgba(32,42,66,.07)"><div style="font-size:clamp(6px,.72vw,11px);color:#86868b">${label}</div><div style="font-size:clamp(10px,1.65vw,25px);font-weight:760;margin:5% 0">${value}</div><div style="font-size:clamp(6px,.68vw,10px);font-weight:700;color:#30a14e">${delta}</div></div>`).join('')}</div>
            <div style="height:47%;padding:3%;border-radius:13px;background:rgba(255,255,255,.96);box-shadow:0 8px 30px rgba(32,42,66,.07)"><div style="font-size:clamp(7px,.9vw,14px);font-weight:700;margin-bottom:3%">Audience growth</div><div style="height:76%;display:flex;align-items:flex-end;gap:1.6%;padding:0 1%;border-bottom:1px solid #d9d9df">${[38,46,42,55,62,58,70,76,68,83,88,94].map((height,index) => `<span style="flex:1;height:${height}%;border-radius:4px 4px 0 0;background:linear-gradient(#5ac8fa,#0a84ff);opacity:${0.62 + index * 0.03}"></span>`).join('')}</div></div>
          </main>
        </div>`;
      viewport.prepend(mock);
    }
    syncPreviewStageGeometry();
    renderZoomPreview(Number(params.get('time')) || 0);
  });
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SOURCES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Auto-refresh interval for the source list (clears when recording starts)
let _sourceRefreshTimer = null;
const _sourceDiscoveryGate = SourceDiscovery.createSingleFlight();

function clearSourceDiscoveryState() {
  S.sources = [];
  S.filtered = [];
  S.selected = null;
  S.sourceBounds = null;
  S.cfg.captureArea = null;
  screenforgeApi.setSourceBounds(null);
}

function renderSourceDiscoveryFailure(result) {
  const grid = $('sourceGrid');
  const permissionFailure = result.code === 'SCREEN_RECORDING_PERMISSION';
  const title = permissionFailure ? 'Screen Recording Required' : 'Sources Unavailable';
  const detail = permissionFailure
    ? 'Allow ScreenForge to see your displays and windows. Your screen is only recorded after you press Start Recording.'
    : 'ScreenForge could not load your displays and windows. Try the scan again.';
  const guidance = permissionFailure
    ? `<div style="width:100%;display:grid;gap:7px;margin-top:4px;text-align:left">
         <div style="display:flex;gap:8px;align-items:center;color:rgba(255,255,255,.52);font-size:10px"><span style="width:18px;height:18px;border-radius:50%;background:rgba(10,132,255,.18);color:#64b5ff;display:grid;place-items:center;font-weight:750">1</span>Open System Settings</div>
         <div style="display:flex;gap:8px;align-items:center;color:rgba(255,255,255,.52);font-size:10px"><span style="width:18px;height:18px;border-radius:50%;background:rgba(10,132,255,.18);color:#64b5ff;display:grid;place-items:center;font-weight:750">2</span>Turn on ScreenForge</div>
         <div style="display:flex;gap:8px;align-items:center;color:rgba(255,255,255,.52);font-size:10px"><span style="width:18px;height:18px;border-radius:50%;background:rgba(10,132,255,.18);color:#64b5ff;display:grid;place-items:center;font-weight:750">3</span>Quit and reopen ScreenForge</div>
       </div>`
    : '';
  const settingsButton = result.canOpenSettings
    ? `<button type="button" onclick="openScreenRecordingSettings()" style="
         flex:1;padding:7px 10px;border-radius:8px;border:1px solid rgba(10,132,255,.42);
         background:linear-gradient(180deg,#168cff,#0878e6);color:#fff;font-size:10px;font-weight:700;
         box-shadow:0 6px 18px rgba(10,132,255,.22);cursor:pointer">Open System Settings</button>`
    : '';

  grid.innerHTML = `
    <div role="status" aria-live="polite" style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 18px;gap:10px">
      <div style="width:46px;height:46px;border-radius:14px;background:linear-gradient(145deg,rgba(10,132,255,.2),rgba(90,200,250,.08));border:1px solid rgba(100,181,255,.22);display:grid;place-items:center;box-shadow:inset 0 1px rgba(255,255,255,.08),0 10px 26px rgba(0,0,0,.22)">
        <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="#64b5ff" stroke-width="1.6" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2.5"/><path d="M8 21h8M12 17v4"/><path d="M9 9.5l2 2 4-4"/></svg>
      </div>
      <div style="font-size:12px;font-weight:720;color:rgba(255,255,255,.9);letter-spacing:-.01em">${title}</div>
      <div style="max-width:285px;font-size:10px;line-height:1.5;text-align:center;color:rgba(255,255,255,.38)">${detail}</div>
      ${guidance}
      <div style="width:100%;display:flex;gap:7px;margin-top:4px">
        ${settingsButton}
        <button type="button" onclick="reloadSources()" style="
          flex:1;padding:7px 10px;border-radius:8px;font-size:10px;font-weight:650;
          background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
          color:rgba(255,255,255,.7);cursor:pointer">Try Again</button>
      </div>
    </div>`;
}

async function openScreenRecordingSettings() {
  try {
    await screenforgeApi.openScreenRecordingSettings();
  } catch {
    showFloatToast('Open System Settings, then Privacy & Security, then Screen Recording');
  }
}

function loadSources({ silent = false } = {}) {
  return _sourceDiscoveryGate.run(async () => {
    const grid = $('sourceGrid');
    if (!silent && !S.sources.length) {
      grid.innerHTML = `
        <div role="status" aria-live="polite" style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 0;gap:10px">
          <div style="
            width:26px;height:26px;border-radius:50%;
            border:2px solid rgba(94,234,212,.15);
            border-top-color:rgba(94,234,212,.7);
            animation:spin .8s linear infinite">
          </div>
          <span style="font-size:10px;color:rgba(255,255,255,.25);letter-spacing:.05em">Scanning sources…</span>
        </div>`;
    }

    let result;
    try {
      result = SourceDiscovery.normalizeSourceDiscoveryResponse(await screenforgeApi.getSources());
    } catch {
      result = SourceDiscovery.normalizeSourceDiscoveryResponse(null);
    }

    if (!result.ok) {
      const permissionFailure = result.code === 'SCREEN_RECORDING_PERMISSION';
      if (permissionFailure || !S.sources.length) {
        clearInterval(_sourceRefreshTimer);
        _sourceRefreshTimer = null;
        clearSourceDiscoveryState();
        S.sourceDiscovery = result;
        renderSourceDiscoveryFailure(result);
        syncCaptureNav();
      }
      return result;
    }

    S.sourceDiscovery = result;
    S.sources = result.sources;
    filterSources(S.activeTab);
    syncCaptureNav();
    _startSourceRefresh();
    return result;
  });
}

function _startSourceRefresh() {
  clearInterval(_sourceRefreshTimer);
  _sourceRefreshTimer = setInterval(() => {
    if (S.isRec) { clearInterval(_sourceRefreshTimer); return; }
    loadSources({ silent: true });
  }, 4000);
}

function reloadSources() {
  clearInterval(_sourceRefreshTimer);
  _sourceRefreshTimer = null;
  clearSourceDiscoveryState();
  S.sourceDiscovery = null;
  syncCaptureNav();
  loadSources();
}

function filterSources(type) {
  const previousId = S.selected?.id;
  S.activeTab = type;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.remove('tab-active'); b.classList.add('text-muted');
  });
  const tab = $(`tab-${type}`);
  if (tab) { tab.classList.add('tab-active'); tab.classList.remove('text-muted'); }
  const reconciled = SourceDiscovery.reconcileSourceSelection(S.sources, previousId, type);
  S.filtered = reconciled.filtered;
  S.selected = reconciled.selected;
  S.sourceBounds = reconciled.sourceBounds;
  screenforgeApi.setSourceBounds(S.sourceBounds);
  renderSources();
  syncCaptureNav();
}

// Build the thumbnail cell with an icon or letter fallback for null thumbnails.
function _thumbCell(s) {
  const thumbnail = safeImageDataUrl(s.thumbnail);
  const appIcon = safeImageDataUrl(s.appIcon);
  const fallback = appIcon
    ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:linear-gradient(145deg,#10141c,#080a0f)">
         <img src="${appIcon}" style="width:52px;height:52px;object-fit:contain;border-radius:12px" alt="">
       </div>`
    : _placeholderCell(s);
  if (!thumbnail) return fallback;
  return `${fallback}
    <img src="${thumbnail}"
      style="width:100%;height:100%;object-fit:cover;display:block;position:absolute;inset:0;z-index:1"
      onerror="this.style.display='none'" alt="">`;
}

function _placeholderCell(s) {
  const rawInitial = (String(s.name || '?')[0] || '?').toUpperCase();
  const initial = escapeHtml(rawInitial);
  const colors  = ['#3b82f6','#8b5cf6','#ec4899','#10b981','#f59e0b','#6366f1'];
  const color   = colors[rawInitial.charCodeAt(0) % colors.length];
  const content = s.isScreen
    ? `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`
    : `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;background:linear-gradient(145deg,#111827,#06080d)">
         <div style="width:42px;height:42px;border-radius:13px;background:${color};display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;color:#fff;box-shadow:0 10px 24px rgba(0,0,0,.28)">${initial}</div>
         <div style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.28)">Window</div>
       </div>`;
  return `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">${content}</div>`;
}

function renderSources() {
  const grid = $('sourceGrid');
  if (!S.filtered.length) {
    grid.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 0;gap:8px">
        <div style="width:38px;height:38px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:center">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
        </div>
        <span style="font-size:11px;color:rgba(255,255,255,.3);font-weight:500">No sources found</span>
        <span style="font-size:10px;color:rgba(255,255,255,.15)">Grant Screen Recording permission in System Settings</span>
        <button onclick="reloadSources()" style="
          margin-top:2px;padding:5px 14px;border-radius:6px;font-size:10px;font-weight:600;
          background:rgba(94,234,212,.08);border:1px solid rgba(94,234,212,.18);
          color:rgba(94,234,212,.7);cursor:pointer">↻ Refresh</button>
      </div>`;
    return;
  }

  grid.innerHTML = S.filtered.map((s, i) => {
    const isSelected = S.selected?.id === s.id;
    const safeName = escapeHtml(s.name || 'Untitled source');
    const appIcon = safeImageDataUrl(s.appIcon);
    return `
      <button type="button" class="src-card ${isSelected ? 'selected' : ''}" onclick="selectSource(${i})" aria-pressed="${isSelected}">
        <div style="position:relative;overflow:hidden;aspect-ratio:16/9;background:#0a0c12;border-radius:8px 8px 0 0">
          ${_thumbCell(s)}
          ${isSelected ? '<div style="position:absolute;inset:0;background:rgba(94,234,212,.07);border-radius:8px 8px 0 0"></div>' : ''}
          ${s.isScreen ? `<div style="position:absolute;top:5px;left:5px;background:rgba(0,0,0,.6);border-radius:4px;padding:2px 5px;font-size:9px;font-weight:700;color:rgba(255,255,255,.6);letter-spacing:.04em">DISPLAY</div>` : ''}
        </div>
        <div style="padding:5px 9px 7px;display:flex;align-items:center;gap:6px;min-width:0">
          ${appIcon && !s.isScreen ? `<img src="${appIcon}" style="width:14px;height:14px;border-radius:3px;flex-shrink:0;object-fit:contain" onerror="this.style.display='none'" alt="">` : ''}
          <p style="font-size:11px;color:rgba(255,255,255,${isSelected ? '.92' : '.72'});white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0;font-weight:${isSelected ? '600' : '500'}">${safeName}</p>
        </div>
      </button>`;
  }).join('');

  if (!S.selected && S.filtered.length) selectSource(0);
}

// True when the chosen source gives us no on-screen rectangle. macOS does not
// report where another app's window sits, and Electron exposes no API for it, so
// for window capture we cannot translate a global click position into a position
// inside the recording. Everything position-based is therefore inert.
function pointerTrackingUnavailable() {
  return Boolean(S.selected) && !S.selected.isScreen && !S.sourceBounds;
}

const POINTER_TRACKING_WARNING =
  'Recording a window: click zooms, click rings and cursor effects will not work. '
  + 'Pick Display or Area for those. Keyboard shortcut overlays still work.';

function selectSource(i) {
  S.selected = S.filtered[i];
  S.sourceBounds = S.selected?.bounds || null;
  if (!S.selected?.isScreen) S.cfg.captureArea = null;
  screenforgeApi.setSourceBounds(S.sourceBounds);
  if (pointerTrackingUnavailable()) {
    // The old wording ("pixel-accurate Action Director tracking") never told the
    // user that their clicks would be silently thrown away.
    showFloatToast(POINTER_TRACKING_WARNING);
  }
  renderSources();
  drawBgPreview();
  syncCaptureNav();
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SETTINGS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function syncSettingToggle(key) {
  const enabled = Boolean(S.cfg[key]);
  const control = $(`toggle-${key}`);
  if (!control) return;
  control.classList.toggle('toggle-on', enabled);
  const row = control.closest('.option-row');
  if (row) {
    row.setAttribute('aria-checked', String(enabled));
    return;
  }
  control.setAttribute('aria-checked', String(enabled));
  control.removeAttribute('aria-pressed');
}

function toggleSetting(key) {
  S.cfg[key] = !S.cfg[key];
  const control = $(`toggle-${key}`);
  syncSettingToggle(key);
  if (key === 'autoSaveToLibrary' && control) {
    control.textContent = S.cfg[key] ? 'On' : 'Off';
  }
  if (key === 'frame' || key === 'pad') {
    drawBgPreview();
    updatePresentationPreview();
  }
  if (key === 'webcam') {
    syncRecordMeBtn();
    if (S.cfg.webcam) startCameraPreview().catch(e => {
      console.warn('Record Me preview failed:', e.message);
      const sub = $('recordMeSub');
      if (sub) sub.textContent = e.message;
    });
    else stopCameraPreview();
  }
  syncCaptureNav();
  schedulePersist?.();
}

// ── "Record Me" quick-toggle ─────────────────────────────────────────────────
function toggleRecordMe() {
  S.cfg.webcam = !S.cfg.webcam;
  syncSettingToggle('webcam');
  syncCaptureNav();
  syncRecordMeBtn();
  schedulePersist?.();

  if (S.cfg.webcam) startCameraPreview().catch(e => {
    console.warn('Record Me preview failed:', e.message);
    const sub = $('recordMeSub');
    if (sub) sub.textContent = e.message;
  });
  else stopCameraPreview();
}

function syncRecordMeBtn() {
  const btn    = $('recordMeBtn');
  const icon   = $('recordMeIcon');
  const svg    = $('recordMeIconSvg');
  const label  = $('recordMeLabel');
  const sub    = $('recordMeSub');
  const status = $('recordMeStatus');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(Boolean(S.cfg.webcam)));

  if (S.cfg.webcam) {
    btn.classList.add('rmt-on');
    btn.style.background     = 'rgba(94,234,212,.08)';
    btn.style.borderColor    = 'rgba(94,234,212,.35)';
    icon.style.background    = 'rgba(94,234,212,.15)';
    svg.querySelector('rect,path') && (svg.querySelectorAll('[stroke]').forEach(el => el.setAttribute('stroke', '#8fc5ff')));
    // Re-color all stroked paths in the SVG
    svg.querySelectorAll('*').forEach(el => el.setAttribute('stroke', '#8fc5ff'));
    label.style.color        = '#8fc5ff';
    sub.textContent          = 'Camera will appear above your recording';
    sub.style.color          = 'rgba(143,197,255,.55)';
    status.textContent       = 'ON';
    status.style.background  = 'rgba(94,234,212,.15)';
    status.style.color       = '#8fc5ff';
  } else {
    btn.classList.remove('rmt-on');
    btn.style.background     = 'rgba(255,255,255,.05)';
    btn.style.borderColor    = 'rgba(255,255,255,.1)';
    icon.style.background    = 'rgba(255,255,255,.07)';
    svg.querySelectorAll('*').forEach(el => el.setAttribute('stroke', 'rgba(255,255,255,.45)'));
    label.style.color        = 'rgba(255,255,255,.55)';
    sub.textContent          = 'Place camera above your recording';
    sub.style.color          = 'rgba(255,255,255,.25)';
    status.textContent       = 'OFF';
    status.style.background  = 'rgba(255,255,255,.06)';
    status.style.color       = 'rgba(255,255,255,.25)';
  }
}

function getCameraConstraints(deviceId = S.cfg.camDeviceId) {
  const base = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
  };
  if (deviceId) {
    return { audio: false, video: { ...base, deviceId: { ideal: deviceId } } };
  }
  return { audio: false, video: { ...base, facingMode: 'user' } };
}

async function pickBuiltInCameraDeviceId() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter(d => d.kind === 'videoinput');
  const builtIn = cameras.find(d => /macbook|facetime|built-?in/i.test(d.label));
  return builtIn?.deviceId || '';
}

function isLiveStream(stream) {
  return !!stream?.getVideoTracks?.().some(track => track.readyState === 'live');
}

function cameraLabel(stream) {
  return stream?.getVideoTracks?.()[0]?.label || '';
}

function isBuiltInCameraLabel(label) {
  return /macbook|facetime|built-?in/i.test(label || '');
}

async function startCameraPreview({ silent = false, requireFrames = false } = {}) {
  const preview = $('recordMePreview');
  const sub = $('recordMeSub');

  if (!navigator.mediaDevices?.getUserMedia) {
    if (sub) sub.textContent = 'Camera API unavailable';
    return null;
  }

  if (isLiveStream(S.camStream)) {
    attachCameraPreview(S.camStream);
    if (requireFrames && preview) await waitForVideoReady(preview, 3000, 'Camera is live but no frames arrived');
    return S.camStream;
  }

  if (sub) sub.textContent = 'Starting MacBook camera...';

  try {
    const stream = await withTimeout(
      navigator.mediaDevices.getUserMedia(getCameraConstraints()),
      8000,
      'Camera permission timed out'
    );

    S.camStream = stream;
    attachCameraPreview(stream);
    await loadDevices();

    const builtInId = await pickBuiltInCameraDeviceId();
    const currentLabel = cameraLabel(stream);
    if (builtInId && !isBuiltInCameraLabel(currentLabel)) {
      const replacement = await tryCameraStream(builtInId);
      if (replacement) {
        stream.getTracks().forEach(t => t.stop());
        S.camStream = replacement;
        S.cfg.camDeviceId = builtInId;
        attachCameraPreview(replacement);
        await loadDevices();
      }
    }

    if (requireFrames && preview) await waitForVideoReady(preview, 3000, 'MacBook camera did not deliver frames');
    const trackLabel = cameraLabel(S.camStream) || 'Camera ready';
    if (sub) sub.textContent = trackLabel;
    return S.camStream;
  } catch (e) {
    stopCameraPreview();
    if (sub) sub.textContent = silent ? 'Camera unavailable' : `Camera unavailable: ${e.message}`;
    if (!silent) console.warn('Record Me camera failed:', e.message);
    return null;
  }
}

async function tryCameraStream(deviceId) {
  try {
    const stream = await withTimeout(
      navigator.mediaDevices.getUserMedia(getCameraConstraints(deviceId)),
      5000,
      'Camera switch timed out'
    );
    const probe = document.createElement('video');
    prepareMediaElement(probe);
    probe.srcObject = stream;
    await waitForVideoReady(probe, 2000, 'Camera switch produced no frames');
    probe.srcObject = null;
    return stream;
  } catch (e) {
    console.warn('MacBook camera switch skipped:', e.message);
    return null;
  }
}

function waitForVideoReady(video, ms, message) {
  const isReady = () => video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2;
  if (isReady()) return Promise.resolve();
  return withTimeout(new Promise((resolve, reject) => {
    let timer = null;
    const done = () => {
      if (!isReady()) return;
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error(message));
    };
    const poll = () => {
      if (isReady()) return done();
      timer = setTimeout(poll, 50);
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      video.removeEventListener('loadedmetadata', done);
      video.removeEventListener('canplay', done);
      video.removeEventListener('playing', done);
      video.removeEventListener('error', fail);
    };
    video.addEventListener('loadedmetadata', done, { once: true });
    video.addEventListener('canplay', done, { once: true });
    video.addEventListener('playing', done, { once: true });
    video.addEventListener('error', fail, { once: true });
    video.play?.().catch(() => {});
    poll();
  }), ms, message);
}

function attachCameraPreview(stream) {
  const preview = $('recordMePreview');
  if (!preview) return;
  preview.srcObject = stream;
  preview.style.display = 'block';
  preview.play?.().catch(() => {});
}

function stopCameraPreview() {
  const preview = $('recordMePreview');
  if (preview) {
    preview.pause?.();
    preview.srcObject = null;
    preview.style.display = 'none';
  }
  if (S.camStream && !S.isRec) {
    S.camStream.getTracks().forEach(t => t.stop());
  }
  S.camStream = null;
}

function setCaptureMode(type) {
  if (type === 'screen' || type === 'window') {
    S.cfg.captureArea = null;
    filterSources(type);
    syncCaptureNav();
    drawBgPreview();
  }
}

async function beginAreaSelection() {
  let source = S.selected;
  if (!source?.isScreen) {
    source = S.sources.find(s => s.isScreen) || null;
    if (!source) { alert('No display source found for area selection.'); return; }
    S.activeTab = 'screen';
    S.filtered = S.sources.filter(s => s.isScreen);
    S.selected = source;
    S.sourceBounds = source.bounds || null;
    screenforgeApi.setSourceBounds(S.sourceBounds);
    renderSources();
  }

  try {
    const result = await screenforgeApi.selectCaptureArea(S.sourceBounds);
    if (!result?.captureArea) return;
    S.cfg.captureArea = sanitizeCaptureArea(result.captureArea);
    if (!S.cfg.captureArea) return;
    S.sourceBounds = result.sourceBounds || S.sourceBounds;
    screenforgeApi.setSourceBounds(S.sourceBounds);
    drawBgPreview();
    syncCaptureNav();
  } catch (e) {
    alert('Area selection failed: ' + e.message);
  }
}

function clearCaptureArea() {
  S.cfg.captureArea = null;
  drawBgPreview();
  syncCaptureNav();
}

function syncCaptureNav() {
  const mode = S.cfg.captureArea ? 'area' : (S.activeTab === 'window' ? 'window' : 'screen');
  ['display','window','area'].forEach(key => {
    const id = key === 'display' ? 'nav-display' : `nav-${key}`;
    const control = $(id);
    const active = (key === 'display' ? 'screen' : key) === mode;
    control?.classList.toggle('active', active);
    control?.setAttribute('aria-pressed', String(active));
  });
  [['nav-camera', S.cfg.webcam], ['nav-mic', S.cfg.mic], ['nav-systemAudio', S.cfg.systemAudio], ['nav-audioCleanup', S.cfg.audioCleanup]].forEach(([id, value]) => {
    $(id)?.classList.toggle('active', !!value);
    $(id)?.setAttribute('aria-pressed', String(Boolean(value)));
  });
  if ($('navCameraText')) $('navCameraText').textContent = S.cfg.webcam ? 'Camera' : 'No camera';
  if ($('navMicText')) $('navMicText').textContent = S.cfg.mic ? 'Microphone' : 'No microphone';
  if ($('navSystemText')) $('navSystemText').textContent = S.cfg.systemAudio ? 'System audio' : 'No system audio';

  const chip = $('areaChip');
  if (chip) chip.style.display = S.cfg.captureArea ? 'flex' : 'none';
  if ($('areaChipText') && S.cfg.captureArea) {
    const a = S.cfg.captureArea;
    $('areaChipText').textContent = `Area ${Math.round(a.wPct * 100)}% x ${Math.round(a.hPct * 100)}%`;
  }

  const sourceReady = S.sourceDiscovery?.ok === true && Boolean(S.selected);
  const recordButton = $('recordBtn');
  if (recordButton && !S.isRec) recordButton.disabled = !sourceReady;
  const areaButton = $('nav-area');
  if (areaButton) {
    const areaReady = sourceReady && Boolean(S.sources.find(source => source.isScreen));
    areaButton.disabled = !areaReady;
    areaButton.setAttribute('aria-disabled', String(!areaReady));
  }
}

function setZoomLevel(level) {
  S.cfg.zoomLevel = level;
  document.querySelectorAll('.zoom-level-btn').forEach(b => {
    const on = b.id === `zl-${level}`;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
    if (!on) b.style.color = 'rgba(255,255,255,.32)';
    else b.style.color = '';
  });
}

function resetInteractionCapture() {
  S.recStartedAt = Date.now();
  S.recPerfStartedAt = performance.now();
  S.recPausedAt = 0;
  S.recPausedTotal = 0;
  S.recEvents = { clicks: [], keys: [], cursor: [] };
  S.keyframes = [];
  S.zoomLimitReached = false;
}

function eventTime(_payload) {
  if (!S.recPerfStartedAt) return 0;
  const pausedNow = S.recPausedAt ? performance.now() - S.recPausedAt : 0;
  return Math.max(0, (performance.now() - S.recPerfStartedAt - S.recPausedTotal - pausedNow) / 1000);
}

function normalizePoint(payload) {
  const b = payload?.bounds || S.sourceBounds;
  if (!b || !b.width || !b.height) return { xPct: 0.5, yPct: 0.5, inside: false };
  let xPct = (payload.x - b.x) / b.width;
  let yPct = (payload.y - b.y) / b.height;
  let inside = xPct >= 0 && xPct <= 1 && yPct >= 0 && yPct <= 1;
  const area = sanitizeCaptureArea(S.cfg.captureArea);
  if (area) {
    inside = inside
      && xPct >= area.xPct && xPct <= area.xPct + area.wPct
      && yPct >= area.yPct && yPct <= area.yPct + area.hPct;
    xPct = (xPct - area.xPct) / area.wPct;
    yPct = (yPct - area.yPct) / area.hPct;
  }
  return {
    xPct: clamp(xPct, 0, 1),
    yPct: clamp(yPct, 0, 1),
    inside,
  };
}

function ingestCursor(payload) {
  if (!S.isRec || S.isPaused) return;
  const last = S.recEvents.cursor[S.recEvents.cursor.length - 1];
  const t = eventTime(payload);
  if (last && t - last.time < 0.12) return;
  const pt = normalizePoint(payload);
  if (!pt.inside) return;
  S.recEvents.cursor.push({ time: t, ...pt });
  if (S.recEvents.cursor.length > 20000) S.recEvents.cursor.shift();
}

function ingestClick(payload) {
  if (!S.isRec || S.isPaused) return;
  const pt = normalizePoint(payload);
  if (!pt.inside) return;
  const t = eventTime(payload);
  const click = {
    id: Date.now() + Math.round(t * 1000),
    type: 'click',
    time: t,
    duration: 0.8,
    xPct: pt.xPct,
    yPct: pt.yPct,
  };
  S.recEvents.clicks.push(click);
  if (S.cfg.clickRings) S.keyframes.push(click);
  if (S.cfg.zoom && S.keyframes.filter(keyframe => keyframe.type === 'zoom').length < MAX_ZOOM_SHOTS) {
    S.keyframes.push({
      id: click.id + 1,
      type: 'zoom',
      time: Math.max(0, t - 0.12),
      duration: 1.55,
      xPct: pt.xPct,
      yPct: pt.yPct,
      zoomLevel: S.cfg.zoomLevel,
      source: 'auto-click',
    });
  } else if (S.cfg.zoom) {
    S.zoomLimitReached = true;
  }
}

function ingestKey(payload) {
  if (!S.isRec || S.isPaused || !S.cfg.shortcuts) return;
  const label = keyLabel(payload);
  if (!label) return;
  const t = eventTime(payload);
  const last = S.recEvents.keys[S.recEvents.keys.length - 1];
  if (last && last.label === label && t - last.time < 0.3) return;
  const kf = {
    id: Date.now() + Math.round(t * 1000),
    type: 'key',
    time: t,
    duration: 1.4,
    label,
  };
  S.recEvents.keys.push(kf);
  S.keyframes.push(kf);
}

function keyLabel(e) {
  const names = {
    1: 'Esc', 14: 'Delete', 15: 'Tab', 28: 'Return', 57: 'Space',
    57416: '↑', 57419: '←', 57421: '→', 57424: '↓',
  };
  const letters = {
    16: 'Q', 17: 'W', 18: 'E', 19: 'R', 20: 'T', 21: 'Y', 22: 'U', 23: 'I', 24: 'O', 25: 'P',
    30: 'A', 31: 'S', 32: 'D', 33: 'F', 34: 'G', 35: 'H', 36: 'J', 37: 'K', 38: 'L',
    44: 'Z', 45: 'X', 46: 'C', 47: 'V', 48: 'B', 49: 'N', 50: 'M',
  };
  const nums = { 2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9', 11: '0' };
  const base = names[e.keycode] || letters[e.keycode] || nums[e.keycode];
  if (!base) return '';
  const mods = [];
  if (e.metaKey) mods.push('⌘');
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('⌥');
  if (e.shiftKey && base.length > 1) mods.push('Shift');
  return [...mods, base].join(' ');
}

function recordingFps({ requested = S.cfg.fps, composited = false } = {}) {
  const value = Number(requested);
  const fps = Number.isFinite(value) && value > 0 ? Math.round(value) : 30;
  const ceiling = composited ? 30 : 30;
  return clamp(fps, 15, ceiling);
}

function recordingOutputSize(width, height) {
  const sourceW = Math.max(1, Number(width) || MAX_RECORDING_WIDTH);
  const sourceH = Math.max(1, Number(height) || MAX_RECORDING_HEIGHT);
  const scale = Math.min(1, MAX_RECORDING_WIDTH / sourceW, MAX_RECORDING_HEIGHT / sourceH);
  return {
    width: Math.max(2, Math.round(sourceW * scale / 2) * 2),
    height: Math.max(2, Math.round(sourceH * scale / 2) * 2),
    scale,
  };
}

function selectedRecordingOutputSize(image = null) {
  const bounds = S.selected?.bounds;
  const scaleFactor = Math.max(1, Number(S.selected?.scaleFactor) || 1);
  let sourceWidth = Number(bounds?.width) * scaleFactor;
  let sourceHeight = Number(bounds?.height) * scaleFactor;
  if (!(sourceWidth > 0 && sourceHeight > 0)) {
    const imageWidth = Math.max(1, Number(image?.naturalWidth) || 16);
    const imageHeight = Math.max(1, Number(image?.naturalHeight) || 9);
    const aspect = imageWidth / imageHeight;
    if (aspect >= MAX_RECORDING_WIDTH / MAX_RECORDING_HEIGHT) {
      sourceWidth = MAX_RECORDING_WIDTH;
      sourceHeight = sourceWidth / aspect;
    } else {
      sourceHeight = MAX_RECORDING_HEIGHT;
      sourceWidth = sourceHeight * aspect;
    }
  }
  const area = captureAreaPx(sourceWidth, sourceHeight);
  return recordingOutputSize(area.w, area.h);
}

function shouldDownscaleRawStream(stream) {
  const settings = stream?.getVideoTracks?.()[0]?.getSettings?.() || {};
  return Number(settings.width || 0) > MAX_RECORDING_WIDTH || Number(settings.height || 0) > MAX_RECORDING_HEIGHT;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RECORDING: direct stream capture, reliable even when the window hides
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function startRecording() {
  if (!S.selected) {
    const first = S.sources.find(s => s.isScreen);
    if (first) { S.selected = first; S.sourceBounds = first.bounds || null; screenforgeApi.setSourceBounds(S.sourceBounds); renderSources(); }
    else { alert('No source selected'); return; }
  }

  const btn = $('recordBtn');
  btn.disabled = true;

  try {
    const sessionId = window.sf?.newSessionId ? await screenforgeApi.newSessionId() : `sess-${Date.now()}`;
    S.recSessionId = sessionId;
    S.nativeMic = null;
    S.nativeMicStopPromise = null;
    S.useNativeMic = false;

    btn.textContent = 'Choose source…';
    stopBgAnim();
    S.rawStream = await getDesktopCaptureStream();

    btn.textContent = 'Preparing inputs…';
    if (S.cfg.mic) {
      await primeMicrophonePermission();
      try {
        S.micStream = await getMicrophoneStream();
        S.useNativeMic = false;
        reportAudioDiagnostic('mic-path-selected', {
          path: 'renderer-synced',
          level: S.micStream?.__screenforgeLevel || null,
        });
      } catch (err) {
        if (!window.sf?.startNativeMicRecording) throw err;
        reportAudioDiagnostic('mic-path-selected', {
          path: 'native-fallback',
          reason: err?.message || String(err),
          preferredLabel: await preferredMicrophoneLabel(),
        });
        S.useNativeMic = true;
        S.micStream = null;
      }
    } else {
      S.micStream = null;
    }

    // Webcam with specific device if selected
    if (S.cfg.webcam) {
      S.camStream = isLiveStream(S.camStream)
        ? S.camStream
        : await startCameraPreview({ requireFrames: true });
      if (!isLiveStream(S.camStream)) {
        throw new Error('Record Me is on, but the MacBook camera is not live. Turn Record Me off or allow Camera access.');
      }
    } else {
      S.camStream = null;
    }

    const cdSecs = S.cfg.countdown ?? 3;
    await runPrepCountdown(cdSecs, (remaining) => {
      btn.textContent = cdSecs > 0 ? `Recording in ${remaining}…` : 'Starting…';
    });
    btn.textContent = 'Starting…';

    S.chunks = [];
    const needsCanvasComposite = !!S.camStream || !!S.cfg.captureArea || shouldDownscaleRawStream(S.rawStream);
    const recFps = recordingFps({ composited: needsCanvasComposite });
    const mime = [
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp8',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp9',
      'video/webm'
    ]
                   .find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';

    const recordStream = needsCanvasComposite ? await buildCompositedStream(S.rawStream, S.camStream, recFps) : new MediaStream(S.rawStream.getVideoTracks());
    if (S.useNativeMic) {
      btn.textContent = 'Starting microphone…';
      const nativeStarted = await startNativeMicCapture(sessionId);
      if (!nativeStarted) {
        S.useNativeMic = false;
        S.micStream = await getMicrophoneStream();
      }
    }
    const mixedAudio = await mixAudioTracks([S.rawStream, S.micStream].filter(Boolean));
    for (const track of mixedAudio?.getAudioTracks?.() || []) recordStream.addTrack(track);
    S.audioStream = mixedAudio;
    S.audioInfo = inspectRecordingAudio(recordStream, S.rawStream, S.micStream, S.nativeMic);

    const qualityBitrates = { draft: 2_000_000, good: 4_000_000, high: 6_000_000, ultra: 9_000_000, lossless: 12_000_000 };
    const videoBitsPerSecond = qualityBitrates[S.cfg.quality] || 6_000_000;

    const recorderOptions = {
      mimeType: mime,
      videoBitsPerSecond,
    };
    if (S.audioInfo.recordingTracks > 0) recorderOptions.audioBitsPerSecond = 192_000;
    S.recorder = new MediaRecorder(recordStream, recorderOptions);
    S.recorder.ondataavailable = e => { if (e.data.size > 0) S.chunks.push(e.data); };
    S.recorder.onstop          = finishRecording;

    // Keep chunking coarse enough that encoding does not fight capture timing.
    resetInteractionCapture();
    S.recorder.start(1000);
    if (S.nativeMic?.startedAtPerf) S.nativeMic.offsetMs = 0;
    S.isRec = true;
    startAutoSave();
    startStatsPolling();
    startAnnotationLayer();

    // Stop live source refresh while recording
    clearInterval(_sourceRefreshTimer);

    // Warn again at the moment it actually matters. Selecting a source and
    // hitting record can be minutes apart, and a toast from back then is long
    // gone by the time the user is clicking through a take that silently records
    // none of it.
    if (pointerTrackingUnavailable() && (S.cfg.zoom || S.cfg.clickRings || S.cfg.cursor)) {
      showFloatToast(POINTER_TRACKING_WARNING);
    }

    // Hide main window and show floating pill bar
    screenforgeApi.startCursorPoll();
    screenforgeApi.recordingStarted({
      sessionId,
      webcam: !!S.camStream,
      mic: !!S.nativeMic || !!S.micStream?.getAudioTracks?.().length,
      systemAudio: !!S.rawStream?.getAudioTracks?.().length,
      audioTracks: S.audioInfo.recordingTracks + (S.audioInfo.nativeMicTracks || 0),
    });

  } catch(e) {
    stopNativeMicCapture().catch(() => {});
    cleanupCaptureStreams();
    if (!$('screenRecorder')?.classList.contains('hidden')) startBgAnim();
    S.nativeMic = null;
    S.nativeMicStopPromise = null;
    S.useNativeMic = false;
    btn.disabled = false; btn.textContent = 'Start Recording';
    alert('Recording error: ' + e.message);
  }
}

async function runPrepCountdown(seconds = 3, onTick = () => {}) {
  if (seconds <= 0) { onTick(0); return; }

  const overlay = $('countdownOverlay');
  const value = $('countdownValue');
  const ring = $('countdownRing');
  const hint = $('countdownHint');
  const tips = [
    'Get your cursor and window ready.',
    'Put the important UI in frame.',
    'Start from the exact interaction.',
    'Keep your first move intentional.',
    'Capture begins on zero.',
  ];

  if (!overlay || !value || !ring) {
    await sleep(seconds * 1000);
    return;
  }

  overlay.classList.remove('hidden');
  overlay.classList.add('flex');

  for (let remaining = seconds; remaining > 0; remaining--) {
    value.textContent = String(remaining);
    ring.style.setProperty('--countdown-pct', `${((seconds - remaining) / seconds) * 100}%`);
    if (hint) hint.textContent = tips[seconds - remaining] || tips[0];
    onTick(remaining);
    await sleep(1000);
  }

  ring.style.setProperty('--countdown-pct', '100%');
  value.textContent = '0';
  onTick(0);
  await sleep(140);

  overlay.classList.add('hidden');
  overlay.classList.remove('flex');
  ring.style.setProperty('--countdown-pct', '0%');
}

async function stopRecording() {
  if (!S.isRec) return;
  S.isRec = false;
  stopAutoSave();
  stopStatsPolling();
  stopAnnotationLayer();
  screenforgeApi.stopCursorPoll();
  if (S.recorder?.state !== 'inactive') S.recorder.stop();
  // Resume live source refresh after recording ends
  setTimeout(_startSourceRefresh, 2000);
}

function getMicrophoneConstraints(deviceId = S.cfg.micDeviceId, { processing = false } = {}) {
  const audio = {
    echoCancellation: processing,
    noiseSuppression: processing,
    autoGainControl: processing,
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

async function preferredMicrophoneLabel() {
  const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) || [];
  const inputs = devices.filter(device => device.kind === 'audioinput');
  const selected = S.cfg.micDeviceId
    ? inputs.find(device => device.deviceId === S.cfg.micDeviceId)
    : null;
  const builtIn = inputs.find(device => /macbook|built-?in/i.test(device.label || '') && device.deviceId !== 'default');
  const fallback = inputs.find(device => device.deviceId === 'default') || inputs[0];
  return (selected || builtIn || fallback)?.label || '';
}

async function startNativeMicCapture(sessionId) {
  if (!window.sf?.startNativeMicRecording) return false;
  const preferredLabel = await preferredMicrophoneLabel();
  const startedAtPerf = performance.now();
  try {
    const result = await screenforgeApi.startNativeMicRecording({ sessionId, preferredLabel });
    if (!result?.ok) {
      reportAudioDiagnostic('native-mic-error', {
        reason: result?.reason || 'Native microphone capture did not start.',
        devices: result?.devices || [],
        preferredLabel,
      });
      return false;
    }
    S.nativeMic = { ...result, startedAtPerf, offsetMs: 0 };
    S.nativeMicStopPromise = null;
    reportAudioDiagnostic('native-mic-started', {
      audioPath: result.audioPath,
      device: result.device,
      preferredLabel,
    });
    return true;
  } catch (err) {
    reportAudioDiagnostic('native-mic-error', {
      message: err?.message || String(err),
      preferredLabel,
    });
    return false;
  }
}

async function primeMicrophonePermission() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  let stream = null;
  try {
    stream = await withTimeout(
      navigator.mediaDevices.getUserMedia(getMicrophoneConstraints('', { processing: false })),
      8000,
      'Microphone permission timed out'
    );
    reportAudioDiagnostic('mic-permission-prime', {
      tracks: stream.getAudioTracks().map(track => ({
        label: track.label,
        readyState: track.readyState,
        muted: track.muted,
        settings: track.getSettings?.() || {},
      })),
    });
  } catch (err) {
    if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
      throw new Error('Microphone access is blocked for ScreenForge. Allow it in the macOS prompt or Privacy > Microphone, then record again.');
    }
    reportAudioDiagnostic('mic-permission-prime-error', {
      name: err?.name || '',
      message: err?.message || String(err),
    });
  } finally {
    stream?.getTracks?.().forEach(track => track.stop());
  }
}

async function stopNativeMicCapture() {
  if (!S.nativeMic?.sessionId || !window.sf?.stopNativeMicRecording) return null;
  if (!S.nativeMicStopPromise) {
    S.nativeMicStopPromise = screenforgeApi
      .stopNativeMicRecording({ sessionId: S.nativeMic.sessionId })
      .then(result => {
        reportAudioDiagnostic('native-mic-stopped', {
          ok: !!result?.ok,
          bytes: result?.bytes || 0,
          audioPath: result?.audioPath || '',
          audioFormat: result?.audioFormat || '',
          device: result?.device || S.nativeMic?.device || null,
        });
        return result;
      })
      .catch(err => {
        reportAudioDiagnostic('native-mic-stop-error', { message: err?.message || String(err) });
        return null;
      });
  }
  return S.nativeMicStopPromise;
}

async function getMicrophoneStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture is unavailable in this app context.');
  }

  const candidates = await microphoneCandidates();
  reportAudioDiagnostic('mic-request', {
    constraints: getMicrophoneConstraints(candidates[0]?.deviceId || ''),
    devices: await audioDeviceSnapshot(),
    candidates: candidates.map(candidate => ({
      label: candidate.label,
      deviceId: candidate.deviceId ? `${candidate.deviceId.slice(0, 8)}...` : '',
    })),
  });

  let best = null;
  let lastError = null;
  const processing = S.cfg.audioCleanup !== false;
  for (const candidate of candidates) {
    try {
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia(getMicrophoneConstraints(candidate.deviceId, { processing })),
        8000,
        'Microphone permission timed out'
      );
      const level = await measureAudioLevel(stream, 850);
      reportAudioDiagnostic('mic-level', {
        label: stream.getAudioTracks()[0]?.label || candidate.label,
        deviceId: candidate.deviceId ? `${candidate.deviceId.slice(0, 8)}...` : '',
        ...level,
      });
      if (!best || level.peak > best.level.peak) {
        if (best?.stream && best.stream !== stream) best.stream.getTracks().forEach(track => track.stop());
        best = { stream, level };
      }
      if (level.peak > 0.003 || level.rms > 0.001) break;
      if (best.stream !== stream) stream.getTracks().forEach(track => track.stop());
    } catch (err) {
      lastError = err;
      reportAudioDiagnostic('mic-error', {
        label: candidate.label,
        deviceId: candidate.deviceId ? `${candidate.deviceId.slice(0, 8)}...` : '',
        name: err?.name || '',
        message: err?.message || String(err),
        constraint: err?.constraint || '',
      });
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') break;
    }
  }

  const stream = best?.stream;
  if (!stream) {
    const err = lastError || new Error('No microphone stream could be opened.');
    if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
      throw new Error('Microphone was blocked by macOS or the selected input. Re-toggle ScreenForge in Privacy > Microphone, then quit and reopen ScreenForge.');
    }
    throw err;
  }

  const tracks = stream.getAudioTracks();
  try { stream.__screenforgeLevel = best?.level || null; } catch {}
  reportAudioDiagnostic('mic-success', {
    processing,
    level: best?.level || null,
    tracks: tracks.map(track => ({
      label: track.label,
      readyState: track.readyState,
      enabled: track.enabled,
      muted: track.muted,
      settings: track.getSettings?.() || {},
    })),
  });
  if (!tracks.some(track => track.readyState === 'live')) {
    stream.getTracks().forEach(track => track.stop());
    throw new Error('Microphone opened, but no live audio track was returned.');
  }
  return stream;
}

async function microphoneCandidates() {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const inputs = devices.filter(device => device.kind === 'audioinput');
  const selected = S.cfg.micDeviceId
    ? inputs.find(device => device.deviceId === S.cfg.micDeviceId)
    : null;
  const builtIn = inputs.find(device => /macbook|built-?in/i.test(device.label || '') && device.deviceId !== 'default');
  const defaultDevice = inputs.find(device => device.deviceId === 'default');
  const ordered = [selected, builtIn, defaultDevice, ...inputs].filter(Boolean);
  const seen = new Set();
  return ordered.filter(device => {
    const key = device.deviceId || device.label;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function measureAudioLevel(stream, durationMs = 850) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return { rms: 0, peak: 0, samples: 0, unavailable: true };
  const ctx = new AudioCtx();
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch {}
  }
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let sumSquares = 0;
  let peak = 0;
  let samples = 0;
  const endAt = performance.now() + durationMs;
  while (performance.now() < endAt) {
    analyser.getFloatTimeDomainData(data);
    for (const sample of data) {
      const abs = Math.abs(sample);
      peak = Math.max(peak, abs);
      sumSquares += sample * sample;
      samples++;
    }
    await sleep(80);
  }
  try { source.disconnect(); } catch {}
  try { await ctx.close(); } catch {}
  return {
    rms: samples ? Math.sqrt(sumSquares / samples) : 0,
    peak,
    samples,
  };
}

async function audioDeviceSnapshot() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter(device => device.kind === 'audioinput')
      .map(device => ({
        label: device.label || '',
        deviceId: device.deviceId ? `${device.deviceId.slice(0, 8)}...` : '',
        groupId: device.groupId ? `${device.groupId.slice(0, 8)}...` : '',
      }));
  } catch (err) {
    return [{ error: err?.message || String(err) }];
  }
}

function reportAudioDiagnostic(stage, data = {}) {
  try {
    screenforgeApi.audioDiagnostic?.({
      stage,
      at: new Date().toISOString(),
      micEnabled: !!S.cfg.mic,
      systemAudioEnabled: !!S.cfg.systemAudio,
      selectedMic: S.cfg.micDeviceId ? `${String(S.cfg.micDeviceId).slice(0, 8)}...` : '',
      ...data,
    });
  } catch {}
}

async function getOptionalMedia(constraints) {
  try {
    return await withTimeout(
      navigator.mediaDevices.getUserMedia(constraints),
      5000,
      'Optional microphone/camera permission timed out'
    );
  } catch (e) {
    console.warn('Optional capture unavailable:', e.message);
    return null;
  }
}

async function getDesktopCaptureStream() {
  const fps = recordingFps({ composited: !!S.cfg.webcam || !!S.cfg.captureArea });
  if (!IS_ELECTRON || S.selected?.browserFallback) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('This browser cannot capture the screen. Run `npm start` and use the Electron app.');
    }
    return withTimeout(navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: fps, max: fps },
        width: { max: MAX_RECORDING_WIDTH },
        height: { max: MAX_RECORDING_HEIGHT },
      },
      audio: !!S.cfg.systemAudio,
    }), 20000, 'Screen capture permission timed out');
  }

  screenforgeApi.setCaptureSource?.({ id: S.selected?.id || null, name: S.selected?.name || '' });

  if (S.cfg.systemAudio) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('System audio capture requires getDisplayMedia, which is unavailable here.');
    }
    const stream = await withTimeout(
      navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: fps, max: fps },
          width: { max: MAX_RECORDING_WIDTH },
          height: { max: MAX_RECORDING_HEIGHT },
        },
        audio: true,
      }),
      20000,
      'Screen and system audio capture timed out'
    );
    if (!stream.getVideoTracks().length) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('Screen capture returned no video track.');
    }
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('System audio is on, but Electron/macOS returned no loopback audio track.');
    }
    return stream;
  }

  const constraints = (withAudio) => ({
    audio: withAudio ? {
      mandatory: {
        chromeMediaSource:   'desktop',
        chromeMediaSourceId: S.selected.id,
      }
    } : false,
    video: {
      mandatory: {
        chromeMediaSource:   'desktop',
        chromeMediaSourceId: S.selected.id,
        maxWidth: MAX_RECORDING_WIDTH,
        maxHeight: MAX_RECORDING_HEIGHT,
        minFrameRate: 15, maxFrameRate: fps,
      }
    }
  });

  try {
    return await withTimeout(
      navigator.mediaDevices.getUserMedia(constraints(false)),
      15000,
      'Screen capture timed out'
    );
  } catch (e) {
    throw e;
  }
}

async function mixAudioTracks(streams) {
  const tracks = streams.flatMap(stream => stream?.getAudioTracks?.() || []);
  if (!tracks.length) return null;
  if (tracks.length === 1) {
    reportAudioDiagnostic('audio-direct-track', {
      label: tracks[0].label,
      readyState: tracks[0].readyState,
      enabled: tracks[0].enabled,
      muted: tracks[0].muted,
      settings: tracks[0].getSettings?.() || {},
    });
    return new MediaStream([tracks[0]]);
  }

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return new MediaStream(tracks);

  const ctx = new AudioCtx();
  S.audioContext = ctx;
  S.audioNodes = [];
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch {}
  }
  reportAudioDiagnostic('audio-mixer-start', {
    trackCount: tracks.length,
    audioContextState: ctx.state,
    tracks: tracks.map(track => ({
      label: track.label,
      readyState: track.readyState,
      enabled: track.enabled,
      muted: track.muted,
      settings: track.getSettings?.() || {},
    })),
  });
  const destination = ctx.createMediaStreamDestination();
  for (const track of tracks) {
    const stream = new MediaStream([track]);
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = 1 / Math.sqrt(tracks.length);
    source.connect(gain).connect(destination);
    S.audioNodes.push({ stream, source, gain, track });
  }
  S.audioNodes.push({ destination });
  return destination.stream;
}

function inspectRecordingAudio(recordStream, rawStream, micStream, nativeMic) {
  const recordingTracks = recordStream?.getAudioTracks?.() || [];
  const systemTracks = rawStream?.getAudioTracks?.() || [];
  const micTracks = micStream?.getAudioTracks?.() || [];
  const info = {
    recordingTracks: recordingTracks.filter(t => t.readyState === 'live').length,
    systemTracks: systemTracks.filter(t => t.readyState === 'live').length,
    micTracks: micTracks.filter(t => t.readyState === 'live').length,
    nativeMicTracks: nativeMic?.ok ? 1 : 0,
  };
  if (S.cfg.mic && !info.micTracks && !info.nativeMicTracks) {
    throw new Error('Microphone is on, but no live microphone audio track reached the recorder.');
  }
  if (S.cfg.systemAudio && !info.systemTracks && !info.micTracks && !info.nativeMicTracks) {
    throw new Error('System audio is on, but macOS/Electron did not return a system audio track. Turn on Microphone or turn off System audio for this recording.');
  }
  if ((S.cfg.mic || S.cfg.systemAudio) && !info.recordingTracks && !info.nativeMicTracks) {
    throw new Error('Audio was requested, but no audio track was attached to MediaRecorder.');
  }
  reportAudioDiagnostic('recorder-audio-tracks', info);
  return info;
}

async function buildCompositedStream(screenStream, camStream, targetFps = 30) {
  const screenVideo = document.createElement('video');
  prepareMediaElement(screenVideo);
  screenVideo.srcObject = screenStream;
  await playMediaElement(screenVideo, 'Screen preview did not start');
  S.compositeVideos.push(screenVideo);

  let camVideo = null;
  if (camStream) {
    camVideo = createCompositorVideo(camStream, 'screenforge-record-me-compositor');
    await waitForVideoReady(camVideo, 5000, 'Record Me camera opened but did not deliver drawable frames');
  }

  const canvas = $('recCanvas');
  const settings = screenStream.getVideoTracks()[0]?.getSettings?.() || {};
  const sourceW = settings.width || 1920;
  const sourceH = settings.height || 1080;
  const area = captureAreaPx(sourceW, sourceH);
  const output = recordingOutputSize(area.w, area.h);
  canvas.width = output.width;
  canvas.height = output.height;
  const ctx = canvas.getContext('2d');
  const fps = recordingFps({ requested: targetFps, composited: true });
  const frameMs = 1000 / fps;
  S.canvasStream = canvas.captureStream(0);
  const canvasTrack = S.canvasStream.getVideoTracks()[0];

  const draw = () => {
    if (!S.rawStream) return;
    ctx.drawImage(screenVideo, area.x, area.y, area.w, area.h, 0, 0, canvas.width, canvas.height);
    if (camVideo?.videoWidth > 0 && camVideo?.videoHeight > 0 && camVideo.readyState >= 2) {
      drawWebcamBubble(ctx, camVideo, canvas.width, canvas.height);
    }
    canvasTrack?.requestFrame?.();
  };
  draw();
  S.drawTimer = setInterval(draw, frameMs);
  return S.canvasStream;
}

function createCompositorVideo(stream, id) {
  const video = document.createElement('video');
  prepareMediaElement(video);
  video.id = id;
  video.srcObject = stream;
  video.style.position = 'fixed';
  video.style.left = '-10000px';
  video.style.top = '0';
  video.style.width = '2px';
  video.style.height = '2px';
  video.style.opacity = '0.01';
  video.style.pointerEvents = 'none';
  video.style.zIndex = '-1';
  document.body.appendChild(video);
  video.play?.().catch(e => console.warn(`${id} pending:`, e.message));
  S.compositeVideos.push(video);
  return video;
}

function captureAreaPx(width, height) {
  const a = sanitizeCaptureArea(S.cfg.captureArea);
  if (!a) return { x: 0, y: 0, w: width, h: height };
  const x = clamp(Number(a.xPct), 0, 0.98);
  const y = clamp(Number(a.yPct), 0, 0.98);
  const w = clamp(Number(a.wPct), 0.05, 1 - x);
  const h = clamp(Number(a.hPct), 0.05, 1 - y);
  const px = Math.round(x * width);
  const py = Math.round(y * height);
  const pw = Math.max(2, Math.round(w * width));
  const ph = Math.max(2, Math.round(h * height));
  return {
    x: px - (px % 2),
    y: py - (py % 2),
    w: pw - (pw % 2),
    h: ph - (ph % 2),
  };
}

function sanitizeCaptureArea(area) {
  if (!area) return null;
  const x = Number(area.xPct);
  const y = Number(area.yPct);
  const w = Number(area.wPct);
  const h = Number(area.hPct);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w < 0.05 || h < 0.05) return null;
  if (x < 0 || y < 0 || x >= 1 || y >= 1) return null;
  return {
    xPct: clamp(x, 0, 0.98),
    yPct: clamp(y, 0, 0.98),
    wPct: clamp(w, 0.05, 1 - clamp(x, 0, 0.98)),
    hPct: clamp(h, 0.05, 1 - clamp(y, 0, 0.98)),
  };
}

function drawWebcamBubble(ctx, camVideo, width, height) {
  const custom = S.cfg.webcamRect;
  const shape  = S.cfg.webcamShape || 'rounded';
  const bubbleW = Math.round(width * clamp(Number(custom?.wPct ?? 0.18), 0.08, 0.42));
  const bubbleH = shape === 'circle'
    ? bubbleW
    : Math.round(custom?.hPct ? height * clamp(Number(custom.hPct), 0.08, 0.42) : bubbleW * 0.62);
  const margin = Math.round(width * 0.035);
  const pos = webcamPosition(width, height, bubbleW, bubbleH, margin);
  const x = pos.x;
  const y = pos.y;

  ctx.save();
  if (shape === 'circle') {
    const cx = x + bubbleW / 2, cy = y + bubbleH / 2, r = bubbleW / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  } else if (shape === 'rect') {
    ctx.beginPath();
    ctx.rect(x, y, bubbleW, bubbleH);
  } else {
    const radius = Math.round(bubbleH * 0.22);
    roundedRect(ctx, x, y, bubbleW, bubbleH, radius);
  }
  ctx.clip();
  drawVideoCover(ctx, camVideo, x, y, bubbleW, bubbleH);
  ctx.restore();

  // Border
  const borderColor = S.cfg.webcamBorderColor || 'rgba(255,255,255,.72)';
  const borderWidth = Math.max(1, Number(S.cfg.webcamBorderWidth || 2));
  ctx.save();
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = borderWidth;
  if (shape === 'circle') {
    const cx = x + bubbleW / 2, cy = y + bubbleH / 2, r = bubbleW / 2 - borderWidth / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  } else if (shape === 'rect') {
    ctx.beginPath();
    ctx.rect(x + borderWidth/2, y + borderWidth/2, bubbleW - borderWidth, bubbleH - borderWidth);
  } else {
    const radius = Math.round(bubbleH * 0.22);
    roundedRect(ctx, x, y, bubbleW, bubbleH, radius);
  }
  ctx.stroke();
  ctx.restore();
}

function drawVideoCover(ctx, video, x, y, w, h) {
  const vw = video.videoWidth || w;
  const vh = video.videoHeight || h;
  const scale = Math.max(w / vw, h / vh);
  const sw = w / scale;
  const sh = h / scale;
  const sx = Math.max(0, (vw - sw) / 2);
  const sy = Math.max(0, (vh - sh) / 2);
  ctx.save();
  ctx.translate(x + w, y);
  ctx.scale(-1, 1);
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  ctx.restore();
}

function webcamPosition(width, height, bubbleW, bubbleH, margin) {
  if (S.cfg.webcamRect) {
    return {
      x: Math.round(clamp(width * clamp(Number(S.cfg.webcamRect.xPct ?? 0.78), 0, 1) - bubbleW / 2, margin, width - bubbleW - margin)),
      y: Math.round(clamp(height * clamp(Number(S.cfg.webcamRect.yPct ?? 0.82), 0, 1) - bubbleH / 2, margin, height - bubbleH - margin)),
    };
  }

  let pos = S.cfg.webcamPos || 'br';
  const cursor = S.recEvents.cursor[S.recEvents.cursor.length - 1];
  if (S.cfg.webcamAvoidCursor && cursor) {
    const boxes = {
      br: { x0: 1 - (bubbleW + margin) / width, y0: 1 - (bubbleH + margin) / height },
      bl: { x0: margin / width, y0: 1 - (bubbleH + margin) / height },
      tr: { x0: 1 - (bubbleW + margin) / width, y0: margin / height },
      tl: { x0: margin / width, y0: margin / height },
    };
    const b = boxes[pos];
    const insideX = cursor.xPct >= b.x0 - 0.05 && cursor.xPct <= b.x0 + bubbleW / width + 0.05;
    const insideY = cursor.yPct >= b.y0 - 0.05 && cursor.yPct <= b.y0 + bubbleH / height + 0.05;
    if (insideX && insideY) pos = pos === 'br' ? 'tl' : pos === 'bl' ? 'tr' : pos === 'tr' ? 'bl' : 'br';
  }

  return {
    x: pos.endsWith('r') ? width - bubbleW - margin : margin,
    y: pos.startsWith('t') ? margin : height - bubbleH - margin,
  };
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function togglePauseRecording() {
  if (!S.isRec || !S.recorder) return;
  if (S.recorder.state === 'recording') {
    S.recorder.pause();
    S.isPaused = true;
    S.recPausedAt = performance.now();
  } else if (S.recorder.state === 'paused') {
    if (S.recPausedAt) S.recPausedTotal += performance.now() - S.recPausedAt;
    S.recPausedAt = 0;
    S.recorder.resume();
    S.isPaused = false;
  }
  // Sync pause state to float bar
  if (window.sf?.sendPauseState) screenforgeApi.sendPauseState(S.isPaused);
}

function addMarker() {
  if (!S.isRec) return;
  const t = eventTime({});
  S.keyframes.push({
    id: Date.now(),
    type: 'marker',
    time: t,
    label: `Marker ${S.keyframes.filter(k => k.type === 'marker').length + 1}`,
  });
}

async function finishRecording() {
  cleanupCaptureStreams();
  S.recorder = null;
  S.isPaused = false;

  // Bring main window back before showing any UI
  screenforgeApi.recordingStopped();

  // If click zooms were switched on but nothing was captured, say so now. This
  // is the moment the user goes looking for the effect, and silence here is what
  // makes it read as "the feature is broken" rather than "this source can't do
  // it".
  if (S.cfg.zoom && !S.recEvents.clicks.length) {
    showFloatToast(
      pointerTrackingUnavailable()
        ? 'No click zooms: a window source cannot report click positions. Use Display or Area.'
        : 'No click zooms were added because no clicks were detected inside the recording area.',
    );
  }

  const btn = $('recordBtn');
  btn.disabled = true; btn.textContent = 'Processing…';

  try {
    const blob    = new Blob(S.chunks, { type: 'video/webm' });
    const ab      = await blob.arrayBuffer();
    const nativeMicResult = await stopNativeMicCapture();
    const nativeAudioPath = nativeMicResult?.audioPath || null;
    const nativeAudioOffsetMs = nativeAudioPath ? (S.nativeMic?.offsetMs || 0) : 0;
    const outPath = await screenforgeApi.saveRecording({
      buffer: ab,
      hasPad: S.cfg.pad,
      nativeAudioPath,
      nativeAudioOffsetMs,
      nativeAudioFormat: nativeMicResult?.audioFormat || S.nativeMic?.audioFormat || '',
      nativeAudioSampleRate: nativeMicResult?.sampleRate || S.nativeMic?.sampleRate || 48000,
      nativeAudioChannels: nativeMicResult?.channels || S.nativeMic?.channels || 1,
    });
    try {
      const mediaInfo = await screenforgeApi.probeVideo(outPath);
      reportAudioDiagnostic('saved-file-probe', mediaInfo);
      if ((S.cfg.mic || S.cfg.systemAudio) && mediaInfo && mediaInfo.hasAudio === false) {
        alert('Recording saved, but the file has no audio track. Check ~/Library/Logs/ScreenForge/main.log for the audio diagnostic lines.');
      }
    } catch (err) {
      reportAudioDiagnostic('saved-file-probe-error', { message: err?.message || String(err) });
    }
    // Clean up auto-save recovery file after successful save
    if (S.recSessionId && window.sf?.deleteRecoverySession) {
      screenforgeApi.deleteRecoverySession(`recovery-${S.recSessionId}.webm`).catch(() => {});
    }
    // Auto-save to clip library if enabled
    if (S.cfg.autoSaveToLibrary !== false && window.sf?.saveToLibrary) {
      screenforgeApi.saveToLibrary({ sourcePath: outPath, title: `Recording ${new Date().toLocaleString()}` })
        .then(() => refreshClipLibrary())
        .catch(() => {});
    }
    const capturedKeyframes = [...S.keyframes].sort((a, b) => a.time - b.time);
    btn.disabled = false; btn.textContent = 'Start Recording';
    openEditor(outPath, capturedKeyframes, structuredClone(S.recEvents));
  } catch(e) {
    btn.disabled = false; btn.textContent = 'Start Recording';
    alert('Save failed: ' + e.message);
  } finally {
    S.nativeMic = null;
    S.nativeMicStopPromise = null;
    S.useNativeMic = false;
  }
}

function cleanupCaptureStreams() {
  S.rawStream?.getTracks().forEach(t => t.stop());
  S.micStream?.getTracks().forEach(t => t.stop());
  S.camStream?.getTracks().forEach(t => t.stop());
  S.audioStream?.getTracks().forEach(t => t.stop());
  S.canvasStream?.getTracks().forEach(t => t.stop());
  for (const video of S.compositeVideos || []) {
    try {
      video.pause?.();
      video.srcObject = null;
      video.remove?.();
    } catch {}
  }
  if (S.drawLoop) cancelAnimationFrame(S.drawLoop);
  if (S.drawTimer) clearInterval(S.drawTimer);
  try { S.audioContext?.close?.(); } catch {}
  S.rawStream = null;
  S.micStream = null;
  S.camStream = null;
  S.audioStream = null;
  S.audioContext = null;
  S.audioNodes = [];
  S.audioInfo = null;
  S.canvasStream = null;
  S.compositeVideos = [];
  S.drawLoop = null;
  S.drawTimer = null;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  EDITOR
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function normalizeEditorKeyframes(keyframes) {
  if (!Array.isArray(keyframes)) return [];
  const allowedTypes = new Set(['zoom', 'text', 'caption', 'key', 'click', 'marker']);
  const allowedPositions = new Set(['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']);
  const allowedAnimations = new Set(['fade', 'slide-up', 'pop', 'none']);
  const usedIds = new Set();
  let zoomCount = 0;
  return keyframes.slice(0, 5000).map((value, index) => {
    const raw = value && typeof value === 'object' ? value : {};
    const type = allowedTypes.has(raw.type) ? raw.type : 'marker';
    let id = Number(raw.id);
    if (!Number.isSafeInteger(id) || usedIds.has(id)) id = Date.now() + index;
    usedIds.add(id);
    const color = /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : '#ffffff';
    const bgColor = /^#[0-9a-f]{6}$/i.test(raw.bgColor) ? raw.bgColor : '#000000';
    if (type === 'zoom') {
      zoomCount += 1;
      if (zoomCount > MAX_ZOOM_SHOTS) return null;
    }
    return {
      ...raw,
      id,
      type,
      time: Math.max(0, Number(raw.time) || 0),
      duration: clamp(Number(raw.duration) || (type === 'zoom' ? 3 : 1), 0.05, 86400),
      text: String(raw.text || '').slice(0, 2000),
      label: String(raw.label || '').slice(0, 240),
      font: String(raw.font || 'Inter,sans-serif').slice(0, 120),
      size: clamp(Math.round(Number(raw.size) || 32), 8, 240),
      bold: !!raw.bold,
      italic: !!raw.italic,
      shadow: !!raw.shadow,
      outline: !!raw.outline,
      color,
      bgColor,
      bgOpacity: clamp(Number(raw.bgOpacity) || 0, 0, 100),
      position: allowedPositions.has(raw.position) ? raw.position : 'bc',
      animation: allowedAnimations.has(raw.animation) ? raw.animation : 'fade',
      fadeIn: clamp(Number(raw.fadeIn ?? 0.3), 0, 30),
      fadeOut: clamp(Number(raw.fadeOut ?? 0.3), 0, 30),
      zoomLevel: clamp(Number(raw.zoomLevel) || 1.5, 1, 4),
      xPct: Number.isFinite(Number(raw.xPct)) ? clamp(Number(raw.xPct), 0, 1) : 0.5,
      yPct: Number.isFinite(Number(raw.yPct)) ? clamp(Number(raw.yPct), 0, 1) : 0.5,
      source: String(raw.source || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40),
    };
  }).filter(Boolean);
}

function normalizeRecEvents(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const normalizePointEvent = (value, index, kind) => {
    const event = value && typeof value === 'object' ? value : {};
    const time = Number(event.time);
    const xPct = Number(event.xPct);
    const yPct = Number(event.yPct);
    if (![time, xPct, yPct].every(Number.isFinite) || time < 0 || time > 86400) return null;
    return {
      id: Number.isSafeInteger(Number(event.id)) ? Number(event.id) : index + 1,
      type: kind,
      time,
      duration: clamp(Number(event.duration) || (kind === 'click' ? 0.8 : 0.12), 0.02, 30),
      xPct: clamp(xPct, 0, 1),
      yPct: clamp(yPct, 0, 1),
      button: clamp(Math.round(Number(event.button) || 0), 0, 8),
    };
  };
  const clicks = Array.isArray(raw.clicks)
    ? raw.clicks.slice(0, 10000).map((event, index) => normalizePointEvent(event, index, 'click')).filter(Boolean)
    : [];
  const cursor = Array.isArray(raw.cursor)
    ? raw.cursor.slice(0, 20000).map((event, index) => normalizePointEvent(event, index, 'cursor')).filter(Boolean)
    : [];
  const keys = Array.isArray(raw.keys) ? raw.keys.slice(0, 10000).map((value, index) => {
    const event = value && typeof value === 'object' ? value : {};
    const time = Number(event.time);
    if (!Number.isFinite(time) || time < 0 || time > 86400) return null;
    return {
      id: Number.isSafeInteger(Number(event.id)) ? Number(event.id) : index + 1,
      type: 'key',
      time,
      duration: clamp(Number(event.duration) || 1.4, 0.02, 30),
      keycode: clamp(Math.round(Number(event.keycode) || 0), 0, 100000),
      label: String(event.label || '').replace(/[\r\n]/g, ' ').slice(0, 120),
      altKey: !!event.altKey,
      ctrlKey: !!event.ctrlKey,
      metaKey: !!event.metaKey,
      shiftKey: !!event.shiftKey,
    };
  }).filter(Boolean) : [];
  return { clicks, cursor, keys };
}

function normalizeBlurZones(zones) {
  if (!Array.isArray(zones)) return [];
  return zones.slice(0, 200).map((value, index) => {
    const raw = value && typeof value === 'object' ? value : {};
    return {
      id: Number.isSafeInteger(Number(raw.id)) ? Number(raw.id) : Date.now() + index,
      startTime: Math.max(0, Number(raw.startTime) || 0),
      endTime: Math.max(0.05, Number(raw.endTime) || 3),
      xPct: Number.isFinite(Number(raw.xPct)) ? clamp(Number(raw.xPct), 0, 0.99) : 0.1,
      yPct: Number.isFinite(Number(raw.yPct)) ? clamp(Number(raw.yPct), 0, 0.99) : 0.1,
      wPct: Number.isFinite(Number(raw.wPct)) ? clamp(Number(raw.wPct), 0.01, 1) : 0.3,
      hPct: Number.isFinite(Number(raw.hPct)) ? clamp(Number(raw.hPct), 0.01, 1) : 0.2,
      radius: clamp(Math.round(Number(raw.radius) || 20), 1, 80),
    };
  }).map(zone => ({
    ...zone,
    endTime: Math.max(zone.startTime + 0.05, zone.endTime),
    wPct: Math.min(zone.wPct, 1 - zone.xPct),
    hPct: Math.min(zone.hPct, 1 - zone.yPct),
  }));
}

function applySafeProjectConfig(input) {
  if (!input || typeof input !== 'object') return;
  const booleanKeys = [
    'zoom', 'cursor', 'pad', 'shortcuts', 'clickRings', 'mic', 'systemAudio',
    'audioCleanup', 'webcam', 'webcamAvoidCursor', 'cursorTrail', 'captions',
    'musicDucking', 'frame', 'autoSaveToLibrary',
  ];
  booleanKeys.forEach(key => {
    if (typeof input[key] === 'boolean') S.cfg[key] = input[key];
  });

  const numberRules = {
    zoomLevel: [1, 4], fps: [15, 60], countdown: [0, 10], webcamBorderWidth: [0, 16],
    cursorSize: [0.5, 3], speedMultiplier: [0.5, 4], silenceThreshold: [-80, -10],
    silenceMinDuration: [0.1, 10], silencePadding: [0, 2], musicVolume: [0.02, 0.35],
    bgPadding: [0, 0.22], bgBlur: [0, 1],
  };
  Object.entries(numberRules).forEach(([key, [min, max]]) => {
    const value = Number(input[key]);
    if (Number.isFinite(value)) S.cfg[key] = clamp(value, min, max);
  });

  const enumRules = {
    webcamPos: new Set(['tl', 'tr', 'bl', 'br']),
    webcamShape: new Set(['circle', 'rounded', 'rect']),
    quality: new Set(['draft', 'good', 'high', 'ultra', 'lossless']),
    cursorTheme: new Set(['accent', 'red', 'dark', 'light']),
    directorProfile: new Set(['calm', 'tutorial', 'energetic']),
    bgMode: new Set(['gradient', 'solid']),
  };
  Object.entries(enumRules).forEach(([key, allowed]) => {
    if (allowed.has(input[key])) S.cfg[key] = input[key];
  });
  if (/^#[0-9a-f]{6}$/i.test(input.webcamBorderColor)) S.cfg.webcamBorderColor = input.webcamBorderColor;
  if (/^#[0-9a-f]{6}$/i.test(input.bgSolidColor)) S.cfg.bgSolidColor = input.bgSolidColor;

  const sanitizeRect = (value) => {
    if (!value || typeof value !== 'object') return null;
    const xPct = Number(value.xPct), yPct = Number(value.yPct), wPct = Number(value.wPct), hPct = Number(value.hPct);
    if (![xPct, yPct, wPct, hPct].every(Number.isFinite)) return null;
    return {
      xPct: clamp(xPct, 0, 0.99),
      yPct: clamp(yPct, 0, 0.99),
      wPct: clamp(wPct, 0.01, 1),
      hPct: clamp(hPct, 0.01, 1),
    };
  };
  const webcamRect = sanitizeRect(input.webcamRect);
  if (webcamRect) S.cfg.webcamRect = webcamRect;
  const captureArea = sanitizeRect(input.captureArea);
  if (captureArea) S.cfg.captureArea = captureArea;

  if (input.watermark && typeof input.watermark === 'object') {
    const position = ['tl', 'tr', 'bl', 'br', 'center'].includes(input.watermark.position)
      ? input.watermark.position
      : 'br';
    S.cfg.watermark = {
      enabled: !!input.watermark.enabled,
      text: String(input.watermark.text || '').replace(/[\r\n]/g, ' ').slice(0, 60),
      position,
      opacity: clamp(Number(input.watermark.opacity) || 0.5, 0.1, 1),
      size: clamp(Math.round(Number(input.watermark.size) || 18), 8, 96),
    };
  }
}

async function openEditor(videoPath, keyframes = [], recEvents = null) {
  const requestedZoomCount = Array.isArray(keyframes)
    ? keyframes.filter(keyframe => keyframe?.type === 'zoom').length
    : 0;
  S.videoPath = videoPath;
  S.keyframes = normalizeEditorKeyframes(keyframes);
  S.recEvents = normalizeRecEvents(recEvents);
  S.transcript = { text: '', cues: [], srt: '', srtPath: null };
  S.adj        = { b: 0, c: 0, s: 0 };
  S.cuts       = [];
  S.removedRanges = [];
  S.blurZones  = [];
  _selectedBlurZoneId = null;
  _directorUndo = null;
  $('directorUndoBtn')?.classList.add('hidden');
  S.razorMode  = false;
  S.videoHasAudio = false;

  showScreen('editor');
  if (requestedZoomCount > MAX_ZOOM_SHOTS || S.zoomLimitReached) {
    showFloatToast(`Camera moves are limited to ${MAX_ZOOM_SHOTS} visible segments per project for reliable export`);
  }
  S.zoomLimitReached = false;

  const vid = $('videoPreview');
  const rawVideoPath = String(videoPath || '');
  const videoUrl = /^(blob:|data:video\/|file:)/i.test(rawVideoPath)
    ? rawVideoPath
    : filePathToUrl(rawVideoPath);
  if (!videoUrl) throw new Error('The selected video path is invalid');
  vid.src = videoUrl;
  vid.style.filter = '';
  vid.load();
  const backdrop = $('previewBackdropVideo');
  if (backdrop) {
    backdrop.src = videoUrl;
    backdrop.load();
  }

  ['brightness','contrast','saturation'].forEach(k => {
    const el = $(k); if (el) el.value = 0;
    const vl = $(k + 'Val'); if (vl) vl.textContent = '0';
  });

  try {
    const info = await screenforgeApi.probeVideo(videoPath);
    S.videoW = info.width || 0;
    S.videoH = info.height || 0;
    S.videoFps = clamp(Number(info.fps) || 30, 1, 240);
    S.videoHasAudio = !!info.hasAudio;
    if (info.duration > 0) { S.dur = info.duration; onVideoLoaded(); }
  } catch {}

  renderKfLists();
  renderRemovalSummary();
}

async function importVideo() {
  try {
    const filePath = await screenforgeApi.openVideoFile();
    if (filePath) openEditor(filePath, [], { clicks: [], keys: [], cursor: [] });
  } catch (e) {
    alert('Import failed: ' + e.message);
  }
}

function currentProject() {
  return {
    version: 3,
    savedAt: new Date().toISOString(),
    videoPath: S.videoPath,
    duration: S.dur,
    videoW: S.videoW,
    videoH: S.videoH,
    videoFps: S.videoFps,
    trimIn: S.trimIn,
    trimOut: S.trimOut,
    keyframes: S.keyframes,
    cuts: S.cuts,
    removedRanges: S.removedRanges,
    blurZones: S.blurZones,
    recEvents: S.recEvents,
    adj: S.adj,
    cfg: S.cfg,
    bgPreset: S.bgPreset,
    transcript: S.transcript,
    backgroundMusicPath: _bgMusicPath,
  };
}

async function saveProject() {
  if (!S.videoPath) { alert('Record or import a video first.'); return; }
  try {
    const out = await screenforgeApi.saveProjectFile(currentProject());
    if (out) alert('Project saved.');
  } catch (e) {
    alert('Project save failed: ' + e.message);
  }
}

async function openProject() {
  try {
    const data = await screenforgeApi.openProjectFile();
    if (!data?.project?.videoPath) return;
    const p = data.project;
    applySafeProjectConfig(p.cfg);
    S.bgPreset = clamp(Math.round(Number(p.bgPreset) || 0), 0, BG_PRESETS.length - 1);
    S.transcript = p.transcript || { text: '', cues: [], srt: '', srtPath: null };
    await openEditor(p.videoPath, p.keyframes || [], p.recEvents || { clicks: [], keys: [], cursor: [] });
    S.transcript = p.transcript || { text: '', cues: [], srt: '', srtPath: null };
    S.adj        = p.adj  || { b: 0, c: 0, s: 0 };
    S.cuts       = Array.isArray(p.cuts)
      ? p.cuts.map(Number).filter(Number.isFinite).filter(value => value > 0 && value < 86400).slice(0, 5000)
      : [];
    S.removedRanges = CreatorEngine.normalizeRanges(p.removedRanges || [], {
      start: 0,
      end: Number(p.duration || S.dur || 0),
    });
    S.blurZones  = normalizeBlurZones(p.blurZones);
    _bgMusicPath = p.backgroundMusicPath || null;
    S.trimIn = Number(p.trimIn || 0);
    S.trimOut = Number(p.trimOut || S.dur || 0);
    syncRemovedRanges({ redraw: false });
    updateTrimHandles();
    updateTrimDisplay();
    drawKfLayer();
    renderKfLists();
    renderRemovalSummary();
    syncBackgroundMusicUi();
    syncConfigControls();
  } catch (e) {
    alert('Project open failed: ' + e.message);
  }
}

function syncConfigControls() {
  for (const key of ['zoom','cursor','pad','shortcuts','clickRings','mic','systemAudio','audioCleanup','webcam','captions','frame','autoSaveToLibrary']) {
    syncSettingToggle(key);
  }
  if ($('toggle-autoSaveToLibrary')) {
    $('toggle-autoSaveToLibrary').textContent = S.cfg.autoSaveToLibrary === false ? 'Off' : 'On';
  }
  if ($('cursorTheme')) $('cursorTheme').value = S.cfg.cursorTheme || 'accent';
  if ($('cursorSize')) $('cursorSize').value = S.cfg.cursorSize || 1;
  if ($('webcamPos')) $('webcamPos').value = S.cfg.webcamPos || 'br';
  if ($('webcamShape')) $('webcamShape').value = S.cfg.webcamShape || 'rounded';
  if ($('fpsSelect')) $('fpsSelect').value = recordingFps({ requested: S.cfg.fps });
  if ($('qualitySelect')) $('qualitySelect').value = S.cfg.quality || 'high';
  if ($('countdownSelect')) $('countdownSelect').value = S.cfg.countdown ?? 3;
  if ($('directorProfile')) $('directorProfile').value = S.cfg.directorProfile || 'tutorial';
  if ($('silenceThreshold')) $('silenceThreshold').value = String(S.cfg.silenceThreshold ?? -35);
  if ($('silenceMinDuration')) $('silenceMinDuration').value = String(S.cfg.silenceMinDuration ?? 0.5);
  if ($('silencePadding')) $('silencePadding').value = String(S.cfg.silencePadding ?? 0.12);
  if ($('bgMusicVolume')) $('bgMusicVolume').value = Math.round(Number(S.cfg.musicVolume ?? 0.12) * 100);
  if ($('bgMusicVolumeLabel')) $('bgMusicVolumeLabel').textContent = `${Math.round(Number(S.cfg.musicVolume ?? 0.12) * 100)}%`;
  if ($('musicDucking')) $('musicDucking').checked = S.cfg.musicDucking !== false;
  if ($('bgSolidColor')) $('bgSolidColor').value = S.cfg.bgSolidColor || '#1a1a2e';
  if ($('bgPaddingSlider')) $('bgPaddingSlider').value = String(Math.round(Number(S.cfg.bgPadding ?? 0.05) * 100));
  if ($('bgPadVal')) $('bgPadVal').textContent = `${Math.round(Number(S.cfg.bgPadding ?? 0.05) * 100)}%`;
  if ($('bgBlurSlider')) $('bgBlurSlider').value = String(Math.round(Number(S.cfg.bgBlur ?? 0.4) * 100));
  if ($('bgBlurVal')) $('bgBlurVal').textContent = `${Math.round(Number(S.cfg.bgBlur ?? 0.4) * 100)}%`;
  const gradientMode = S.cfg.bgMode !== 'solid';
  $('bgtab-gradient')?.classList.toggle('active', gradientMode);
  $('bgtab-solid')?.classList.toggle('active', !gradientMode);
  $('bgtab-gradient')?.setAttribute('aria-pressed', String(gradientMode));
  $('bgtab-solid')?.setAttribute('aria-pressed', String(!gradientMode));
  $('bgGradientGrid')?.classList.toggle('hidden', !gradientMode);
  $('bgSolidPanel')?.classList.toggle('hidden', gradientMode);
  syncBackgroundPresetControls();
  syncSolidBackgroundControls();
  setZoomLevel(S.cfg.zoomLevel || 2);
  if ($('brightness')) $('brightness').value = S.adj.b || 0;
  if ($('contrast')) $('contrast').value = S.adj.c || 0;
  if ($('saturation')) $('saturation').value = S.adj.s || 0;
  if ($('brightnessVal')) $('brightnessVal').textContent = S.adj.b || 0;
  if ($('contrastVal')) $('contrastVal').textContent = S.adj.c || 0;
  if ($('saturationVal')) $('saturationVal').textContent = S.adj.s || 0;
  if ($('videoPreview')) updateAdjust();
  drawBgPreview();
  updatePresentationPreview();
}

// ── Device enumeration ────────────────────────────────────────────────────────

async function loadDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    const cams = devices.filter(d => d.kind === 'videoinput');
    populateDeviceSelect('micDeviceSelect', mics, S.cfg.micDeviceId);
    populateDeviceSelect('camDeviceSelect', cams, S.cfg.camDeviceId);
  } catch (e) {
    console.warn('Device enum failed:', e.message);
  }
}

function populateDeviceSelect(elId, devices, selected) {
  const el = $(elId);
  if (!el) return;
  el.innerHTML = devices.map((d, index) => {
    const label = d.label || `${d.kind === 'audioinput' ? 'Microphone' : 'Camera'} ${index + 1}`;
    return `<option value="${escapeHtml(d.deviceId)}" ${d.deviceId === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
  if (!el.innerHTML) el.innerHTML = '<option value="">Default</option>';
}

function setMicDevice(id) { S.cfg.micDeviceId = id; }
function setCamDevice(id) {
  S.cfg.camDeviceId = id;
  schedulePersist?.();
  if (S.cfg.webcam) {
    stopCameraPreview();
    startCameraPreview();
  }
}
function setFps(fps) {
  S.cfg.fps = recordingFps({ requested: fps });
  S.cfg.fpsDefaultVersion = 2;
}
function setQuality(q) { S.cfg.quality = q; }
function setCountdown(n) {
  S.cfg.countdown = Number(n);
  S.cfg.countdownDefaultVersion = 3;
}
function setWebcamShape(shape) { S.cfg.webcamShape = shape; }
function setWebcamBorderColor(color) { S.cfg.webcamBorderColor = color; }
function setSpeedMultiplier(v) { S.cfg.speedMultiplier = Number(v); }

async function chooseOutputDir() {
  const dir = await screenforgeApi.chooseOutputDir();
  if (dir) {
    S.cfg.outputDir = dir;
    const el = $('outputDirLabel');
    if (el) el.textContent = dir.split('/').pop() || dir;
  }
}

// ── Crash recovery ────────────────────────────────────────────────────────────

let _recoverySessions = [];

async function checkRecoverySessions() {
  if (!window.sf?.listRecoverySessions) return;
  _recoverySessions = await screenforgeApi.listRecoverySessions();
  const panel = $('recoveryPanel');
  if (!panel) return;
  if (!_recoverySessions.length) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const list = $('recoveryList');
  if (list) {
    list.innerHTML = _recoverySessions.map((s, index) => {
      const mb = (s.size / 1024 / 1024).toFixed(1);
      const dt = new Date(s.mtime).toLocaleString();
      return `<div class="flex items-center gap-2 py-1.5 px-2 rounded-lg"
                   style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06)">
        <div class="flex-1 min-w-0">
          <div class="text-[11px] font-semibold" style="color:rgba(255,255,255,.8)">${escapeHtml(mb)} MB · ${escapeHtml(dt)}</div>
        </div>
        <button onclick="recoverSessionAt(${index}, this)" class="nd px-2 py-1 rounded text-[10px] font-bold"
          style="background:rgba(96,165,250,.15);color:#60a5fa;border:1px solid rgba(96,165,250,.3)">Recover</button>
        <button onclick="dismissRecoveryAt(${index})" class="nd px-2 py-1 rounded text-[10px]"
          style="background:rgba(255,255,255,.06);color:rgba(255,255,255,.4)">Dismiss</button>
      </div>`;
    }).join('');
  }
}

async function recoverSessionAt(index, btn) {
  const session = _recoverySessions[index];
  if (!session) return;
  await recoverSession(session.path, btn);
}

async function recoverSession(filePath, btn = null) {
  if (btn) { btn.disabled = true; btn.textContent = 'Converting…'; }
  try {
    const outPath = await screenforgeApi.saveRecording({ buffer: null, hasPad: false, recoveryPath: filePath });
    await screenforgeApi.deleteRecoverySession(filePath);
    const panel = $('recoveryPanel');
    if (panel) panel.classList.add('hidden');
    openEditor(outPath, [], { clicks: [], keys: [], cursor: [] });
  } catch (e) {
    alert('Recovery failed: ' + e.message);
  }
}

async function dismissRecoveryAt(index) {
  const session = _recoverySessions[index];
  if (!session) return;
  await screenforgeApi.deleteRecoverySession(session.path);
  await checkRecoverySessions();
}

// ── Auto-save during recording ────────────────────────────────────────────────

function startAutoSave() {
  S.recSessionId = Date.now().toString();
  stopAutoSave();
  S.autoSaveTimer = setInterval(async () => {
    if (!S.isRec || !S.chunks.length || !window.sf?.autoSaveChunk) return;
    try {
      const blob = new Blob([...S.chunks], { type: 'video/webm' });
      const ab = await blob.arrayBuffer();
      await screenforgeApi.autoSaveChunk({ buffer: ab, sessionId: S.recSessionId });
    } catch (e) { console.warn('Auto-save failed:', e.message); }
  }, 10000);
}

function stopAutoSave() {
  if (S.autoSaveTimer) { clearInterval(S.autoSaveTimer); S.autoSaveTimer = null; }
}

// ── Screenshot during recording ───────────────────────────────────────────────

async function takeScreenshotDuringRecording() {
  if (!S.isRec) return;
  try {
    const outPath = await screenforgeApi.takeScreenshot();
    if (outPath) {
      showFloatToast('Screenshot saved');
    }
  } catch {}
}

// ─── Fault reporting ─────────────────────────────────────────────────────────
//
// Renderer-side failures used to vanish into the console, which is invisible in
// a packaged build. Anything that throws now tells the user something went
// wrong, so a broken action reads as an error rather than as the app "being
// flaky". Messages are deduplicated because a failing render loop can throw
// every frame.

let lastFaultMessage = '';
let lastFaultAt = 0;

function announceFault(prefix, message) {
  const text = `${prefix}: ${message || 'unknown error'}`;
  const now = Date.now();
  if (text === lastFaultMessage && now - lastFaultAt < 5000) return;
  lastFaultMessage = text;
  lastFaultAt = now;
  try { showFloatToast(text); } catch {}
  try { console.error('[ScreenForge]', text); } catch {}
}

function reportMainFault(detail) {
  if (!detail) return;
  announceFault(detail.fatal ? 'ScreenForge hit a fatal error' : 'ScreenForge error', detail.message);
}

function installRendererFaultHooks() {
  window.addEventListener('error', (event) => {
    announceFault('Something went wrong', event?.error?.message || event?.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    announceFault('Something went wrong', reason instanceof Error ? reason.message : String(reason ?? ''));
  });
}

function showFloatToast(msg) {
  let toast = $('floatToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'floatToast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.setAttribute('aria-atomic', 'true');
    toast.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
      padding:8px 16px;border-radius:999px;font-size:12px;font-weight:600;
      background:rgba(15,23,42,.92);color:#eef4fb;border:1px solid rgba(255,255,255,.14);
      box-shadow:0 8px 32px rgba(0,0,0,.4);z-index:9999;pointer-events:none;
      transition:opacity .3s;`;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._tid);
  toast._tid = setTimeout(() => { toast.style.opacity = '0'; }, 2200);
}

// ── Blur zones (privacy redaction) ───────────────────────────────────────────

let _selectedBlurZoneId = null;
let _blurZoneDrag = null;

function addBlurZone() {
  const vid = $('videoPreview');
  if (!vid || !S.dur) return;
  const t = vid.currentTime;
  const radius = parseInt($('blurRadiusSlider')?.value || 20);
  const zone = {
    id: Date.now(),
    startTime: t,
    endTime: Math.min(t + 5, S.dur),
    xPct: 0.35, yPct: 0.4, wPct: 0.3, hPct: 0.2,
    radius,
  };
  S.blurZones.push(zone);
  _selectedBlurZoneId = zone.id;
  renderBlurZoneList();
  syncSelectedBlurEditor();
  renderPrivacyBlurPreview(t);
  syncPreviewBackdrop(t);
  updateTimelineAria();
  drawKfLayer();
  showFloatToast('Drag the blur zone on the preview, then resize from its corner');
}

function removeBlurZone(id) {
  S.blurZones = S.blurZones.filter(z => z.id !== id);
  if (_selectedBlurZoneId === id) _selectedBlurZoneId = null;
  renderBlurZoneList();
  syncSelectedBlurEditor();
  renderPrivacyBlurPreview($('videoPreview')?.currentTime || 0);
  drawKfLayer();
}

function selectBlurZone(id) {
  const zone = S.blurZones.find(item => item.id === id);
  if (!zone) return;
  _selectedBlurZoneId = id;
  const vid = $('videoPreview');
  if (vid) vid.currentTime = Math.min(zone.endTime - 0.01, zone.startTime + 0.01);
  renderBlurZoneList();
  syncSelectedBlurEditor();
  renderPrivacyBlurPreview(vid?.currentTime || zone.startTime);
}

function syncSelectedBlurEditor() {
  const zone = S.blurZones.find(item => item.id === _selectedBlurZoneId);
  $('blurTimingControls')?.classList.toggle('hidden', !zone);
  if ($('blurSelectionHelp')) {
    $('blurSelectionHelp').textContent = zone
      ? 'Drag this zone on the preview. Use the lower-right handle to resize it.'
      : 'Select a zone, then drag it directly on the preview. Use the corner handle to resize.';
  }
  if (!zone) return;
  if ($('blurStartInput')) $('blurStartInput').value = Number(zone.startTime).toFixed(1);
  if ($('blurEndInput')) $('blurEndInput').value = Number(zone.endTime).toFixed(1);
  if ($('blurRadiusSlider')) $('blurRadiusSlider').value = String(zone.radius);
  if ($('blurRadiusVal')) $('blurRadiusVal').textContent = String(zone.radius);
}

function updateSelectedBlurTiming(key, value) {
  const zone = S.blurZones.find(item => item.id === _selectedBlurZoneId);
  if (!zone || !['startTime', 'endTime'].includes(key)) return;
  const next = clamp(Number(value) || 0, 0, S.dur || 86400);
  if (key === 'startTime') zone.startTime = Math.min(next, zone.endTime - 0.05);
  else zone.endTime = Math.max(zone.startTime + 0.05, next);
  syncSelectedBlurEditor();
  renderBlurZoneList();
  renderPrivacyBlurPreview($('videoPreview')?.currentTime || 0);
}

function updateSelectedBlurRadius(value) {
  const radius = clamp(Math.round(Number(value) || 20), 5, 40);
  if ($('blurRadiusVal')) $('blurRadiusVal').textContent = String(radius);
  const zone = S.blurZones.find(item => item.id === _selectedBlurZoneId);
  if (zone) zone.radius = radius;
  renderBlurZoneList();
  renderPrivacyBlurPreview($('videoPreview')?.currentTime || 0);
}

function renderBlurZoneList() {
  const el = $('blurZoneList');
  if (!el) return;
  if (!S.blurZones.length) {
    el.innerHTML = '<p class="text-[11px] italic py-2 text-center" style="color:rgba(255,255,255,.18)">No blur zones</p>';
    return;
  }
  el.innerHTML = S.blurZones.map(z => `
    <div class="flex items-center gap-1.5 px-2.5 py-2 rounded-lg"
         style="background:${z.id === _selectedBlurZoneId ? 'rgba(139,92,246,.11)' : 'rgba(255,255,255,.03)'};border:1px solid ${z.id === _selectedBlurZoneId ? 'rgba(167,139,250,.34)' : 'rgba(255,255,255,.05)'}">
      <div class="flex-1 min-w-0">
        <div class="text-[11px] font-mono font-bold" style="color:rgba(139,92,246,.9)">
          ${fmtTime(z.startTime)} → ${fmtTime(z.endTime)}
        </div>
        <div class="text-[10px]" style="color:rgba(255,255,255,.3)">
          ${Math.round(z.wPct*100)}×${Math.round(z.hPct*100)}% · blur ${z.radius}px
        </div>
      </div>
      <button onclick="selectBlurZone(${z.id})" title="Edit and preview blur zone" aria-label="Edit and preview blur zone"
              class="h-6 px-2 flex items-center justify-center rounded text-[10px]"
              style="color:rgba(139,92,246,.7);background:rgba(139,92,246,.1)">Edit</button>
      <button onclick="removeBlurZone(${z.id})" title="Remove blur zone" aria-label="Remove blur zone"
              class="w-6 h-6 flex items-center justify-center rounded text-[11px]"
              style="color:rgba(248,113,113,.7);background:rgba(248,113,113,.1)">×</button>
    </div>`).join('');
}

function seekToBlur(id) {
  selectBlurZone(id);
}

function renderPrivacyBlurPreview(time) {
  const layer = $('privacyBlurPreviewLayer');
  if (!layer) return;
  const zoom = zoomStateAt(time);
  const metrics = previewRenderMetrics(time);
  const active = S.blurZones.filter(zone => time >= zone.startTime && time < zone.endTime);
  layer.innerHTML = active.map(zone => {
    const left = zoom.xPct + (zone.xPct - zoom.xPct) * zoom.scale;
    const top = zoom.yPct + (zone.yPct - zoom.yPct) * zoom.scale;
    const width = zone.wPct * zoom.scale;
    const height = zone.hPct * zoom.scale;
    const sourceRadius = Math.min(
      Number(zone.radius) || 0,
      Math.min(zone.wPct * (Number(S.videoW) || 16), zone.hPct * (Number(S.videoH) || 9)) / 2,
    );
    const displayBlurRadius = Math.max(0.5, sourceRadius * metrics.sourceScale * zoom.scale);
    const selected = zone.id === _selectedBlurZoneId;
    return `<div role="group" tabindex="0" aria-label="Privacy blur zone from ${fmtTime(zone.startTime)} to ${fmtTime(zone.endTime)}. Use arrow keys to move."
      onkeydown="nudgeBlurZone(event,${zone.id},'move')" onmousedown="startBlurZoneDrag(event,${zone.id},'move')" style="
      position:absolute;left:${left * 100}%;top:${top * 100}%;width:${width * 100}%;height:${height * 100}%;
      z-index:6;pointer-events:auto;cursor:move;overflow:hidden;
      backdrop-filter:blur(${displayBlurRadius.toFixed(2)}px);-webkit-backdrop-filter:blur(${displayBlurRadius.toFixed(2)}px);
      background:rgba(139,92,246,.05);border:${selected ? '2px solid rgba(167,139,250,.95)' : '1px solid rgba(167,139,250,.45)'};
      box-shadow:${selected ? '0 0 0 1px rgba(0,0,0,.55),0 8px 24px rgba(0,0,0,.24)' : 'none'}">
      ${selected ? `<div role="slider" tabindex="0" aria-label="Resize privacy blur zone" aria-valuetext="${Math.round(zone.wPct * 100)} by ${Math.round(zone.hPct * 100)} percent"
        onkeydown="nudgeBlurZone(event,${zone.id},'resize')" onmousedown="startBlurZoneDrag(event,${zone.id},'resize')"
        style="position:absolute;right:-1px;bottom:-1px;width:16px;height:16px;cursor:nwse-resize;background:#a78bfa;border:3px solid rgba(15,10,28,.85);border-radius:5px 0 0 0"></div>` : ''}
    </div>`;
  }).join('');
}

function nudgeBlurZone(event, id, mode) {
  const zone = S.blurZones.find(item => item.id === id);
  if (!zone) return;
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    event.stopPropagation();
    removeBlurZone(id);
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    event.stopPropagation();
    selectBlurZone(id);
    return;
  }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  _selectedBlurZoneId = id;
  const step = event.shiftKey ? 0.05 : 0.01;
  const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
  const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
  if (mode === 'resize') {
    zone.wPct = clamp(zone.wPct + dx, 0.04, 1 - zone.xPct);
    zone.hPct = clamp(zone.hPct + dy, 0.04, 1 - zone.yPct);
  } else {
    zone.xPct = clamp(zone.xPct + dx, 0, 1 - zone.wPct);
    zone.yPct = clamp(zone.yPct + dy, 0, 1 - zone.hPct);
  }
  renderBlurZoneList();
  syncSelectedBlurEditor();
  renderPrivacyBlurPreview($('videoPreview')?.currentTime || 0);
  schedulePersist();
}

function startBlurZoneDrag(event, id, mode) {
  const zone = S.blurZones.find(item => item.id === id);
  const viewport = $('previewVideoViewport');
  if (!zone || !viewport) return;
  event.preventDefault();
  event.stopPropagation();
  _selectedBlurZoneId = id;
  _blurZoneDrag = {
    id,
    mode,
    x: event.clientX,
    y: event.clientY,
    zone: { ...zone },
    rect: viewport.getBoundingClientRect(),
    zoom: zoomStateAt($('videoPreview')?.currentTime || zone.startTime),
  };
  renderBlurZoneList();
  syncSelectedBlurEditor();
}

function doBlurZoneDrag(event) {
  if (!_blurZoneDrag) return;
  const zone = S.blurZones.find(item => item.id === _blurZoneDrag.id);
  if (!zone || !_blurZoneDrag.rect.width || !_blurZoneDrag.rect.height) return;
  const dx = (event.clientX - _blurZoneDrag.x) / _blurZoneDrag.rect.width / _blurZoneDrag.zoom.scale;
  const dy = (event.clientY - _blurZoneDrag.y) / _blurZoneDrag.rect.height / _blurZoneDrag.zoom.scale;
  if (_blurZoneDrag.mode === 'resize') {
    zone.wPct = clamp(_blurZoneDrag.zone.wPct + dx, 0.04, 1 - zone.xPct);
    zone.hPct = clamp(_blurZoneDrag.zone.hPct + dy, 0.04, 1 - zone.yPct);
  } else {
    zone.xPct = clamp(_blurZoneDrag.zone.xPct + dx, 0, 1 - zone.wPct);
    zone.yPct = clamp(_blurZoneDrag.zone.yPct + dy, 0, 1 - zone.hPct);
  }
  renderPrivacyBlurPreview($('videoPreview')?.currentTime || 0);
}

function endBlurZoneDrag() {
  if (!_blurZoneDrag) return;
  _blurZoneDrag = null;
  renderBlurZoneList();
  syncSelectedBlurEditor();
  schedulePersist();
}

function backToRecorder() {
  $('videoPreview').pause();
  $('videoPreview').src = '';
  if ($('previewBackdropVideo')) {
    $('previewBackdropVideo').pause();
    $('previewBackdropVideo').src = '';
  }
  showScreen('recorder');
  $('recordBtn').textContent = 'Start Recording';
  syncCaptureNav();
}

function showScreen(which) {
  const isEd = which === 'editor';
  $('screenRecorder').classList.toggle('hidden',  isEd);
  $('screenRecorder').classList.toggle('flex',   !isEd);
  $('screenEditor').classList.toggle('hidden',   !isEd);
  $('screenEditor').classList.toggle('flex',      isEd);
  if (isEd) stopBgAnim();
  else if (!S.isRec) startBgAnim();
  if (isEd) {
    initInspBgGrid();          // populate gradient thumbnail grid
    switchInspPanel('bg');     // default to Background panel
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PLAYBACK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function timelineContext() {
  return {
    trimIn: Number(S.trimIn || 0),
    trimOut: Number(S.trimOut || S.dur || 0),
    removedRanges: S.removedRanges || [],
  };
}

function mapExportTime(sourceTime) {
  if (CreatorEngine.isTimeRemoved(sourceTime, S.removedRanges || [])) return null;
  if (sourceTime < S.trimIn || sourceTime > S.trimOut) return null;
  return CreatorEngine.sourceToOutputTime(sourceTime, timelineContext());
}

function mapExportInterval(start, end) {
  return CreatorEngine.mapInterval(start, end, timelineContext());
}

function mapExportSegments(start, end) {
  return CreatorEngine.splitVisibleInterval(start, end, timelineContext());
}

function syncRemovedRanges({ redraw = true } = {}) {
  S.removedRanges = CreatorEngine.normalizeRanges(S.removedRanges || [], {
    start: Number(S.trimIn || 0),
    end: Number(S.trimOut || S.dur || 0),
    minDuration: 0.04,
  });
  const droppedZooms = enforceZoomSegmentBudget();
  if (droppedZooms > 0) {
    showFloatToast(`${droppedZooms} camera shot${droppedZooms === 1 ? '' : 's'} inactive - over the 80-segment export limit`);
  }
  renderRemovalSummary();
  if (redraw) {
    drawKfLayer();
    renderCutList();
    renderSilenceList();
  }
}

// ─── Zoom segment budget ─────────────────────────────────────────────────────
//
// Export can carry a bounded number of camera segments (MAX_ZOOM_SHOTS), proven
// safe at exactly 80 by the real-ffmpeg spawn in
// test/renderer-export-contract.test.js.
//
// This used to DELETE over-budget zoom keyframes from S.keyframes. That was the
// single worst source of "the app is flaky": a zoom's cost is the number of
// export segments it spans, which depends on cuts and removed ranges, so
// trimming something unrelated could retroactively destroy zooms the user had
// already placed - silently, on one of the call sites. Same project, different
// result, work gone with no undo.
//
// Now nothing is ever deleted. Over-budget zooms are marked and simply do not
// render or export, and they come back on their own the moment the user frees up
// budget by removing a cut or an earlier zoom.

function computeZoomBudget() {
  const zooms = S.keyframes
    .filter(keyframe => keyframe.type === 'zoom')
    .sort((left, right) => left.time - right.time || left.id - right.id);
  const activeIds = new Set();
  const overBudgetIds = new Set();
  let segmentsUsed = 0;
  for (const zoom of zooms) {
    const duration = Math.max(0.05, Number(zoom.duration) || 1.55);
    const segmentCost = mapExportSegments(zoom.time, zoom.time + duration).length;
    if (segmentsUsed + segmentCost > MAX_ZOOM_SHOTS) {
      overBudgetIds.add(zoom.id);
      continue;
    }
    segmentsUsed += segmentCost;
    activeIds.add(zoom.id);
  }
  return { activeIds, overBudgetIds, segmentsUsed, total: zooms.length };
}

// CANON: the single source of truth for which zooms render and export.
// No render path may re-filter zooms itself.
function activeZoomKeyframes() {
  const { activeIds } = computeZoomBudget();
  return S.keyframes.filter(keyframe => keyframe.type === 'zoom' && activeIds.has(keyframe.id));
}

// Marks over-budget zooms in place and returns how many are currently inactive.
// Name retained because test/renderer-export-contract.test.js references it
// inside a vm.runInContext string.
function enforceZoomSegmentBudget() {
  const { overBudgetIds } = computeZoomBudget();
  for (const keyframe of S.keyframes) {
    if (keyframe.type !== 'zoom') continue;
    if (overBudgetIds.has(keyframe.id)) keyframe.overBudget = true;
    else delete keyframe.overBudget;
  }
  return overBudgetIds.size;
}

function removeTimelineRange(start, end, source = 'manual') {
  S.removedRanges = [
    ...(S.removedRanges || []),
    { start: Number(start), end: Number(end), source },
  ];
  syncRemovedRanges();
}

function restoreTimelineRange(start, end) {
  S.removedRanges = CreatorEngine.subtractRange(
    S.removedRanges || [],
    { start: Number(start), end: Number(end) },
    { start: Number(S.trimIn || 0), end: Number(S.trimOut || S.dur || 0) },
  );
  syncRemovedRanges();
}

function rangeIsRemoved(start, end) {
  const midpoint = Number(start) + (Number(end) - Number(start)) / 2;
  return CreatorEngine.isTimeRemoved(midpoint, S.removedRanges || []);
}

function removalAtTime(time) {
  return (S.removedRanges || []).find(range => time >= range.start && time < range.end) || null;
}

function renderRemovalSummary() {
  const summary = $('removalSummary');
  if (!summary) return;
  const removed = CreatorEngine.removedDuration(S.removedRanges || [], {
    start: Number(S.trimIn || 0),
    end: Number(S.trimOut || S.dur || 0),
  });
  const count = (S.removedRanges || []).length;
  summary.textContent = count
    ? `${fmtTime(removed)} removed across ${count} range${count === 1 ? '' : 's'}`
    : 'Nothing removed';
}

function onVideoLoaded() {
  const vid = $('videoPreview');
  if (!S.videoW) S.videoW = vid.videoWidth || 0;
  if (!S.videoH) S.videoH = vid.videoHeight || 0;
  if (!S.dur) S.dur = vid.duration || 0;
  S.trimIn  = 0;
  S.trimOut = S.dur;
  $('totalTime').textContent = fmtTime(S.dur);
  syncPreviewStageGeometry();
  updateTrimDisplay(); updateTrimHandles(); drawRuler(); drawKfLayer();
}

function syncPreviewStageGeometry() {
  const area = $('previewArea');
  const stage = $('previewStage');
  if (!area || !stage) return;
  const width = area.clientWidth;
  const height = area.clientHeight;
  const presentation = currentPreviewPresentation();
  const outputWidth = Number(presentation?.width || S.videoW || 16);
  const outputHeight = Number(presentation?.height || S.videoH || 9);
  if (width < 1 || height < 1 || outputWidth < 1 || outputHeight < 1) return;
  const scale = Math.min(width / outputWidth, height / outputHeight);
  stage.style.width = `${Math.max(1, Math.floor(outputWidth * scale))}px`;
  stage.style.height = `${Math.max(1, Math.floor(outputHeight * scale))}px`;
  updatePresentationPreview();
}

function currentPreviewResolution() {
  const value = $('exportRes')?.value || 'source';
  return value === 'source' ? 'source' : value;
}

function currentPreviewPresentation() {
  return buildPresentationOptions(currentPreviewResolution(), !!S.cfg.pad);
}

function onExportResolutionChange() {
  syncPreviewStageGeometry();
  const time = $('videoPreview')?.currentTime || 0;
  renderTextOverlays(time);
  renderCursorPreview(time);
}

function buildPresentationOptions(resVal = 'source', styled = true) {
  let width = Number(S.videoW) || 0;
  let height = Number(S.videoH) || 0;
  if (resVal !== 'source') {
    const values = String(resVal).split(':').map(Number);
    if (values.length === 2 && values.every(value => Number.isFinite(value) && value >= 16)) {
      [width, height] = values;
    }
  }
  if (width < 16 || height < 16) return null;
  const preset = BG_PRESETS[S.bgPreset] || BG_PRESETS[0];
  return PresentationEngine.normalizePresentation({
    width,
    height,
    sourceWidth: Number(S.videoW) || width,
    sourceHeight: Number(S.videoH) || height,
    styled: !!styled,
    mode: S.cfg.bgMode || 'gradient',
    colors: preset.swatch,
    solidColor: S.cfg.bgSolidColor || '#1a1a2e',
    padding: Number(S.cfg.bgPadding ?? 0.05),
    blur: Number(S.cfg.bgBlur ?? 0.4),
    frame: !!S.cfg.frame,
  });
}

function updatePresentationPreview() {
  const stage = $('previewStage');
  const video = $('videoPreview');
  const viewport = $('previewVideoViewport');
  const blurLayer = $('privacyBlurPreviewLayer');
  if (!stage || !video || !viewport || !stage.clientWidth || !stage.clientHeight) return;
  const presentation = currentPreviewPresentation();
  if (!presentation) return;
  const geometry = PresentationEngine.presentationGeometry(presentation, S.videoW || 16, S.videoH || 9);
  const sx = stage.clientWidth / geometry.width;
  const sy = stage.clientHeight / geometry.height;
  const px = (value) => `${Math.round(value * sx * 100) / 100}px`;
  const py = (value) => `${Math.round(value * sy * 100) / 100}px`;
  const cornerRadius = `${Math.round(geometry.cornerRadius * Math.min(sx, sy) * 100) / 100}px`;
  const preset = BG_PRESETS[S.bgPreset] || BG_PRESETS[0];
  const backdrop = $('previewBackdropVideo');
  const wash = $('previewBackdropWash');
  const surface = $('previewFrameSurface');
  const bar = $('previewFrameBar');

  if (presentation.styled) {
    stage.style.background = presentation.mode === 'solid'
      ? presentation.solidColor
      : `linear-gradient(135deg,${preset.swatch[0]},${preset.swatch[1]})`;
    if (backdrop) {
      const useBlur = presentation.blur > 0.001;
      backdrop.style.display = useBlur ? 'block' : 'none';
      const displayScale = Math.min(sx, sy);
      backdrop.style.filter = `${colorAdjustmentCssFilter()} blur(${((4 + presentation.blur * 32) * displayScale).toFixed(2)}px)`;
    }
    if (wash) {
      wash.style.display = 'block';
      wash.style.background = presentation.mode === 'solid'
        ? presentation.solidColor
        : `linear-gradient(135deg,${preset.swatch[0]},${preset.swatch[1]})`;
      wash.style.opacity = presentation.blur > 0.001 ? '.68' : '1';
    }
    if (surface) {
      surface.style.display = 'block';
      surface.style.left = px(geometry.boxX);
      surface.style.top = py(geometry.boxY + geometry.frameHeight);
      surface.style.width = px(geometry.innerWidth);
      surface.style.height = py(geometry.contentHeight);
      surface.style.borderRadius = presentation.frame
        ? `0 0 ${cornerRadius} ${cornerRadius}`
        : cornerRadius;
    }
    if (bar) {
      bar.style.display = presentation.frame ? 'block' : 'none';
      bar.style.left = px(geometry.boxX);
      bar.style.top = py(geometry.boxY);
      bar.style.width = px(geometry.innerWidth);
      bar.style.height = py(geometry.frameHeight);
      bar.style.borderRadius = `${cornerRadius} ${cornerRadius} 0 0`;
      const dotSize = Math.max(5, Math.round(geometry.frameHeight * 0.28));
      const dotGap = Math.max(4, Math.round(dotSize * 0.65));
      const dotX = Math.max(8, Math.round(geometry.frameHeight * 0.55));
      bar.querySelectorAll('[data-frame-dot]').forEach((dot, index) => {
        dot.style.left = px(dotX + index * (dotSize + dotGap));
        dot.style.width = px(dotSize);
        dot.style.height = py(dotSize);
      });
    }
  } else {
    stage.style.background = '#000';
    if (backdrop) backdrop.style.display = 'none';
    if (wash) wash.style.display = 'none';
    if (surface) surface.style.display = 'none';
    if (bar) bar.style.display = 'none';
  }

  viewport.style.left = px(geometry.videoX);
  viewport.style.top = py(geometry.videoY);
  viewport.style.width = px(geometry.videoWidth);
  viewport.style.height = py(geometry.videoHeight);
  viewport.style.borderRadius = presentation.styled
    ? (presentation.frame ? `0 0 ${cornerRadius} ${cornerRadius}` : cornerRadius)
    : '0';
  viewport.style.boxShadow = presentation.styled
    ? 'inset 0 0 0 1px rgba(255,255,255,.10)'
    : 'none';
  video.style.left = '0';
  video.style.top = '0';
  video.style.width = '100%';
  video.style.height = '100%';
  if (blurLayer) {
    blurLayer.style.inset = '0';
    blurLayer.style.width = 'auto';
    blurLayer.style.height = 'auto';
  }
  const previewTime = $('videoPreview')?.currentTime || 0;
  syncPreviewBackdropGeometry(previewTime);
  syncPreviewBackdrop(previewTime);
}

function syncPreviewBackdrop(time) {
  const video = $('videoPreview');
  const backdrop = $('previewBackdropVideo');
  if (!video || !backdrop) return;
  if (backdrop.style.display === 'none' || !backdrop.src) {
    if (!backdrop.paused) backdrop.pause();
    return;
  }
  if (Math.abs((backdrop.currentTime || 0) - time) > 0.12 && Number.isFinite(time)) {
    try { backdrop.currentTime = time; } catch {}
  }
  backdrop.playbackRate = video.playbackRate;
  if (!video.paused && backdrop.paused) backdrop.play().catch(() => {});
  if (video.paused && !backdrop.paused) backdrop.pause();
}

function syncPreviewBackdropGeometry(time) {
  const stage = $('previewStage');
  const backdrop = $('previewBackdropVideo');
  const sourceWidth = Number(S.videoW) || 0;
  const sourceHeight = Number(S.videoH) || 0;
  if (!stage || !backdrop || sourceWidth < 1 || sourceHeight < 1 || stage.clientWidth < 1 || stage.clientHeight < 1) return;
  const geometry = PresentationEngine.backgroundCameraGeometry(
    sourceWidth,
    sourceHeight,
    stage.clientWidth,
    stage.clientHeight,
    zoomStateAt(time),
  );
  backdrop.style.inset = 'auto';
  backdrop.style.left = `${geometry.left.toFixed(3)}px`;
  backdrop.style.top = `${geometry.top.toFixed(3)}px`;
  backdrop.style.width = `${geometry.width.toFixed(3)}px`;
  backdrop.style.height = `${geometry.height.toFixed(3)}px`;
  backdrop.style.objectFit = 'fill';
  backdrop.style.transformOrigin = '50% 50%';
  backdrop.style.transform = 'none';
}

function togglePlay() {
  const vid = $('videoPreview'), btn = $('playBtn');
  if (vid.paused) {
    if (vid.currentTime >= S.trimOut) vid.currentTime = S.trimIn;
    const removed = removalAtTime(vid.currentTime);
    if (removed) vid.currentTime = removed.end;
    vid.play(); btn.textContent = '⏸';
  } else { vid.pause(); btn.textContent = '▶'; }
}

function seekRelative(dt) {
  const vid = $('videoPreview');
  let target = clamp(vid.currentTime + dt, S.trimIn, S.trimOut);
  const removed = removalAtTime(target);
  if (removed) target = dt >= 0 ? removed.end : removed.start;
  vid.currentTime = target;
}

function scrubClick(e) {
  const rect = $('scrubBar').getBoundingClientRect();
  const pct  = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  const t    = S.trimIn + pct * (S.trimOut - S.trimIn);
  $('videoPreview').currentTime = t;
  renderTextOverlays(t);
}

function setSpeed() {
  const video = $('videoPreview');
  video.playbackRate = parseFloat($('speedSelect').value);
  syncPreviewBackdrop(video.currentTime);
}

function toggleMute() {
  const vid = $('videoPreview');
  vid.muted = !vid.muted;
  const btn = $('muteBtn');
  btn.setAttribute('aria-pressed', String(vid.muted));
  btn.setAttribute('aria-label', vid.muted ? 'Unmute preview' : 'Mute preview');
  btn.innerHTML = vid.muted
    ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="m16 9 5 5M21 9l-5 5"/></svg>'
    : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a9 9 0 0 1 0 12"/></svg>';
}

function onTimeUpdate() {
  const vid = $('videoPreview'), t = vid.currentTime;
  const removed = removalAtTime(t);
  if (!vid.paused && removed && removed.end < S.trimOut) {
    vid.currentTime = removed.end;
    return;
  }
  if (t >= S.trimOut) { vid.pause(); vid.currentTime = S.trimOut; $('playBtn').textContent = '▶'; }
  const span = S.trimOut - S.trimIn;
  const pct  = span > 0 ? clamp((t - S.trimIn) / span * 100, 0, 100) : 0;
  $('currentTime').textContent = fmtTime(t);
  if ($('scrubFill'))  $('scrubFill').style.width   = pct + '%';
  if ($('scrubThumb')) $('scrubThumb').style.left   = pct + '%';
  if (S.dur > 0) {
    const tp = (t / S.dur) * 100 + '%';
    $('playhead').style.left = tp;
    const kfph = $('kfPlayhead');
    if (kfph) kfph.style.left = tp;
    // Ruler handle + ruler needle
    const ph  = $('playheadHandle');
    if (ph)  ph.style.left  = tp;
    const rph = $('rulerPlayhead');
    if (rph) rph.style.left = tp;
    // Sync secondary play button icon
    const pbt = $('playBtnTimeline');
    if (pbt) pbt.textContent = $('videoPreview').paused ? '▶' : '⏸';
  }
  renderZoomPreview(t);
  renderTextOverlays(t);
  renderCursorPreview(t);
  renderPrivacyBlurPreview(t);
  syncPreviewBackdrop(t);
  updateTimelineAria();
  // Mini-timeline playhead
  const mtp = $('mtPlayhead');
  if (mtp && S.dur > 0) mtp.style.left = (t / S.dur * 100) + '%';
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TRIM
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startTrim(side, e) {
  e.preventDefault(); e.stopPropagation();
  S.isDragTrim = side; S.dragX0 = e.clientX;
  S.dragV0 = side === 'left' ? S.trimIn : S.trimOut;
}

function doTrimDrag(e) {
  if (!S.isDragTrim || !S.dur) return;
  const W  = $('mainTrack').getBoundingClientRect().width;
  const dt = ((e.clientX - S.dragX0) / W) * S.dur;
  if (S.isDragTrim === 'left')  S.trimIn  = clamp(S.dragV0 + dt, 0, S.trimOut - 0.25);
  else                          S.trimOut = clamp(S.dragV0 + dt, S.trimIn + 0.25, S.dur);
  updateTrimHandles(); updateTrimDisplay();
}

function commitTrimCameraBudget() {
  const droppedZooms = enforceZoomSegmentBudget();
  if (droppedZooms <= 0) return 0;
  drawKfLayer();
  renderKfLists();
  showFloatToast(`${droppedZooms} camera shot${droppedZooms === 1 ? '' : 's'} inactive - over the ${MAX_ZOOM_SHOTS}-segment export limit`);
  return droppedZooms;
}

function endTrimDrag() {
  if (!S.isDragTrim) return;
  S.isDragTrim = null;
  commitTrimCameraBudget();
}

function updateTrimHandles() {
  if (!S.dur) return;
  const inPct  = (S.trimIn  / S.dur * 100);
  const outPct = (S.trimOut / S.dur * 100);
  $('trimLeft').style.left  = inPct  + '%';
  $('trimRight').style.left = outPct + '%';
  // Shade excluded zones
  const sl = $('trimShadeLeft'), sr = $('trimShadeRight');
  if (sl) sl.style.width = inPct + '%';
  if (sr) { sr.style.width = (100 - outPct) + '%'; }
  // Clip region fill
  const cf = $('clipFill');
  if (cf) { cf.style.left = inPct + '%'; cf.style.width = (outPct - inPct) + '%'; }
}

function updateTrimDisplay() {
  const inT  = fmtTime(S.trimIn);
  const outT = fmtTime(S.trimOut);
  const durT = fmtTime(S.trimOut - S.trimIn);
  $('trimInDisplay').textContent       = inT;
  $('trimOutDisplay').textContent      = outT;
  $('clipDurationDisplay').textContent = durT;
  const ci = $('clipInLabel'),  co = $('clipOutLabel');
  if (ci) ci.textContent = inT;
  if (co) co.textContent = outT;
  // Clip panel big displays
  const cib = $('clipInBig'),  cob = $('clipOutBig'), cdb = $('clipDurBig');
  if (cib) cib.textContent = inT;
  if (cob) cob.textContent = outT;
  if (cdb) cdb.textContent = durT;
  updateMiniTimeline();
  updateTimelineAria();
  renderRemovalSummary();
}

// ── Clip editing actions ──────────────────────────────────────────────────────

function setInPoint() {
  const vid = $('videoPreview');
  if (!vid || !S.dur) return;
  S.trimIn = clamp(vid.currentTime, 0, S.trimOut - 0.25);
  updateTrimHandles(); updateTrimDisplay();
  commitTrimCameraBudget();
}

function setOutPoint() {
  const vid = $('videoPreview');
  if (!vid || !S.dur) return;
  S.trimOut = clamp(vid.currentTime, S.trimIn + 0.25, S.dur);
  updateTrimHandles(); updateTrimDisplay();
  commitTrimCameraBudget();
}

function cutAtPlayhead() {
  const vid = $('videoPreview');
  if (!vid || !S.dur) return;
  cutAtTime(vid.currentTime);
}

function resetTrimToFull() {
  S.trimIn = 0;
  S.trimOut = S.dur;
  updateTrimHandles(); updateTrimDisplay();
  commitTrimCameraBudget();
}

function frameStep(dir) {
  const vid = $('videoPreview');
  if (!vid) return;
  vid.currentTime = clamp(vid.currentTime + dir / Math.max(1, Number(S.videoFps) || 30), S.trimIn, S.trimOut);
  renderTextOverlays(vid.currentTime);
}

function setSpeedAndSync(val, btn) {
  $('speedSelect').value = val;
  setSpeed();
  btn.closest('.flex').querySelectorAll('button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

// ── Mini-timeline drag ────────────────────────────────────────────────────────

let _miniSide = null, _miniX0 = 0, _miniV0 = 0;

function startMiniTrim(side, e) {
  e.preventDefault(); e.stopPropagation();
  _miniSide = side;
  _miniX0   = e.clientX;
  _miniV0   = side === 'in' ? S.trimIn : S.trimOut;
}

function doMiniTrimDrag(e) {
  if (!_miniSide || !S.dur) return;
  const mt = $('miniTimeline');
  if (!mt) return;
  const W  = mt.getBoundingClientRect().width;
  const dt = (e.clientX - _miniX0) / W * S.dur;
  if (_miniSide === 'in')  S.trimIn  = clamp(_miniV0 + dt, 0, S.trimOut - 0.25);
  else                     S.trimOut = clamp(_miniV0 + dt, S.trimIn + 0.25, S.dur);
  updateTrimHandles(); updateTrimDisplay();
}

function endMiniTrimDrag() {
  if (!_miniSide) return;
  _miniSide = null;
  commitTrimCameraBudget();
}

function miniTimelineSeek(e) {
  if (!S.dur) return;
  const mt = $('miniTimeline');
  if (!mt) return;
  // Don't seek if we just finished a handle drag
  if (_miniSide) return;
  const rect = mt.getBoundingClientRect();
  const t = clamp((e.clientX - rect.left) / rect.width, 0, 1) * S.dur;
  $('videoPreview').currentTime = t;
  renderTextOverlays(t);
}

function updateMiniTimeline() {
  if (!S.dur) return;
  const inPct  = S.trimIn  / S.dur;
  const outPct = S.trimOut / S.dur;
  const hi = $('mtHandleIn'), ho = $('mtHandleOut');
  const cf = $('mtClipFill');
  const sl = $('mtShadeL'),   sr = $('mtShadeR');
  const el = $('mtEndLabel');
  if (hi) hi.style.left = (inPct  * 100) + '%';
  if (ho) ho.style.left = (outPct * 100) + '%';
  if (cf) { cf.style.left = (inPct * 100) + '%'; cf.style.width = ((outPct - inPct) * 100) + '%'; }
  if (sl) sl.style.width = (inPct * 100) + '%';
  if (sr) sr.style.width = ((1 - outPct) * 100) + '%';
  if (el) el.textContent = fmtTime(S.dur);
}

function trackClick(e) {
  if (e.target.classList.contains('trim-handle') ||
      e.target.classList.contains('keyframe-dot')) return;
  const rect = ($('mainTrack') || $('kfTrack')).getBoundingClientRect();
  const rawT = clamp((e.clientX - rect.left) / rect.width * S.dur, 0, S.dur);
  if (S.razorMode) {
    cutAtTime(rawT);
    return;
  }
  const t = clamp(rawT, S.trimIn, S.trimOut);
  $('videoPreview').currentTime = t;
  renderTextOverlays(t);
}

function trackHover(_e) {}

// ── Razor / cut tool ─────────────────────────────────────────────────────────

function toggleRazorMode() {
  S.razorMode = !S.razorMode;
  document.body.style.cursor = S.razorMode ? 'crosshair' : '';
  // Toolbar razor button
  const btn = $('btn-razor');
  if (btn) {
    btn.classList.toggle('is-active', S.razorMode);
    btn.setAttribute('aria-pressed', String(S.razorMode));
    btn.style.color       = S.razorMode ? '#f87171'              : 'rgba(255,255,255,.4)';
    btn.style.background  = S.razorMode ? 'rgba(248,113,113,.12)': 'rgba(255,255,255,.04)';
    btn.style.borderColor = S.razorMode ? 'rgba(248,113,113,.3)' : 'rgba(255,255,255,.07)';
  }
  // Panel razor status badge
  const ps = $('razorPanelStatus');
  if (ps) {
    ps.textContent   = S.razorMode ? 'ON'  : 'OFF';
    ps.style.background  = S.razorMode ? 'rgba(248,113,113,.15)' : 'rgba(255,255,255,.06)';
    ps.style.color       = S.razorMode ? 'rgba(248,113,113,.9)'  : 'rgba(255,255,255,.2)';
  }
  const panelButton = $('btn-razor-panel');
  if (panelButton) {
    panelButton.classList.toggle('is-active', S.razorMode);
    panelButton.setAttribute('aria-pressed', String(S.razorMode));
  }
  const rp = $('btn-razor-panel');
  if (rp) {
    rp.style.borderColor = S.razorMode ? 'rgba(248,113,113,.3)' : 'rgba(255,255,255,.08)';
    rp.style.color       = S.razorMode ? 'rgba(248,113,113,.85)': 'rgba(255,255,255,.38)';
  }
}

function cutAtTime(t) {
  const minGap = 0.25;
  if (t <= S.trimIn + minGap || t >= S.trimOut - minGap) return;
  if (S.cuts.some(c => Math.abs(c - t) < minGap)) return;
  S.cuts.push(t);
  S.cuts.sort((a, b) => a - b);
  drawKfLayer();
  renderCutList();
  updateDirectorSummary();
}

function removeCut(t) {
  S.cuts = S.cuts.filter(c => Math.abs(c - t) > 0.01);
  drawKfLayer();
  renderCutList();
}

function activeCutSegments() {
  const cuts = S.cuts.filter(c => c > S.trimIn && c < S.trimOut).sort((a, b) => a - b);
  const boundaries = [S.trimIn, ...cuts, S.trimOut];
  return boundaries.slice(0, -1).map((start, index) => ({
    start,
    end: boundaries[index + 1],
  }));
}

function toggleCutSegment(index) {
  const segment = activeCutSegments()[index];
  if (!segment) return;
  if (rangeIsRemoved(segment.start, segment.end)) {
    restoreTimelineRange(segment.start, segment.end);
    showFloatToast('Segment restored');
  } else {
    const remaining = CreatorEngine.outputDuration({
      ...timelineContext(),
      speedMultiplier: 1,
      removedRanges: [...S.removedRanges, { ...segment, source: 'manual' }],
    });
    if (remaining < 0.25) {
      showFloatToast('Keep at least one segment in the timeline');
      return;
    }
    removeTimelineRange(segment.start, segment.end, 'manual');
    showFloatToast('Segment removed non-destructively');
  }
}

function renderCutList() {
  const el = $('cutList'), cnt = $('cutCount');
  const activeCuts = S.cuts.filter(c => c > S.trimIn && c < S.trimOut);
  if (cnt) cnt.textContent = activeCuts.length;
  if (!el) return;
  if (!activeCuts.length) {
    el.innerHTML = '<p class="text-[11px] italic py-3 text-center" style="color:rgba(255,255,255,.18)">No cuts yet</p>';
    return;
  }
  const segments = activeCutSegments();
  el.innerHTML = segments.map((segment, i) => {
    const removed = rangeIsRemoved(segment.start, segment.end);
    const segLen = fmtTime(segment.end - segment.start);
    return `
    <div class="flex items-center gap-1.5 px-2.5 py-2 rounded-lg group nd"
         style="background:${removed ? 'rgba(248,113,113,.07)' : 'rgba(255,255,255,.03)'};border:1px solid ${removed ? 'rgba(248,113,113,.16)' : 'rgba(255,255,255,.05)'}">
      <button onclick="$('videoPreview').currentTime=${segment.start};renderTextOverlays(${segment.start})"
              class="flex items-center gap-1.5 flex-1 text-left" title="Jump to segment">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(248,113,113,.55)" stroke-width="2" stroke-linecap="round" style="flex-shrink:0"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/></svg>
        <span class="text-[12px] font-mono font-bold" style="color:rgba(255,255,255,.75)">S${i + 1}</span>
        <span class="text-[10px] font-mono" style="color:rgba(255,255,255,.2)">${fmtTime(segment.start)} · ${segLen}</span>
      </button>
      <button onclick="toggleCutSegment(${i})"
              class="px-2 h-6 flex items-center justify-center rounded text-[9px] font-semibold"
              style="color:${removed ? '#6ee7b7' : 'rgba(248,113,113,.8)'};background:${removed ? 'rgba(16,185,129,.1)' : 'rgba(248,113,113,.1)'}"
              title="${removed ? 'Restore' : 'Remove'} segment">${removed ? 'Restore' : 'Remove'}</button>
    </div>`;
  }).join('');
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TIME RULER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function drawRuler() {
  const rc = $('timeRuler');
  if (!rc) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = rc.offsetWidth  || 600;
  const H   = rc.offsetHeight || 28;
  rc.width  = W * dpr;
  rc.height = H * dpr;
  rc.style.width  = W + 'px';
  rc.style.height = H + 'px';
  const ctx = rc.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const dur = S.dur || 60;
  const steps = [0.25, 0.5, 1, 2, 5, 10, 30, 60];
  const step  = steps.find(s => (s / dur) * W >= 40) || 60;

  ctx.font = '9px -apple-system,Inter,monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  for (let t = 0; t <= dur + step * 0.01; t += step) {
    const x     = (t / dur) * W;
    const major = Math.round(t / step) % 2 === 0;
    ctx.strokeStyle = major ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.09)';
    ctx.lineWidth = major ? 1 : 0.5;
    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(x, major ? H * 0.42 : H * 0.68);
    ctx.stroke();
    if (major && t > 0 && x > 6 && x < W - 6) {
      ctx.fillStyle = 'rgba(255,255,255,.38)';
      // Screen Studio style: "1s", "2s", "5s", with integer seconds when step ≥ 1
      const lbl = (step >= 1 && Number.isInteger(t)) ? `${t}s` : fmtTime(t);
      ctx.fillText(lbl, x, H * 0.22);
    }
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  KEYFRAMES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _directorUndo = null;

function setDirectorProfile(profile) {
  if (!CreatorEngine.DIRECTOR_PROFILES[profile]) return;
  S.cfg.directorProfile = profile;
  schedulePersist();
}

function generateActionDirector() {
  if (S.selected && !S.selected.isScreen && !S.sourceBounds) {
    showFloatToast('Use Display or Area capture for interaction-aware directing');
    return;
  }
  const clicks = S.recEvents?.clicks || [];
  if (!clicks.length) {
    showFloatToast('Action Director needs recorded click data');
    return;
  }

  const profile = $('directorProfile')?.value || S.cfg.directorProfile || 'tutorial';
  S.cfg.directorProfile = profile;
  _directorUndo = structuredClone(S.keyframes);

  const keep = S.keyframes.filter(k =>
    k.type !== 'zoom' || (k.source !== 'auto-click' && k.source !== 'action-director')
  );
  const availableShots = Math.max(0, MAX_ZOOM_SHOTS - keep.filter(k => k.type === 'zoom').length);
  const generatedShots = CreatorEngine.generateDirectorKeyframes({
    events: S.recEvents,
    profile,
    trimIn: S.trimIn,
    trimOut: S.trimOut || S.dur,
    zoomLevel: S.cfg.zoomLevel,
    webcamPos: S.cfg.webcam ? S.cfg.webcamPos : null,
    captions: !!S.cfg.captions,
  });
  const directed = generatedShots.slice(0, availableShots);

  S.keyframes = [...keep, ...directed].sort((a, b) => a.time - b.time);
  const overBudget = enforceZoomSegmentBudget();
  if (overBudget > 0) {
    // Previously this call site swallowed the result, so director-generated
    // shots vanished with no explanation. Nothing is deleted now, but the user
    // still needs to know some shots are inactive.
    showFloatToast(`${overBudget} camera shot${overBudget === 1 ? '' : 's'} inactive - over the ${MAX_ZOOM_SHOTS}-segment export limit`);
  }
  const keptDirected = S.keyframes.filter(k => k.type === 'zoom' && k.source === 'action-director');
  drawKfLayer();
  renderKfLists();
  const undo = $('directorUndoBtn');
  if (undo) undo.classList.remove('hidden');
  updateDirectorSummary();
  showFloatToast(generatedShots.length > keptDirected.length
    ? `Action Director kept ${keptDirected.length} shots within the ${MAX_ZOOM_SHOTS}-segment camera limit`
    : `Action Director created ${keptDirected.length} stable shot${keptDirected.length === 1 ? '' : 's'}`);
  schedulePersist();
}

function undoActionDirector() {
  if (!_directorUndo) return;
  S.keyframes = _directorUndo;
  _directorUndo = null;
  drawKfLayer();
  renderKfLists();
  const undo = $('directorUndoBtn');
  if (undo) undo.classList.add('hidden');
  updateDirectorSummary();
  showFloatToast('Action Director changes undone');
}

function updateDirectorSummary() {
  const summary = $('directorSummary');
  if (!summary) return;
  const directed = S.keyframes.filter(k => k.type === 'zoom' && k.source === 'action-director');
  const clicks = S.recEvents?.clicks?.length || 0;
  if (S.selected && !S.selected.isScreen && !S.sourceBounds) {
    summary.textContent = 'Display or Area capture enables interaction-aware directing';
  } else if (directed.length) {
    summary.textContent = `${directed.length} shots from ${clicks} interactions`;
  } else if (clicks) {
    summary.textContent = `${clicks} interactions ready to direct`;
  } else {
    summary.textContent = 'Ready for interaction data';
  }
}

function addZoomKeyframe() {
  if (S.keyframes.filter(keyframe => keyframe.type === 'zoom').length >= MAX_ZOOM_SHOTS) {
    showFloatToast(`This project already has the ${MAX_ZOOM_SHOTS}-shot camera limit`);
    return;
  }
  const lastCursor = S.recEvents.cursor.reduce((best, p) => {
    const dt = Math.abs(p.time - $('videoPreview').currentTime);
    return !best || dt < best.dt ? { ...p, dt } : best;
  }, null);
  S.keyframes.push({
    id: Date.now(),
    type: 'zoom',
    time: $('videoPreview').currentTime,
    duration: 1.55,
    zoomLevel: S.cfg.zoomLevel,
    xPct: lastCursor?.xPct || 0.5,
    yPct: lastCursor?.yPct || 0.5,
    source: 'manual',
  });
  S.keyframes.sort((a, b) => a.time - b.time);
  if (enforceZoomSegmentBudget() > 0) {
    showFloatToast(`Camera shots are limited to ${MAX_ZOOM_SHOTS} visible segments per project`);
  }
  drawKfLayer(); renderKfLists();
}

function addTextKeyframe() {
  const t = $('videoPreview').currentTime || 0;
  if ($('textContent'))   $('textContent').value = '';
  if ($('textStartTime')) $('textStartTime').value = t.toFixed(1);
  if ($('textFadeIn'))  { $('textFadeIn').value  = 0.3; $('textFiVal').textContent  = '0.3s'; }
  if ($('textFadeOut')) { $('textFadeOut').value = 0.3; $('textFoVal').textContent = '0.3s'; }
  renderPresetGrid();
  selectPreset('lower-third');
  openAccessibleDialog('textModal', 'textContent');
}

function closeTextModal() {
  $('textPreviewEl')?.getAnimations?.().forEach(animation => animation.cancel());
  closeAccessibleDialog('textModal');
}

function renderPresetGrid() {
  const grid = $('presetGrid');
  if (!grid) return;
  grid.innerHTML = PRESETS.map(p => `
    <button type="button" id="pcard-${p.id}" onclick="selectPreset('${p.id}')"
      aria-label="${escapeHtml(p.label)} text style" aria-pressed="false"
      class="preset-card rounded-lg overflow-hidden border border-border cursor-pointer transition-all"
      style="background:#080c14;position:relative;aspect-ratio:16/9;">
      ${p.card}
      <div style="position:absolute;bottom:0;left:0;right:0;
           background:linear-gradient(transparent,rgba(0,0,0,.7));
           padding:2px 4px 3px;text-align:center;">
        <span style="font:600 7px/1 Inter,sans-serif;color:rgba(255,255,255,.7);letter-spacing:.4px;text-transform:uppercase">${p.label}</span>
      </div>
    </button>`).join('');
}

function selectPreset(id) {
  S.selectedPreset = id;
  const p = PRESETS.find(x => x.id === id) || PRESETS[0];

  // Fill all manual fields from preset
  if ($('textFont'))       $('textFont').value = p.font;
  if ($('textSize'))     { $('textSize').value = p.size; $('textSizeVal').textContent = p.size + 'px'; }
  if ($('textBgColor'))    $('textBgColor').value = p.bgColor;
  if ($('textBgOpacity')) { $('textBgOpacity').value = p.bgOpacity; $('textBgOpVal').textContent = p.bgOpacity + '%'; }
  if ($('textAnim'))       $('textAnim').value = p.animation;

  S.textStyle = {
    bold: !!p.bold && TextStyle.supportsBold(p.font),
    italic: !!p.italic,
    shadow: !!p.shadow,
    outline: !!p.outline,
  };
  S.textPos   = p.position;

  ['bold','italic','shadow','outline'].forEach(k => {
    const btn = $(`btn-${k}`);
    if (!btn) return;
    btn.classList.toggle('border-blue',   S.textStyle[k]);
    btn.classList.toggle('text-blue',     S.textStyle[k]);
    btn.classList.toggle('border-border', !S.textStyle[k]);
    btn.classList.toggle('text-muted',    !S.textStyle[k]);
    btn.setAttribute('aria-pressed', String(Boolean(S.textStyle[k])));
  });
  syncTextBoldAvailability(p.font);

  document.querySelectorAll('.pos-btn').forEach(b => {
    b.classList.remove('border-blue','text-blue');
    b.classList.add('border-border','text-muted');
    b.setAttribute('aria-pressed', 'false');
  });
  const posBtn = $(`pos-${p.position}`);
  if (posBtn) {
    posBtn.classList.add('border-blue','text-blue');
    posBtn.classList.remove('border-border','text-muted');
    posBtn.setAttribute('aria-pressed', 'true');
  }

  document.querySelectorAll('.preset-card').forEach(c => {
    const on = c.id === `pcard-${id}`;
    c.setAttribute('aria-pressed', String(on));
    c.style.borderColor = on ? '#4da6ff' : '';
    c.style.boxShadow   = on ? '0 0 0 1px #4da6ff' : '';
  });

  liveTextPreview();
}

function toggleTextStyle(key) {
  if (key === 'bold' && !TextStyle.supportsBold($('textFont')?.value)) {
    syncTextBoldAvailability();
    showFloatToast('Impact uses one fixed heavy weight so preview and export stay identical');
    return;
  }
  S.textStyle[key] = !S.textStyle[key];
  const btn = $(`btn-${key}`);
  if (btn) {
    btn.classList.toggle('border-blue',   S.textStyle[key]);
    btn.classList.toggle('text-blue',     S.textStyle[key]);
    btn.classList.toggle('border-border', !S.textStyle[key]);
    btn.classList.toggle('text-muted',    !S.textStyle[key]);
    btn.setAttribute('aria-pressed', String(Boolean(S.textStyle[key])));
  }
  liveTextPreview();
}

function syncTextBoldAvailability(font = $('textFont')?.value) {
  const supported = TextStyle.supportsBold(font);
  if (!supported) S.textStyle.bold = false;
  const button = $('btn-bold');
  if (button) {
    button.disabled = !supported;
    button.setAttribute('aria-disabled', String(!supported));
    button.setAttribute('aria-pressed', String(Boolean(S.textStyle.bold)));
    button.title = supported ? 'Toggle bold text' : 'Impact has one fixed export-matched weight';
    button.classList.toggle('border-blue', supported && S.textStyle.bold);
    button.classList.toggle('text-blue', supported && S.textStyle.bold);
    button.classList.toggle('border-border', !S.textStyle.bold);
    button.classList.toggle('text-muted', !S.textStyle.bold);
  }
  return supported && S.textStyle.bold;
}

function onTextFontChange() {
  syncTextBoldAvailability();
  liveTextPreview();
}

function setTextPos(pos) {
  S.textPos = pos;
  document.querySelectorAll('.pos-btn').forEach(b => {
    b.classList.remove('border-blue','text-blue');
    b.classList.add('border-border','text-muted');
    b.setAttribute('aria-pressed', 'false');
  });
  const btn = $(`pos-${pos}`);
  if (btn) {
    btn.classList.add('border-blue','text-blue');
    btn.classList.remove('border-border','text-muted');
    btn.setAttribute('aria-pressed', 'true');
  }
  liveTextPreview();
}

function liveTextPreview() {
  const el = $('textPreviewEl'), wrap = $('textPreviewWrap');
  if (!el || !wrap) return;

  const txt     = $('textContent')?.value?.trim() || 'Your text here';
  const color   = $('textColor')?.value    || '#ffffff';
  const font    = $('textFont')?.value     || 'Inter,sans-serif';
  const size    = parseInt($('textSize')?.value    || 32);
  const bgColor = $('textBgColor')?.value  || '#000000';
  const bgOp    = parseInt($('textBgOpacity')?.value || 0) / 100;
  const scaledSize = Math.max(9, Math.round(size * 0.32));
  const previewScale = scaledSize / Math.max(1, size);
  const effectiveBold = syncTextBoldAvailability(font);

  el.textContent      = txt.replace(/\s*\n\s*/g, ' ');
  el.style.fontFamily = TextStyle.previewFontFamily(font, effectiveBold, S.textStyle.italic);
  el.style.fontSize   = scaledSize + 'px';
  el.style.fontWeight = effectiveBold      ? '700'    : '400';
  el.style.fontStyle  = S.textStyle.italic ? 'italic' : 'normal';
  el.style.color      = color;
  el.style.whiteSpace = 'nowrap';
  el.style.wordBreak  = 'normal';
  el.style.maxWidth   = 'none';

  if (S.textStyle.outline) {
    const outline = Math.max(0.5, 2 * previewScale);
    el.style.textShadow = `-${outline}px -${outline}px 0 #000,${outline}px -${outline}px 0 #000,-${outline}px ${outline}px 0 #000,${outline}px ${outline}px 0 #000`;
  } else if (S.textStyle.shadow) {
    el.style.textShadow = `${2 * previewScale}px ${2 * previewScale}px 0 rgba(0,0,0,.67)`;
  } else {
    el.style.textShadow = 'none';
  }

  if (bgOp > 0) {
    const r = parseInt(bgColor.slice(1,3),16);
    const g = parseInt(bgColor.slice(3,5),16);
    const b = parseInt(bgColor.slice(5,7),16);
    el.style.backgroundColor = `rgba(${r},${g},${b},${bgOp})`;
    el.style.padding         = `${8 * previewScale}px`;
    el.style.borderRadius    = '0';
  } else {
    el.style.backgroundColor = 'transparent';
    el.style.padding         = '0';
    el.style.borderRadius    = '0';
  }

  const posMap = {
    tl: { alignItems:'flex-start', justifyContent:'flex-start'  },
    tc: { alignItems:'flex-start', justifyContent:'center'      },
    tr: { alignItems:'flex-start', justifyContent:'flex-end'    },
    ml: { alignItems:'center',     justifyContent:'flex-start'  },
    mc: { alignItems:'center',     justifyContent:'center'      },
    mr: { alignItems:'center',     justifyContent:'flex-end'    },
    bl: { alignItems:'flex-end',   justifyContent:'flex-start'  },
    bc: { alignItems:'flex-end',   justifyContent:'center'      },
    br: { alignItems:'flex-end',   justifyContent:'flex-end'    },
  };
  const pm = posMap[S.textPos] || posMap.bc;
  wrap.style.alignItems     = pm.alignItems;
  wrap.style.justifyContent = pm.justifyContent;
  wrap.style.padding = S.textPos === 'bc' ? '0 5% 8%' : '5%';

  el.getAnimations?.().forEach(animation => animation.cancel());
  el.style.opacity = '1';
  el.style.transform = 'none';
  const animation = ['fade', 'slide-up', 'pop', 'none'].includes($('textAnim')?.value)
    ? $('textAnim').value
    : 'fade';
  const duration = Math.max(0.05, Number($('textDuration')?.value) || 4);
  const fadeIn = Math.min(duration * 0.5, Math.max(0.01, Number($('textFadeIn')?.value) || 0.01));
  const fadeOut = Math.min(duration * 0.5, Math.max(0.01, Number($('textFadeOut')?.value) || 0.01));
  const motionLabel = $('textMotionPreviewLabel');
  if (motionLabel) {
    const name = animation === 'slide-up' ? 'Slide up' : animation === 'pop' ? 'Pop' : animation === 'fade' ? 'Fade' : 'Static';
    motionLabel.textContent = animation === 'none' ? 'Static style preview' : `${name} motion · ${duration.toFixed(1)}s timeline`;
  }
  if (animation === 'none' || prefersReducedMotion() || typeof el.animate !== 'function') return;

  const motionDistance = Math.max(2, wrap.clientHeight * 0.04);
  const demoDuration = clamp(duration * 1000, 1800, 6000);
  const motionFrames = Array.from({ length: 31 }, (_, index) => {
    const offset = index / 30;
    const phase = offset * duration;
    const enter = clamp(phase / fadeIn, 0, 1);
    const exit = clamp((duration - phase) / fadeOut, 0, 1);
    const progress = Math.min(enter, exit);
    const popScale = animation === 'pop'
      ? 0.84 + (1 - Math.pow(1 - progress, 3)) * 0.16
      : 1;
    const transform = animation === 'slide-up'
      ? `translateY(${((1 - progress) * motionDistance).toFixed(2)}px)`
      : 'none';
    return { offset, opacity: progress, transform, fontSize: `${(scaledSize * popScale).toFixed(3)}px` };
  });
  el.animate(motionFrames, { duration: demoDuration, iterations: Infinity, easing: 'linear' });
}

function confirmText() {
  const txt = ($('textContent')?.value || '').trim();
  if (!txt) { closeTextModal(); return; }

  const startTime = parseFloat($('textStartTime')?.value ?? 0);
  const duration  = parseInt($('textDuration')?.value  || 4);
  const fadeIn    = parseFloat($('textFadeIn')?.value  || 0.3);
  const fadeOut   = parseFloat($('textFadeOut')?.value || 0.3);
  const selectedFont = $('textFont')?.value || 'Inter,sans-serif';

  const kf = {
    id:        Date.now(),
    type:      'text',
    time:      Math.max(0, startTime),
    duration,
    fadeIn:    Math.min(fadeIn,  duration * 0.45),
    fadeOut:   Math.min(fadeOut, duration * 0.45),
    text:      txt,
    font:      selectedFont,
    size:      parseInt($('textSize')?.value || 32),
    bold:      TextStyle.supportsBold(selectedFont) && S.textStyle.bold,
    italic:    S.textStyle.italic,
    shadow:    S.textStyle.shadow,
    outline:   S.textStyle.outline,
    color:     $('textColor')?.value   || '#ffffff',
    bgColor:   $('textBgColor')?.value || '#000000',
    bgOpacity: parseInt($('textBgOpacity')?.value || 0),
    position:  S.textPos,
    animation: $('textAnim')?.value    || 'fade',
    preset:    S.selectedPreset,
  };
  S.keyframes.push(kf);
  S.keyframes.sort((a, b) => a.time - b.time);
  closeTextModal(); drawKfLayer(); renderKfLists();
  // Seek just past fade-in so overlay is immediately visible
  const showAt = kf.time + Math.min(kf.fadeIn + 0.05, kf.duration * 0.3);
  $('videoPreview').currentTime = showAt;
  renderTextOverlays(showAt);
}

function clearKeyframes() { S.keyframes = []; drawKfLayer(); renderKfLists(); }

function removeKeyframe(id) {
  S.keyframes = S.keyframes.filter(k => k.id !== id);
  drawKfLayer(); renderKfLists();
}

function drawKfLayer() {
  const layer    = $('keyframeLayer');
  const kfLayer  = $('kfTrackLayer');
  if (!S.dur) {
    if (layer)   layer.innerHTML = '';
    if (kfLayer) kfLayer.innerHTML = '';
    return;
  }

  // Split markers on the video track, click to remove.
  const cutHtml = (S.cuts || []).map(t => {
    const pct = (t / S.dur) * 100;
    return `<button type="button" class="cut-marker" style="left:${pct}%"
      title="Remove cut at ${fmtTime(t)}" aria-label="Remove cut at ${fmtTime(t)}"
      onclick="event.stopPropagation();removeCut(${t})"></button>`;
  }).join('');

  const removedHtml = (S.removedRanges || []).map(range => {
    const left = clamp(range.start / S.dur * 100, 0, 100);
    const right = clamp(range.end / S.dur * 100, 0, 100);
    return `<div class="removed-range" style="left:${left}%;width:${Math.max(0, right - left)}%"
      title="Removed ${fmtTime(range.start)} to ${fmtTime(range.end)}"></div>`;
  }).join('');

  if (layer) layer.innerHTML = removedHtml + cutHtml;

  // Keyframe dots on the event track
  if (kfLayer) {
    kfLayer.innerHTML = S.keyframes.map(kf => {
      const pct   = (kf.time / S.dur) * 100;
      const color = kf.type === 'zoom'   ? '#fbbf24'
                  : (kf.type === 'text' || kf.type === 'caption') ? '#4ade80'
                  : kf.type === 'key'    ? '#818cf8'
                  : kf.type === 'marker' ? '#a78bfa'
                  : '#f87171';
      const lbl   = kf.type === 'zoom'
        ? `${kf.zoomLevel}× zoom @ ${fmtTime(kf.time)}`
        : (kf.type === 'text' || kf.type === 'caption')
          ? `"${kf.text}" @ ${fmtTime(kf.time)}`
          : kf.type === 'key'
            ? `${kf.label} @ ${fmtTime(kf.time)}`
            : kf.type === 'marker'
              ? `${kf.label} @ ${fmtTime(kf.time)}`
              : `Click @ ${fmtTime(kf.time)}`;
      const safeLabel = escapeHtml(lbl);
      return `<button type="button" style="position:absolute;left:${pct}%;top:50%;
                   transform:translate(-50%,-50%);
                   width:10px;height:10px;border-radius:50%;
                   background:${color};border:1.5px solid #06070d;
                   cursor:pointer;z-index:20;pointer-events:auto;"
                class="keyframe-dot" title="Remove ${safeLabel}" aria-label="Remove ${safeLabel}"
                onclick="event.stopPropagation();removeKeyframe(${kf.id})"></button>`;
    }).join('');
  }
}

function renderKfLists() {
  const zooms  = S.keyframes.filter(k => k.type === 'zoom');
  const texts  = S.keyframes.filter(k => k.type === 'text' || k.type === 'caption');
  const events = S.keyframes.filter(k => k.type === 'key' || k.type === 'click' || k.type === 'marker');

  // Update count badges
  const zc = $('zoomCount'); if (zc) zc.textContent = `${zooms.length} shot${zooms.length === 1 ? '' : 's'} / ${MAX_ZOOM_SHOTS} segment max`;
  const tc = $('textCount'); if (tc) tc.textContent = texts.length + ' overlay' + (texts.length !== 1 ? 's' : '');

  const itemStyle = 'display:flex;justify-content:space-between;align-items:center;padding:4px 8px;border-radius:8px;background:rgba(255,255,255,.03);margin-bottom:3px';
  const monoStyle = (color) => `font-size:11px;font-family:monospace;color:${color}`;
  const lblStyle  = 'font-size:11px;color:rgba(255,255,255,.4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80px';
  const rmBtn = (id, label) => `<button type="button" onclick="removeKeyframe(${id})"
    aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"
    style="font-size:13px;color:#fca5a5;line-height:1">×</button>`;

  const zl = $('zoomKfList');
  if (zl) zl.innerHTML = zooms.length
    ? zooms.map(k => `<div style="${itemStyle}">
        <span style="${monoStyle('rgba(251,191,36,.8)')}">${fmtTime(k.time)}</span>
        <span style="${lblStyle}">${escapeHtml(k.zoomLevel)}×${k.source === 'auto-click' ? ' auto' : ''}</span>
        ${rmBtn(k.id, `Remove zoom at ${fmtTime(k.time)}`)}
      </div>`).join('')
    : '<p style="font-size:11px;font-style:italic;color:rgba(255,255,255,.2)">None yet</p>';

  const tl = $('textKfList');
  if (tl) tl.innerHTML = texts.length
    ? texts.map(k => `<div style="${itemStyle}">
        <span style="${monoStyle('rgba(74,222,128,.8)')}">${fmtTime(k.time)}</span>
        <span style="${lblStyle}">${escapeHtml(k.text)}</span>
        ${rmBtn(k.id, `Remove text overlay at ${fmtTime(k.time)}`)}
      </div>`).join('')
    : '<p style="font-size:11px;font-style:italic;color:rgba(255,255,255,.2)">None yet</p>';

  const el = $('eventKfList');
  if (el) el.innerHTML = events.length
    ? events.slice(0, 20).map(k => {
        const col = k.type === 'key' ? '#a5b4fc' : k.type === 'marker' ? '#c4b5fd' : '#fca5a5';
        const lbl = k.type === 'key' ? k.label : k.type === 'marker' ? k.label : 'click';
        return `<div style="${itemStyle}">
          <span style="${monoStyle(col)}">${fmtTime(k.time)}</span>
          <span style="${lblStyle}">${escapeHtml(lbl)}</span>
          ${rmBtn(k.id, `Remove ${k.type} event at ${fmtTime(k.time)}`)}
        </div>`;
      }).join('')
    : '<p style="font-size:11px;font-style:italic;color:rgba(255,255,255,.2)">None yet</p>';

  renderCutList();
  updateDirectorSummary();
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TEXT OVERLAY PREVIEW  (CSS-based, live in video area)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Container is #previewArea; we inject <div> overlays into it
let _overlayEls = {};

function zoomStateAt(time) {
  // Reads the marker rather than recomputing the budget: this runs per frame.
  const active = S.keyframes
    .filter(k => k.type === 'zoom' && !k.overBudget && time >= k.time && time <= k.time + (Number(k.duration) || 0))
    .sort((a, b) => a.time - b.time)
    .at(-1);
  if (!active) return { scale: 1, xPct: 0.5, yPct: 0.5 };
  const duration = Math.max(0.05, Number(active.duration) || 1.55);
  const ramp = Math.min(0.35, duration * 0.22);
  const elapsed = clamp(time - active.time, 0, duration);
  const edgeProgress = elapsed < ramp
    ? elapsed / ramp
    : elapsed > duration - ramp
      ? (duration - elapsed) / ramp
      : 1;
  const rawProgress = clamp(edgeProgress, 0, 1);
  const eased = active.easing === 'linear'
    ? rawProgress
    : 0.5 - 0.5 * Math.cos(rawProgress * Math.PI);
  const strength = clamp(Number(active.zoomLevel || active.strength || S.cfg.zoomLevel) || 1, 1, 4);
  return {
    scale: 1 + (strength - 1) * eased,
    xPct: clamp(Number(active.xPct ?? 0.5), 0, 1),
    yPct: clamp(Number(active.yPct ?? 0.5), 0, 1),
  };
}

function mapPointThroughZoom(xPct, yPct, time) {
  const zoom = zoomStateAt(time);
  return {
    xPct: zoom.xPct + (Number(xPct) - zoom.xPct) * zoom.scale,
    yPct: zoom.yPct + (Number(yPct) - zoom.yPct) * zoom.scale,
  };
}

function mapPointThroughPreview(xPct, yPct, time) {
  const point = mapPointThroughZoom(xPct, yPct, time);
  const presentation = currentPreviewPresentation();
  const mapped = PresentationEngine.mapSourcePoint(
    presentation,
    Number(S.videoW) || 16,
    Number(S.videoH) || 9,
    point.xPct,
    point.yPct,
  );
  return {
    ...mapped,
  };
}

function previewRenderMetrics(time = 0) {
  const stage = $('previewStage');
  const presentation = currentPreviewPresentation();
  const sourceWidth = Number(S.videoW) || 16;
  const sourceHeight = Number(S.videoH) || 9;
  const geometry = PresentationEngine.presentationGeometry(presentation, sourceWidth, sourceHeight);
  if (!stage || !geometry || !stage.clientWidth) {
    return { hudScale: 1, sourceScale: 1, cameraScale: zoomStateAt(time).scale, motionDistance: 18 };
  }
  const outputScale = stage.clientWidth / geometry.width;
  return {
    hudScale: outputScale,
    sourceScale: outputScale * geometry.videoWidth / sourceWidth,
    cameraScale: zoomStateAt(time).scale,
    motionDistance: stage.clientHeight * 0.04,
  };
}

function renderZoomPreview(time) {
  const vid = $('videoPreview');
  if (!vid) return;
  const zoom = zoomStateAt(time);
  vid.style.transformOrigin = `${(zoom.xPct * 100).toFixed(2)}% ${(zoom.yPct * 100).toFixed(2)}%`;
  vid.style.transform = zoom.scale > 1.0005 ? `scale(${zoom.scale.toFixed(4)})` : 'none';
  const backdrop = $('previewBackdropVideo');
  if (backdrop) {
    syncPreviewBackdropGeometry(time);
  }
}

function renderTextOverlays(t) {
  const area = $('previewStage');
  const sourceLayer = $('sourceOverlayPreviewLayer');
  if (!area) return;
  const metrics = previewRenderMetrics(t);

  const active = S.keyframes.filter(k =>
    (k.type === 'text' || k.type === 'caption' || k.type === 'key' || k.type === 'click') &&
    t >= k.time && t < k.time + (k.duration || 1)
  );

  // Remove stale overlays
  Object.keys(_overlayEls).forEach(id => {
    if (!active.find(k => k.id === +id)) {
      _overlayEls[id]?.remove();
      delete _overlayEls[id];
    }
  });

  // Add / update active overlays
  active.forEach(kf => {
    let el = _overlayEls[kf.id];
    let textBaseFontSize = 0;
    if (!el) {
      el = document.createElement('div');
      el.style.cssText = `
        position:absolute; pointer-events:none; select:none; z-index:10;
        max-width:none; white-space:nowrap; word-break:normal; text-align:center;
        transition: opacity .08s linear, transform .08s linear, font-size .08s linear;
      `;
      (kf.type === 'click' && sourceLayer ? sourceLayer : area).appendChild(el);
      _overlayEls[kf.id] = el;
    }

    if (kf.type === 'key') {
      el.textContent = kf.label;
      el.style.fontFamily = 'Arial, sans-serif';
      el.style.fontSize = `${Math.max(8, 34 * metrics.hudScale)}px`;
      el.style.fontWeight = '800';
      el.style.fontStyle = 'normal';
      el.style.letterSpacing = '0';
      el.style.color = '#dce8f8';
      el.style.backgroundColor = 'rgba(9,13,24,.867)';
      el.style.border = '0';
      el.style.boxShadow = 'none';
      el.style.textShadow = `0 ${2 * metrics.hudScale}px 0 rgba(0,0,0,.67)`;
      el.style.padding = `${14 * metrics.hudScale}px`;
      el.style.borderRadius = '0';
      positionOverlay(el, 'bc');
      el.style.bottom = `calc(12% - ${14 * metrics.hudScale}px)`;
    } else if (kf.type === 'click') {
      const point = mapPointThroughZoom(kf.xPct, kf.yPct, t);
      el.style.display = '';
      el.textContent = '○';
      const clickScale = metrics.sourceScale * metrics.cameraScale;
      el.style.fontFamily = 'Arial, sans-serif';
      el.style.fontSize = `${Math.max(10, 58 * clickScale)}px`;
      el.style.fontWeight = '700';
      el.style.fontStyle = 'normal';
      el.style.lineHeight = '1';
      el.style.color = 'rgba(248,113,113,.87)';
      el.style.textShadow = 'none';
      el.style.width = 'auto';
      el.style.height = 'auto';
      el.style.borderRadius = '0';
      el.style.border = '0';
      el.style.boxShadow = 'none';
      el.style.backgroundColor = 'transparent';
      el.style.padding = '0';
      el.style.left = (point.xPct * 100) + '%';
      el.style.top = (point.yPct * 100) + '%';
      el.style.right = el.style.bottom = 'auto';
      el.style.transform = 'translate(-50%,-50%)';
    } else {
      el.textContent = String(kf.text || '').replace(/\s*\n\s*/g, ' ');
      const effectiveBold = TextStyle.supportsBold(kf.font) && kf.bold;
      textBaseFontSize = Math.max(4, Number(kf.size || 32) * metrics.hudScale);
      el.style.fontFamily  = TextStyle.previewFontFamily(kf.font, effectiveBold, kf.italic);
      el.style.fontSize    = `${textBaseFontSize}px`;
      el.style.fontWeight  = effectiveBold ? 'bold' : 'normal';
      el.style.fontStyle   = kf.italic ? 'italic' : 'normal';
      el.style.color       = kf.color;

      if (kf.outline) {
        const outline = Math.max(0.5, 2 * metrics.hudScale);
        el.style.textShadow = `-${outline}px -${outline}px 0 #000,${outline}px -${outline}px 0 #000,-${outline}px ${outline}px 0 #000,${outline}px ${outline}px 0 #000`;
      } else if (kf.shadow) {
        el.style.textShadow = `${2 * metrics.hudScale}px ${2 * metrics.hudScale}px 0 rgba(0,0,0,.67)`;
      } else {
        el.style.textShadow = 'none';
      }

      if (kf.bgOpacity > 0) {
        const r = parseInt(kf.bgColor.slice(1,3),16);
        const g = parseInt(kf.bgColor.slice(3,5),16);
        const b = parseInt(kf.bgColor.slice(5,7),16);
        el.style.backgroundColor = `rgba(${r},${g},${b},${kf.bgOpacity/100})`;
        el.style.padding         = `${8 * metrics.hudScale}px`;
        el.style.borderRadius    = '0';
      } else {
        el.style.backgroundColor = 'transparent';
        el.style.padding         = '0';
        el.style.borderRadius    = '0';
      }

      positionOverlay(el, kf.position);
    }

    // Per-keyframe motion and fade, matched by the export renderer.
    const elapsed   = t - kf.time;
    const remaining = (kf.time + kf.duration) - t;
    const overlayDuration = Math.max(0.05, Number(kf.duration) || 1);
    const fi = Math.min(overlayDuration * 0.5, Math.max(0, Number(kf.fadeIn ?? 0.3)));
    const fo = Math.min(overlayDuration * 0.5, Math.max(0, Number(kf.fadeOut ?? 0.3)));
    const animation = (kf.type === 'text' || kf.type === 'caption')
      ? (['fade', 'slide-up', 'pop', 'none'].includes(kf.animation) ? kf.animation : 'fade')
      : 'none';
    const enter = fi > 0 ? clamp(elapsed / fi, 0, 1) : 1;
    const exit = fo > 0 ? clamp(remaining / fo, 0, 1) : 1;
    const opacity = animation === 'none' ? 1 : Math.min(enter, exit);
    el.style.opacity = String(clamp(opacity, 0, 1));
    if (kf.type === 'text' || kf.type === 'caption') {
      const baseTransform = el.style.transform || '';
      if (animation === 'slide-up') {
        const offset = (1 - Math.min(enter, exit)) * metrics.motionDistance;
        el.style.transform = `${baseTransform} translateY(${offset.toFixed(2)}px)`.trim();
      } else if (animation === 'pop') {
        const progress = Math.min(enter, exit);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.style.transform = baseTransform;
        el.style.fontSize = `${(textBaseFontSize * (0.84 + eased * 0.16)).toFixed(3)}px`;
      }
    }
  });
}

let _cursorPreviewEl = null;

function renderCursorPreview(t) {
  const area = $('sourceOverlayPreviewLayer');
  if (!area || !S.cfg.cursor) {
    if (_cursorPreviewEl) _cursorPreviewEl.style.display = 'none';
    return;
  }
  const p = interpolatedCursorPoint(t);
  if (!p) {
    if (_cursorPreviewEl) _cursorPreviewEl.style.display = 'none';
    return;
  }
  if (!_cursorPreviewEl) {
    _cursorPreviewEl = document.createElement('div');
    _cursorPreviewEl.style.cssText = `
      position:absolute;pointer-events:none;z-index:8;width:18px;height:18px;
      border-radius:999px;border:2px solid rgba(255,255,255,.92);
      box-sizing:border-box;
      box-shadow:0 0 0 8px rgba(94,234,212,.14),0 10px 24px rgba(0,0,0,.38);
      transform:translate(-50%,-50%);transition:left .08s linear,top .08s linear;
      display:flex;align-items:center;justify-content:center;
    `;
    _cursorPreviewEl.innerHTML = '<span aria-hidden="true" style="display:block;border-radius:999px"></span>';
    area.appendChild(_cursorPreviewEl);
  }
  _cursorPreviewEl.style.display = '';
  const point = mapPointThroughZoom(p.xPct, p.yPct, t);
  const metrics = previewRenderMetrics(t);
  const displayScale = metrics.sourceScale * metrics.cameraScale;
  const renderSpec = CursorEngine.cursorRenderSpec(S.cfg.cursorSize);
  const cursorSize = Math.max(6, renderSpec.diameter * displayScale);
  const cursorThemes = {
    accent: { ring: 'rgba(94,234,212,.87)', fill: 'rgba(255,255,255,.93)', trail: 'rgba(94,234,212,.33)' },
    red: { ring: 'rgba(248,113,113,.87)', fill: 'rgba(255,255,255,.93)', trail: 'rgba(248,113,113,.33)' },
    dark: { ring: 'rgba(17,24,39,.87)', fill: 'rgba(255,255,255,.93)', trail: 'rgba(17,24,39,.33)' },
    light: { ring: 'rgba(255,255,255,.87)', fill: 'rgba(17,24,39,.93)', trail: 'rgba(255,255,255,.33)' },
  };
  const theme = cursorThemes[S.cfg.cursorTheme] || cursorThemes.accent;
  _cursorPreviewEl.style.width = `${cursorSize}px`;
  _cursorPreviewEl.style.height = `${cursorSize}px`;
  _cursorPreviewEl.style.borderWidth = `${Math.max(1, renderSpec.borderWidth * displayScale)}px`;
  _cursorPreviewEl.style.borderColor = theme.ring;
  _cursorPreviewEl.style.boxShadow = S.cfg.cursorTrail
    ? `${Math.max(1, renderSpec.trailOffset * displayScale)}px ${Math.max(1, renderSpec.trailOffset * displayScale)}px 0 ${theme.trail}`
    : 'none';
  const dot = _cursorPreviewEl.firstElementChild;
  if (dot) {
    const dotSize = Math.max(3, renderSpec.dotDiameter * displayScale);
    dot.style.width = `${dotSize}px`;
    dot.style.height = `${dotSize}px`;
    dot.style.background = theme.fill;
  }
  _cursorPreviewEl.style.left = (point.xPct * 100) + '%';
  _cursorPreviewEl.style.top = (point.yPct * 100) + '%';
}

function interpolatedCursorPoint(t) {
  const points = S.recEvents?.cursor || [];
  if (!points.length || t < points[0].time - 0.06 || t > points.at(-1).time + 0.06) return null;
  if (t <= points[0].time) return points[0];
  if (t >= points.at(-1).time) return points.at(-1);
  let low = 0;
  let high = points.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].time <= t) low = middle;
    else high = middle;
  }
  const from = points[low];
  const to = points[high];
  const progress = clamp((t - from.time) / Math.max(0.001, to.time - from.time), 0, 1);
  return {
    time: t,
    xPct: from.xPct + (to.xPct - from.xPct) * progress,
    yPct: from.yPct + (to.yPct - from.yPct) * progress,
  };
}

function positionOverlay(el, pos) {
  // Reset
  el.style.top = el.style.bottom = el.style.left = el.style.right = 'auto';
  el.style.transform = '';

  const margin = '5%';
  switch(pos) {
    case 'tl': el.style.top    = margin; el.style.left  = margin; el.style.textAlign = 'left';   break;
    case 'tc': el.style.top    = margin; el.style.left  = '50%';  el.style.transform = 'translateX(-50%)'; el.style.textAlign = 'center'; break;
    case 'tr': el.style.top    = margin; el.style.right = margin; el.style.textAlign = 'right';  break;
    case 'ml': el.style.top    = '50%';  el.style.left  = margin; el.style.transform = 'translateY(-50%)'; el.style.textAlign = 'left';   break;
    case 'mc': el.style.top    = '50%';  el.style.left  = '50%';  el.style.transform = 'translate(-50%,-50%)'; el.style.textAlign = 'center'; break;
    case 'mr': el.style.top    = '50%';  el.style.right = margin; el.style.transform = 'translateY(-50%)'; el.style.textAlign = 'right';  break;
    case 'bl': el.style.bottom = margin; el.style.left  = margin; el.style.textAlign = 'left';   break;
    case 'bc': el.style.bottom = '8%'; el.style.left  = '50%';  el.style.transform = 'translateX(-50%)'; el.style.textAlign = 'center'; break;
    case 'br': el.style.bottom = margin; el.style.right = margin; el.style.textAlign = 'right';  break;
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADJUSTMENTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function updateAdjust() {
  const b = parseInt($('brightness').value);
  const c = parseInt($('contrast').value);
  const s = parseInt($('saturation').value);
  S.adj = { b, c, s };
  $('brightnessVal').textContent = b;
  $('contrastVal').textContent   = c;
  $('saturationVal').textContent = s;
  $('videoPreview').style.filter = colorAdjustmentCssFilter();
  updatePresentationPreview();
}

function normalizedColorAdjustment() {
  const { b = 0, c = 0, s = 0 } = S.adj || {};
  return {
    brightness: clamp(1 + Number(b) * 0.02, 0, 2),
    contrast: clamp(1 + Number(c) * 0.02, 0, 2),
    saturation: clamp(1 + Number(s) * 0.02, 0, 2),
  };
}

function colorAdjustmentCssFilter() {
  const adjustment = normalizedColorAdjustment();
  return `brightness(${adjustment.brightness.toFixed(4)}) contrast(${adjustment.contrast.toFixed(4)}) saturate(${adjustment.saturation.toFixed(4)})`;
}

function colorAdjustmentExportFilters() {
  const adjustment = normalizedColorAdjustment();
  const filters = [];
  if (Math.abs(adjustment.brightness - 1) > 0.0001 || Math.abs(adjustment.contrast - 1) > 0.0001) {
    const expression = `clip((val*${adjustment.brightness.toFixed(4)}-127.5)*${adjustment.contrast.toFixed(4)}+127.5\\,0\\,255)`;
    filters.push(`lutrgb=r='${expression}':g='${expression}':b='${expression}'`);
  }
  if (Math.abs(adjustment.saturation - 1) > 0.0001) {
    const amount = adjustment.saturation;
    const matrix = {
      rr: 0.213 + 0.787 * amount,
      rg: 0.715 - 0.715 * amount,
      rb: 0.072 - 0.072 * amount,
      gr: 0.213 - 0.213 * amount,
      gg: 0.715 + 0.285 * amount,
      gb: 0.072 - 0.072 * amount,
      br: 0.213 - 0.213 * amount,
      bg: 0.715 - 0.715 * amount,
      bb: 0.072 + 0.928 * amount,
    };
    filters.push(`colorchannelmixer=${Object.entries(matrix).map(([key, value]) => `${key}=${value.toFixed(5)}`).join(':')}`);
  }
  return filters;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  EXPORT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function showExportPanel() {
  openAccessibleDialog('exportModal', 'exportBtn');
  $('exportProgress').classList.add('hidden');
  if ($('exportActions')) $('exportActions').classList.add('hidden');
  if ($('exportCancelBtn')) $('exportCancelBtn').classList.add('hidden');
  setExportProgress(5);
  const btn = $('exportBtn');
  btn.disabled = false; btn.textContent = 'Export';
  $('toggle-export-pad')?.classList.toggle('toggle-on', !!S.cfg.pad);
  $('toggle-export-pad')?.setAttribute('aria-checked', String(Boolean(S.cfg.pad)));
  const preset = $('exportPreset')?.value || 'youtube';
  highlightPresetChip(document.querySelector(`.export-chip[data-export-preset="${CSS.escape(preset)}"]`));
  // Update output dir label
  const label = $('outputDirLabel');
  if (label) label.textContent = S.cfg.outputDir ? S.cfg.outputDir.split('/').pop() || S.cfg.outputDir : 'Desktop';
  const destLabel = $('exportDestLabel');
  if (destLabel) destLabel.textContent = S.cfg.outputDir ? `Saves to ${S.cfg.outputDir.split('/').pop()}` : 'Saves to Desktop';
}

function closeExportPanel() { closeAccessibleDialog('exportModal'); }

function highlightPresetChip(el) {
  document.querySelectorAll('.export-chip').forEach(c => {
    const selected = c === el;
    c.classList.toggle('active', selected);
    c.setAttribute('aria-pressed', String(selected));
    c.style.background = 'rgba(255,255,255,.05)';
    c.style.color = 'rgba(255,255,255,.5)';
    c.style.borderColor = 'rgba(255,255,255,.1)';
  });
  if (!el) return;
  el.style.background = 'rgba(96,165,250,.15)';
  el.style.color = '#93c5fd';
  el.style.borderColor = 'rgba(96,165,250,.3)';
}

function applyExportPreset() {
  const preset = $('exportPreset')?.value || 'youtube';
  highlightPresetChip(document.querySelector(`.export-chip[data-export-preset="${CSS.escape(preset)}"]`));
  const map = {
    youtube:    { res: '1920:1080', crf: '18', pad: true,  format: 'mp4' },
    youtube4k:  { res: '3840:2160', crf: '15', pad: true,  format: 'mp4' },
    shorts:     { res: '1080:1920', crf: '20', pad: true,  format: 'mp4' },
    tiktok:     { res: '1080:1920', crf: '20', pad: true,  format: 'mp4' },
    twitter:    { res: '1280:720',  crf: '22', pad: false, format: 'mp4' },
    linkedin:   { res: '1920:1080', crf: '20', pad: true,  format: 'mp4' },
    instagram:  { res: '1080:1080', crf: '20', pad: true,  format: 'mp4' },
    instagram16:{ res: '1080:1350', crf: '20', pad: true,  format: 'mp4' },
    loom:       { res: '1920:1080', crf: '22', pad: false, format: 'mp4' },
    hevc:       { res: 'source',    crf: '18', pad: false, format: 'mp4_hevc' },
    gif:        { res: '960:540',   crf: '18', pad: false, format: 'gif' },
    webm:       { res: '1920:1080', crf: '20', pad: false, format: 'webm' },
    retina:     { res: '2560:1440', crf: '15', pad: true,  format: 'mp4' },
    source:     { res: 'source',    crf: '18', pad: false, format: 'mp4' },
  };
  const p = map[preset] || map.youtube;
  if ($('exportRes')) $('exportRes').value = p.res;
  if ($('exportQuality')) $('exportQuality').value = p.crf;
  if ($('exportFormat')) $('exportFormat').value = p.format;
  onExportResolutionChange();
  S.cfg.pad = p.pad;
  $('toggle-export-pad')?.classList.toggle('toggle-on', p.pad);
  $('toggle-export-pad')?.setAttribute('aria-checked', String(p.pad));
  syncSettingToggle('pad');
  updatePresentationPreview();
  drawBgPreview();
  schedulePersist();
}

function toggleExportPresentation(toggle) {
  S.cfg.pad = !S.cfg.pad;
  toggle?.classList.toggle('toggle-on', S.cfg.pad);
  toggle?.setAttribute('aria-checked', String(S.cfg.pad));
  syncSettingToggle('pad');
  updatePresentationPreview();
  drawBgPreview();
  schedulePersist();
}

let _lastExportPath = null;

async function runExport() {
  const btn    = $('exportBtn');
  const resVal = $('exportRes').value;
  const crf    = $('exportQuality').value;
  const format = $('exportFormat')?.value || 'mp4';
  const hasPad = !!S.cfg.pad;

  btn.disabled = true; btn.textContent = 'Exporting…';
  $('exportProgress').classList.remove('hidden');
  setExportProgress(5, 'Building export…');
  if ($('exportCancelBtn')) $('exportCancelBtn').classList.remove('hidden');
  if ($('exportActions')) $('exportActions').classList.add('hidden');

  const droppedZooms = enforceZoomSegmentBudget();
  if (droppedZooms > 0) {
    drawKfLayer();
    renderKfLists();
    showFloatToast(`${droppedZooms} camera shot${droppedZooms === 1 ? '' : 's'} inactive - over the export segment limit`);
  }
  const filterBundle = buildFilters(resVal, hasPad);
  const audioFilters = buildAudioFilters();
  const ts      = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const ext     = format === 'gif' ? 'gif' : format === 'webm' ? 'webm' : 'mp4';
  const outName = `ScreenForge-${ts}.${ext}`;
  const outputDir = S.cfg.outputDir || '';

  const watermark = S.cfg.watermark?.enabled ? S.cfg.watermark : null;
  const speedMultiplier = S.cfg.speedMultiplier || 1;
  const blurZones = S.blurZones?.length ? S.blurZones : null;
  const removedRanges = S.removedRanges?.length ? S.removedRanges : null;
  const backgroundMusic = _bgMusicPath ? {
    path: _bgMusicPath,
    volume: Number(S.cfg.musicVolume ?? 0.12),
    ducking: S.cfg.musicDucking !== false,
  } : null;

  try {
    _lastExportPath = await screenforgeApi.exportFinal({
      inputPath: S.videoPath,
      filters: filterBundle.filters,
      sourceOverlays: filterBundle.sourceOverlays,
      cameraFilters: filterBundle.cameraFilters,
      postFilters: filterBundle.postFilters,
      presentation: filterBundle.presentation,
      audioFilters,
      outputName: outName, trimIn: S.trimIn, trimOut: S.trimOut,
      crf, format, outputDir, watermark, speedMultiplier, blurZones,
      removedRanges, hasAudio: S.videoHasAudio, backgroundMusic,
    });
    const destDir = outputDir ? outputDir.split('/').pop() : 'Desktop';
    setExportProgress(100, `Saved to ${destDir}: ${outName}`);
    btn.textContent = 'Done ✓';
    if ($('exportCancelBtn')) $('exportCancelBtn').classList.add('hidden');
    if ($('exportActions')) $('exportActions').classList.remove('hidden');
    if ($('exportRevealBtn')) $('exportRevealBtn').onclick = () => screenforgeApi.showInFinder(_lastExportPath);
    if ($('exportCopyBtn')) $('exportCopyBtn').onclick = () => {
      screenforgeApi.copyToClipboard(_lastExportPath);
      showFloatToast('Path copied to clipboard');
    };
  } catch(e) {
    if (e.message !== 'Export cancelled') {
      btn.disabled = false; btn.textContent = 'Export';
      $('exportProgressText').textContent = 'Error: ' + e.message;
    } else {
      btn.disabled = false; btn.textContent = 'Export';
      $('exportProgressText').textContent = 'Export cancelled';
    }
    if ($('exportCancelBtn')) $('exportCancelBtn').classList.add('hidden');
  }
}

async function cancelExport() {
  await screenforgeApi.cancelExport();
  const btn = $('exportBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Export'; }
  if ($('exportCancelBtn')) $('exportCancelBtn').classList.add('hidden');
  if ($('exportProgressText')) $('exportProgressText').textContent = 'Cancelled';
}

function buildFilters(resVal, hasPad) {
  const sourceParts = [];
  const cameraParts = [];
  const sourceOverlayParts = [];
  const postParts = [];
  const presentation = buildPresentationOptions(resVal, hasPad);
  sourceParts.push(...colorAdjustmentExportFilters());

  // activeZoomKeyframes() is the canonical selector: it recomputes the segment
  // budget against the current cuts, so export always agrees with the preview.
  // The slice stays as a belt-and-braces guard on segment count.
  const zooms = activeZoomKeyframes()
    .sort((a, b) => a.time - b.time)
    .slice(0, MAX_ZOOM_SHOTS)
    .flatMap(k => {
      const duration = Number(k.duration || 1.55);
      return mapExportSegments(k.time, k.time + duration).map(timing => ({
        ...k,
        sourceDuration: duration,
        exportTiming: timing,
      }));
    });
  if (zooms.length > MAX_ZOOM_SHOTS) {
    throw new Error(`Camera edits exceed the ${MAX_ZOOM_SHOTS}-segment export limit`);
  }
  if (zooms.length && S.videoW && S.videoH) {
    const ffIf = (cond, yes, no) => `if(${cond}\\,${yes}\\,${no})`;
    let zExpr = '1';
    let xExpr = '0.5';
    let yExpr = '0.5';
    for (const k of zooms) {
      const start = Math.max(0, k.exportTiming.start).toFixed(2);
      const end = k.exportTiming.end.toFixed(2);
      const cond = `between(t\\,${start}\\,${end})`;
      const duration = Math.max(0.05, Number(k.sourceDuration) || 1.55);
      const ramp = Math.min(0.35, duration * 0.22);
      const phase = `(t-${start}+${Math.max(0, Number(k.exportTiming.phaseOffset) || 0).toFixed(3)})`;
      const inProgress = `(${phase}/${ramp.toFixed(3)})`;
      const outProgress = `((${duration.toFixed(3)}-${phase})/${ramp.toFixed(3)})`;
      const inEase = k.easing === 'linear' ? inProgress : `(0.5-0.5*cos(${inProgress}*3.14159))`;
      const outEase = k.easing === 'linear' ? outProgress : `(0.5-0.5*cos(${outProgress}*3.14159))`;
      const strength = clamp(Number(k.zoomLevel || k.strength || S.cfg.zoomLevel) || 1, 1, 4).toFixed(2);
      const zoomIn = `(1+(${strength}-1)*${inEase})`;
      const zoomOut = `(1+(${strength}-1)*${outEase})`;
      const zSmooth = ffIf(`lt(${phase}\\,${ramp.toFixed(3)})`, zoomIn,
        ffIf(`gt(${phase}\\,${(duration - ramp).toFixed(3)})`, zoomOut, strength));
      zExpr = ffIf(cond, zSmooth, zExpr);
      xExpr = ffIf(cond, clamp(Number(k.xPct ?? 0.5), 0, 1).toFixed(3), xExpr);
      yExpr = ffIf(cond, clamp(Number(k.yPct ?? 0.5), 0, 1).toFixed(3), yExpr);
    }
    cameraParts.push(
      `scale=w='ceil(${S.videoW}*${zExpr}/2)*2':h='ceil(${S.videoH}*${zExpr}/2)*2':eval=frame`,
      `crop=w=${S.videoW}:h=${S.videoH}:x='(iw-${S.videoW})*${xExpr}':y='(ih-${S.videoH})*${yExpr}'`
    );
  }

  // Smooth cursor path, rendered at export time from captured cursor samples.
  if (S.cfg.cursor) {
    const cursor = buildCursorFilters();
    if (cursor) sourceOverlayParts.push(...cursor);
  }

  // Click pulse overlays
  const clickFontFile = TextStyle.ffFilterPath(TextStyle.drawtextFontFile('Arial', true, false));
  for (const kf of S.keyframes.filter(k => k.type === 'click')) {
    const timing = mapExportInterval(kf.time, kf.time + (kf.duration || 0.8));
    if (!timing) continue;
    sourceOverlayParts.push(
      `drawtext=text='○':expansion=none:fontfile='${clickFontFile}':fontsize=58:fontcolor=0xf87171DD:`
      + `x='w*${Number(kf.xPct ?? 0.5).toFixed(3)}-text_w/2':y='h*${Number(kf.yPct ?? 0.5).toFixed(3)}-text_h/2':`
      + `enable='between(t\\,${timing.start.toFixed(2)}\\,${timing.end.toFixed(2)})'`
    );
  }

  // Keyboard shortcut overlays
  for (const kf of S.keyframes.filter(k => k.type === 'key')) {
    const timing = mapExportInterval(kf.time, kf.time + (kf.duration || 1.4));
    if (!timing) continue;
    const safe = TextStyle.ffText(kf.label);
    if (!safe) continue;
    const fontFile = TextStyle.ffFilterPath(TextStyle.drawtextFontFile('Arial', true, false));
    postParts.push(
      `drawtext=text=${safe}:expansion=none:fontfile='${fontFile}':fontsize=34:fontcolor=0xdce8f8FF:box=1:boxcolor=0x090d18DD:boxborderw=14:x=(w-text_w)/2:y=h-text_h-h*0.12:shadowx=0:shadowy=2:shadowcolor=0x000000AA:enable='between(t\\,${timing.start.toFixed(2)}\\,${timing.end.toFixed(2)})'`
    );
  }

  // Text overlays and captions via ffmpeg drawtext
  for (const kf of S.keyframes.filter(k => k.type === 'text' || k.type === 'caption')) {
    const duration = Math.max(0.05, Number(kf.duration) || 1);
    const timings = mapExportSegments(kf.time, kf.time + duration);
    if (!timings.length) continue;
    const hex    = /^#[0-9a-f]{6}$/i.test(kf.color) ? kf.color.slice(1) : 'ffffff';
    const safe   = TextStyle.ffText(kf.text);
    if (!safe) continue;
    const effectiveBold = TextStyle.supportsBold(kf.font) && kf.bold;
    const fontFile = TextStyle.ffFilterPath(TextStyle.drawtextFontFile(kf.font, effectiveBold, kf.italic));
    const fontSize = clamp(Math.round(Number(kf.size) || 32), 8, 240);

    // Position to ffmpeg x/y expression
    const posToXY = (pos) => {
      const mx = 'w*0.05';
      const my = 'h*0.05';
      switch(pos) {
        case 'tl': return { x: mx, y: my };
        case 'tc': return { x: '(w-text_w)/2', y: my };
        case 'tr': return { x: `w-text_w-${mx}`, y: my };
        case 'ml': return { x: mx, y: '(h-text_h)/2' };
        case 'mc': return { x: '(w-text_w)/2', y: '(h-text_h)/2' };
        case 'mr': return { x: `w-text_w-${mx}`, y: '(h-text_h)/2' };
        case 'bl': return { x: mx, y: `h-text_h-${my}` };
        case 'bc': return { x: '(w-text_w)/2', y: 'h-text_h-h*0.08' };
        case 'br': return { x: `w-text_w-${mx}`, y: `h-text_h-${my}` };
        default:   return { x: '(w-text_w)/2', y: 'h-text_h-h*0.08' };
      }
    };

    let shadowStr = '';
    if (kf.shadow)  shadowStr = ':shadowx=2:shadowy=2:shadowcolor=0x000000AA';
    if (kf.outline) shadowStr = ':borderw=2:bordercolor=0x000000FF';

    let bgStr = '';
    if (kf.bgOpacity > 0) {
      const bgAlpha = Math.round(kf.bgOpacity / 100 * 255).toString(16).padStart(2,'0');
      const bgHex   = /^#[0-9a-f]{6}$/i.test(kf.bgColor) ? kf.bgColor.slice(1) : '000000';
      bgStr = `:box=1:boxcolor=0x${bgHex}${bgAlpha}:boxborderw=8`;
    }

    const animation = ['fade', 'slide-up', 'pop', 'none'].includes(kf.animation) ? kf.animation : 'fade';
    let fadeIn = 0.01;
    let fadeOut = 0.01;
    if (animation !== 'none') {
      fadeIn = Math.min(duration * 0.5, Math.max(0.01, Number(kf.fadeIn ?? 0.3)));
      fadeOut = Math.min(duration * 0.5, Math.max(0.01, Number(kf.fadeOut ?? 0.3)));
    }

    const position = posToXY(kf.position);
    for (const [timingIndex, timing] of timings.entries()) {
      const start = timing.start;
      const end = timing.end;
      const startToken = start.toFixed(6);
      const endToken = end.toFixed(6);
      const enableExpr = timingIndex < timings.length - 1
        ? `between(t\\,${startToken}\\,${endToken})*lt(t\\,${endToken})`
        : `between(t\\,${startToken}\\,${endToken})`;
      const phaseOffset = Math.max(0, Number(timing.phaseOffset) || 0);
      const phase = `(t-${startToken}+${phaseOffset.toFixed(6)})`;
      let alphaExpr = '1';
      if (animation !== 'none') {
        alphaExpr = `if(lt(${phase}\\,${fadeIn.toFixed(2)})\\,${phase}/${fadeIn.toFixed(2)}\\,if(gt(${phase}\\,${(duration - fadeOut).toFixed(2)})\\,(${duration.toFixed(3)}-${phase})/${fadeOut.toFixed(2)}\\,1))`;
      }
      const enterProgress = `clip(${phase}/${fadeIn.toFixed(2)}\\,0\\,1)`;
      const exitProgress = `clip((${duration.toFixed(3)}-${phase})/${fadeOut.toFixed(2)}\\,0\\,1)`;
      const motionProgress = `min(${enterProgress}\\,${exitProgress})`;
      const popProgress = `(1-pow(1-${motionProgress}\\,3))`;
      const yExpr = animation === 'slide-up'
        ? `(${position.y})+h*0.04*(1-${motionProgress})`
        : position.y;
      const fontSizeToken = animation === 'pop'
        ? `'${fontSize}*(0.84+0.16*${popProgress})'`
        : String(fontSize);

      postParts.push(
        `drawtext=text=${safe}:expansion=none:fontfile='${fontFile}':fontsize=${fontSizeToken}:fontcolor=0x${hex}FF` +
        `${shadowStr}${bgStr}` +
        `:x=${position.x}:y=${yExpr}` +
        `:alpha='${alphaExpr}'` +
        `:enable='${enableExpr}'`
      );
    }
  }

  return {
    filters: sourceParts.length ? sourceParts.join(',') : null,
    sourceOverlays: sourceOverlayParts.length ? sourceOverlayParts.join(',') : null,
    cameraFilters: cameraParts.length ? cameraParts.join(',') : null,
    postFilters: postParts.length ? postParts.join(',') : null,
    presentation,
  };
}

function buildAudioFilters() {
  if (!S.cfg.audioCleanup) return null;
  return [
    'highpass=f=85',
    'lowpass=f=13500',
    'afftdn=nf=-25',
    'acompressor=threshold=-18dB:ratio=2.5:attack=12:release=180:makeup=2dB',
    'loudnorm=I=-16:TP=-1.5:LRA=11',
  ].join(',');
}

function buildCursorFilters() {
  const pathSegments = CreatorEngine.splitCursorPath(S.recEvents?.cursor || [], timelineContext());
  if (!pathSegments.length) return null;

  const themes = {
    accent: { ring: '0x5eead4DD', fill: '0xffffffEE', trail: '0x5eead455' },
    red:    { ring: '0xf87171DD', fill: '0xffffffEE', trail: '0xf8717155' },
    dark:   { ring: '0x111827DD', fill: '0xffffffEE', trail: '0x11182755' },
    light:  { ring: '0xffffffDD', fill: '0x111827EE', trail: '0xffffff55' },
  };
  const theme = themes[S.cfg.cursorTheme || 'accent'] || themes.accent;
  const scale = Number(S.cfg.cursorSize || 1);
  const renderSpec = CursorEngine.cursorRenderSpec(scale);
  const glyphSize = renderSpec.ffFontSize;
  const borderWidth = renderSpec.ffBorderWidth;
  const filters = [];
  const fontFile = TextStyle.ffFilterPath(TextStyle.drawtextFontFile('Arial', true, false));

  const allPoints = pathSegments.flatMap(segment => segment.points);
  const maximum = CursorEngine.samplingLimit(allPoints, {
    minimum: 720,
    maximum: 10000,
    targetInterval: 0.12,
  });
  const sampledSegments = CursorEngine.samplePointSegments(pathSegments, maximum);
  const chunks = sampledSegments.flatMap((segment, segmentIndex) => {
    const segmentChunks = CursorEngine.buildPathChunks(segment.points, {
      maximum: segment.points.length,
      chunkSize: 90,
    });
    if (!segmentChunks.length) return [];
    segmentChunks[0].start = segmentIndex === 0
      ? Math.max(0, segment.start - 0.06)
      : segment.start;
    segmentChunks.at(-1).end = segmentIndex === sampledSegments.length - 1
      ? segment.end + 0.06
      : Math.max(segment.start, segment.end);
    segmentChunks.at(-1).endExclusive = segmentIndex !== sampledSegments.length - 1;
    return segmentChunks;
  });
  for (const chunk of chunks) {
    const xExpression = chunk.xExpression;
    const yExpression = chunk.yExpression;
    const enable = CursorEngine.chunkEnableExpression(chunk);

    const trail = S.cfg.cursorTrail
      ? `:shadowx=${renderSpec.trailOffset}:shadowy=${renderSpec.trailOffset}:shadowcolor=${theme.trail}`
      : '';
    filters.push(
      `drawtext=text='●':expansion=none:fontfile='${fontFile}':fontsize=${glyphSize}:fontcolor=${theme.fill}:`
      + `borderw=${borderWidth}:bordercolor=${theme.ring}${trail}:`
      + `x='w*(${xExpression})-text_w/2':y='h*(${yExpression})-text_h/2':enable='${enable}'`
    );
  }

  return filters;
}

async function generateTranscript() {
  if (!S.videoPath) { alert('Record or import a video first.'); return null; }
  const result = await screenforgeApi.generateTranscript({ inputPath: S.videoPath });
  S.transcript = {
    text: result.text || '',
    cues: result.srt ? parseSrt(result.srt) : [],
    srt: result.srt || '',
    srtPath: result.srtPath || null,
  };
  if (S.cfg.captions) addCaptionKeyframes(S.transcript.cues);
  renderKfLists();
  drawKfLayer();
  return S.transcript;
}

function addCaptionKeyframes(cues) {
  S.keyframes = S.keyframes.filter(k => k.type !== 'caption');
  for (const cue of cues.slice(0, 500)) {
    S.keyframes.push({
      id: Date.now() + Math.round(cue.start * 1000),
      type: 'caption',
      time: cue.start,
      duration: Math.max(0.4, cue.end - cue.start),
      text: cue.text,
      font: 'Inter,sans-serif',
      size: 26,
      bold: true,
      italic: false,
      shadow: true,
      outline: false,
      color: '#ffffff',
      bgColor: '#000000',
      bgOpacity: 68,
      position: 'bc',
      animation: 'fade',
    });
  }
  S.keyframes.sort((a, b) => a.time - b.time);
}

function parseSrt(raw) {
  return raw.trim().split(/\n\s*\n/).map(block => {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const timing = lines.find(line => line.includes('-->'));
    if (!timing) return null;
    const [start, end] = timing.split('-->').map(srtTimeToSeconds);
    const text = lines.slice(lines.indexOf(timing) + 1).join(' ').trim();
    return text ? { start, end, text } : null;
  }).filter(Boolean);
}

function srtTimeToSeconds(value) {
  const m = String(value).trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`);
}

function onExportTick(timeStr) {
  try {
    const p    = timeStr.split(':');
    const secs = parseInt(p[0])*3600 + parseInt(p[1])*60 + parseFloat(p[2]);
    const dur  = S.trimOut - S.trimIn;
    if (dur > 0) {
      const pct = clamp((secs / dur) * 100, 5, 95);
      setExportProgress(pct, `Exporting… ${fmtTime(secs)} / ${fmtTime(dur)}`);
    }
  } catch {}
}

function setExportProgress(percent, message) {
  const value = clamp(Number(percent) || 0, 0, 100);
  const bar = $('exportProgressBar');
  if (bar) {
    bar.style.width = `${value}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(value)));
  }
  if (message != null && $('exportProgressText')) $('exportProgressText').textContent = String(message);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function $(id)            { return document.getElementById(id); }
function lerp(a, b, t)    { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sleep(ms)        { return new Promise(resolve => setTimeout(resolve, ms)); }
function prepareMediaElement(el) {
  el.muted = true;
  el.autoplay = true;
  el.playsInline = true;
}
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function playMediaElement(el, message) {
  const started = el.play();
  if (started?.catch) started.catch(() => {});
  if (!el.videoWidth && el.readyState < 2) {
    await withTimeout(new Promise((resolve, reject) => {
      const done = () => resolve();
      el.onloadedmetadata = done;
      el.oncanplay = done;
      el.onplaying = done;
      el.onerror = () => reject(new Error(message));
    }), 5000, message);
  }
  await withTimeout(el.play(), 3000, message);
}
function fmtTime(secs) {
  if (!isFinite(secs) || secs < 0) secs = 0;
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2,'0')}`;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BACKGROUND PREVIEW CANVAS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _bgThumbImg = null;
let _bgThumbSrc = '';

function startBgAnim() {
  drawBgPreview();
}

function stopBgAnim() {}

function initBgSwatches() {
  const row = $('bgSwatchRow');
  if (!row) return;
  row.innerHTML = BG_PRESETS.map((p, i) => {
    const [c1, c2] = p.swatch;
    const selected = i === S.bgPreset;
    return `<button type="button" class="bg-swatch${selected ? ' active' : ''}"
                 style="background:linear-gradient(135deg,${c1},${c2})"
                 title="${escapeHtml(p.label)}" aria-label="Use ${escapeHtml(p.label)} gradient"
                 aria-pressed="${selected}" data-preset-index="${i}"
                 onclick="selectBgPreset(${i})"></button>`;
  }).join('');
  syncBackgroundPresetControls();
}

function initBgCanvas() {
  const wrap = $('bgPreviewWrap');
  if (!wrap) return;
  if (window.ResizeObserver) {
    new ResizeObserver(() => { _bgThumbImg = null; requestAnimationFrame(drawBgPreview); }).observe(wrap);
  }
  REDUCED_MOTION_QUERY?.addEventListener?.('change', () => {
    drawBgPreview();
  });
  startBgAnim();
}

function selectBgPreset(idx) {
  S.bgPreset = clamp(Math.round(Number(idx) || 0), 0, BG_PRESETS.length - 1);
  S.cfg.bgMode = 'gradient';
  syncBackgroundPresetControls();
  syncSolidBackgroundControls();
  drawBgPreview();
  updatePresentationPreview();
  schedulePersist();
}

function syncBackgroundPresetControls() {
  document.querySelectorAll('.bg-swatch, .insp-bg-thumb').forEach(el => {
    const selected = S.cfg.bgMode !== 'solid' && Number(el.dataset.presetIndex) === S.bgPreset;
    el.classList.toggle('active', selected);
    el.setAttribute('aria-pressed', String(selected));
  });
}

// ── Inspector panel navigation ────────────────────────────────────────────────

function switchInspPanel(name) {
  document.querySelectorAll('.insp-panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.insp-icon').forEach(b => b.classList.remove('active'));
  const panel = $('panel-' + name);
  if (panel) panel.classList.remove('hidden');
  const btn = $('insp-' + name);
  if (btn) btn.classList.add('active');
  document.querySelectorAll('.insp-icon').forEach(button => {
    button.setAttribute('aria-pressed', String(button === btn));
  });
}

function switchBgTab(tab) {
  document.querySelectorAll('.insp-tab').forEach(b => {
    b.classList.remove('active');
    b.setAttribute('aria-pressed', 'false');
  });
  $('bgtab-' + tab)?.classList.add('active');
  $('bgtab-' + tab)?.setAttribute('aria-pressed', 'true');
  const isGrad = tab === 'gradient';
  S.cfg.bgMode = isGrad ? 'gradient' : 'solid';
  if ($('bgGradientGrid')) $('bgGradientGrid').classList.toggle('hidden', !isGrad);
  if ($('bgSolidPanel'))   $('bgSolidPanel').classList.toggle('hidden', isGrad);
  syncBackgroundPresetControls();
  syncSolidBackgroundControls();
  drawBgPreview();
  updatePresentationPreview();
  schedulePersist();
}

function initInspBgGrid() {
  const grid = $('bgGradientGrid');
  if (!grid) return;
  grid.innerHTML = BG_PRESETS.map((p, i) => {
    const [c1, c2] = p.swatch;
    const selected = i === S.bgPreset;
    return `<button type="button" class="insp-bg-thumb${selected ? ' active' : ''}"
                 style="background:linear-gradient(135deg,${c1},${c2})"
                 title="${escapeHtml(p.label)}" aria-label="Use ${escapeHtml(p.label)} gradient"
                 aria-pressed="${selected}" data-preset-index="${i}"
                 onclick="selectBgPreset(${i})"></button>`;
  }).join('');
  syncBackgroundPresetControls();
}

function applyBgSolid() {
  const value = $('bgSolidColor')?.value;
  if (!/^#[0-9a-f]{6}$/i.test(value)) return;
  S.cfg.bgMode = 'solid';
  S.cfg.bgSolidColor = value;
  syncSolidBackgroundControls();
  drawBgPreview();
  updatePresentationPreview();
  schedulePersist();
}

function setBgSolidQuick(hex) {
  const inp = $('bgSolidColor');
  if (inp) { inp.value = hex; applyBgSolid(); }
}

function syncSolidBackgroundControls() {
  document.querySelectorAll('.solid-bg-swatch').forEach(button => {
    const selected = S.cfg.bgMode === 'solid'
      && button.dataset.solidColor?.toLowerCase() === String(S.cfg.bgSolidColor || '').toLowerCase();
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

function setBackgroundPadding(value) {
  S.cfg.bgPadding = clamp(Number(value) / 100, 0, 0.22);
  if ($('bgPadVal')) $('bgPadVal').textContent = `${Math.round(S.cfg.bgPadding * 100)}%`;
  drawBgPreview();
  updatePresentationPreview();
  schedulePersist();
}

function setBackgroundBlur(value) {
  S.cfg.bgBlur = clamp(Number(value) / 100, 0, 1);
  if ($('bgBlurVal')) $('bgBlurVal').textContent = `${Math.round(S.cfg.bgBlur * 100)}%`;
  drawBgPreview();
  updatePresentationPreview();
  schedulePersist();
}


function drawBgPreview() {
  const canvas = $('bgPreviewCanvas');
  const wrap   = $('bgPreviewWrap');
  const hint   = $('bgPreviewHint');
  if (!canvas || !wrap) return;

  const rect = wrap.getBoundingClientRect();
  const W = Math.round(rect.width);
  const H = Math.round(rect.height);
  if (W < 10 || H < 10) return;

  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
  }

  const ctx    = canvas.getContext('2d');
  const preset = BG_PRESETS[S.bgPreset] || BG_PRESETS[0];
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (S.cfg.bgMode === 'solid') {
    ctx.fillStyle = /^#[0-9a-f]{6}$/i.test(S.cfg.bgSolidColor) ? S.cfg.bgSolidColor : '#1a1a2e';
    ctx.fillRect(0, 0, W, H);
  } else {
    _bgMesh(ctx, W, H, preset);
  }

  if (!S.selected?.thumbnail) {
    if (hint) hint.style.display = '';
    return;
  }
  if (hint) hint.style.display = 'none';

  // Use the cached thumbnail to avoid reloading every animation frame.
  if (_bgThumbSrc === S.selected.thumbnail && _bgThumbImg?.complete) {
    _bgThumb(ctx, _bgThumbImg, W, H);
    return;
  }

  const img = new Image();
  img.onload = () => {
    _bgThumbImg = img;
    _bgThumbSrc = S.selected.thumbnail;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (S.cfg.bgMode === 'solid') {
      ctx.fillStyle = /^#[0-9a-f]{6}$/i.test(S.cfg.bgSolidColor) ? S.cfg.bgSolidColor : '#1a1a2e';
      ctx.fillRect(0, 0, W, H);
    } else {
      _bgMesh(ctx, W, H, preset);
    }
    _bgThumb(ctx, img, W, H);
  };
  img.src = S.selected.thumbnail;
}

function _bgMesh(ctx, W, H, preset) {
  const colors = Array.isArray(preset.swatch) && preset.swatch.length >= 2
    ? preset.swatch
    : ['#2563eb', '#7c3aed'];
  const gradient = ctx.createLinearGradient(0, 0, W, H);
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(1, colors[1]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);
}

function _bgThumb(ctx, img, W, H) {
  const width = Math.max(16, W - (W % 2));
  const height = Math.max(16, H - (H % 2));
  const offsetX = (W - width) / 2;
  const offsetY = (H - height) / 2;
  const preset = BG_PRESETS[S.bgPreset] || BG_PRESETS[0];
  const presentation = PresentationEngine.normalizePresentation({
    width,
    height,
    sourceWidth: img.naturalWidth,
    sourceHeight: img.naturalHeight,
    styled: !!S.cfg.pad,
    mode: S.cfg.bgMode || 'gradient',
    colors: preset.swatch,
    solidColor: S.cfg.bgSolidColor || '#1a1a2e',
    padding: Number(S.cfg.bgPadding ?? 0.05),
    blur: Number(S.cfg.bgBlur ?? 0.4),
    frame: !!S.cfg.frame,
  });
  const geometry = PresentationEngine.presentationGeometry(
    presentation,
    img.naturalWidth,
    img.naturalHeight,
  );
  if (!geometry) return;

  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.translate(offsetX, offsetY);

  if (presentation.styled) {
    if (presentation.blur > 0.001) {
      const coverScale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
      const coverWidth = img.naturalWidth * coverScale;
      const coverHeight = img.naturalHeight * coverScale;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.clip();
      const recordingSize = selectedRecordingOutputSize(img);
      const displayScale = Math.min(width / recordingSize.width, height / recordingSize.height);
      ctx.filter = `blur(${((4 + presentation.blur * 32) * displayScale).toFixed(2)}px)`;
      ctx.drawImage(img, (width - coverWidth) / 2, (height - coverHeight) / 2, coverWidth, coverHeight);
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = presentation.blur > 0.001 ? 0.68 : 1;
    if (presentation.mode === 'solid') {
      ctx.fillStyle = presentation.solidColor;
    } else {
      const wash = ctx.createLinearGradient(0, 0, width, height);
      wash.addColorStop(0, presentation.colors[0]);
      wash.addColorStop(1, presentation.colors[1]);
      ctx.fillStyle = wash;
    }
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  const ix = geometry.videoX;
  const iy = geometry.videoY;
  const iw = geometry.videoWidth;
  const ih = geometry.videoHeight;
  const frameH = geometry.frameHeight;
  const r = geometry.cornerRadius;

  if (presentation.frame) {
    ctx.save();
    const barGrd = ctx.createLinearGradient(geometry.boxX, geometry.boxY, geometry.boxX, geometry.boxY + frameH);
    barGrd.addColorStop(0, '#3d3d3f');
    barGrd.addColorStop(1, '#2c2c2e');
    roundRect(ctx, geometry.boxX, geometry.boxY, geometry.innerWidth, frameH, [r, r, 0, 0]);
    ctx.fillStyle = barGrd;
    ctx.fill();
    ctx.restore();

    const dotSize = Math.max(5, Math.round(frameH * 0.28));
    const dotGap = Math.max(4, Math.round(dotSize * 0.65));
    const dotX = Math.max(8, Math.round(frameH * 0.55));
    const dotY = geometry.boxY + frameH / 2;
    ['#ff5f57', '#febc2e', '#28c840'].forEach((fill, index) => {
      ctx.beginPath();
      ctx.arc(geometry.boxX + dotX + index * (dotSize + dotGap) + dotSize / 2, dotY, dotSize / 2, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill();
    });

    ctx.save();
    roundRect(ctx, ix, iy, iw, ih, [0, 0, r, r]);
    ctx.clip();
    ctx.drawImage(img, ix, iy, iw, ih);
    ctx.restore();

    ctx.save();
    roundRect(ctx, geometry.boxX, geometry.boxY, geometry.innerWidth, geometry.frameBoxHeight, r);
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  } else {
    ctx.save();
    if (presentation.styled) roundRect(ctx, ix, iy, iw, ih, r);
    else ctx.rect(ix, iy, iw, ih);
    ctx.clip();
    ctx.drawImage(img, ix, iy, iw, ih);
    ctx.restore();

    if (presentation.styled) {
      ctx.save();
      roundRect(ctx, ix, iy, iw, ih, r);
      ctx.strokeStyle = 'rgba(255,255,255,.10)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }

  if (S.cfg.captureArea) {
    const a = sanitizeCaptureArea(S.cfg.captureArea);
    if (a) {
      const ax = ix + iw * a.xPct;
      const ay = iy + ih * a.yPct;
      const aw = iw * a.wPct;
      const ah = ih * a.hPct;
      ctx.save();
      ctx.fillStyle = 'rgba(96,165,250,.13)';
      ctx.strokeStyle = 'rgba(96,165,250,.95)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 5]);
      ctx.fillRect(ax, ay, aw, ah);
      ctx.strokeRect(ax, ay, aw, ah);
      ctx.restore();
    }
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  if (typeof r === 'number') r = [r, r, r, r];
  const [tl, tr, br, bl] = r;
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y,     x + w, y + tr,     tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x,     y + h, x,     y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y,     x + tl, y,             tl);
  ctx.closePath();
/* roundRect closes here. Additional features follow. */
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PERSISTENT SETTINGS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function loadPersistedSettings() {
  if (!window.sf?.getAllSettings) return;
  try {
    const saved = await screenforgeApi.getAllSettings();
    if (saved && Object.keys(saved).length) {
      // Merge saved cfg into S.cfg
      if (saved.cfg) Object.assign(S.cfg, saved.cfg);
      // Previous builds defaulted mic on, which can hang on macOS permission prompts.
      // Keep startup deterministic unless the user turns it back on in this build.
      if (saved.cfg?.mic === true && saved.cfg?.micDefaultVersion !== 2) S.cfg.mic = false;
      S.cfg.micDefaultVersion = 2;
      // Previous builds defaulted countdown to 5. Migrate that old default once.
      if (Number(saved.cfg?.countdown) === 5 && saved.cfg?.countdownDefaultVersion !== 3) S.cfg.countdown = 3;
      S.cfg.countdownDefaultVersion = 3;
      // Browser/macOS audio cleanup can gate speech hard enough to sound chopped.
      // Keep raw mic as the stable default; users can turn cleanup back on.
      if (saved.cfg?.audioCleanup !== false && saved.cfg?.audioCleanupDefaultVersion !== 2) S.cfg.audioCleanup = false;
      S.cfg.audioCleanupDefaultVersion = 2;
      // 60fps plus live camera compositing overloaded the hidden recorder renderer.
      // Migrate old 60fps defaults down to the stable capture path.
      if (Number(saved.cfg?.fps) > 30 && saved.cfg?.fpsDefaultVersion !== 2) S.cfg.fps = 30;
      S.cfg.fps = recordingFps({ requested: S.cfg.fps });
      S.cfg.fpsDefaultVersion = 2;
      if (saved.adj) Object.assign(S.adj, saved.adj);
      if (saved.bgPreset !== undefined) {
        S.bgPreset = clamp(Math.round(Number(saved.bgPreset) || 0), 0, BG_PRESETS.length - 1);
      }
      syncConfigControls();
      console.log('[SF] Settings restored from electron-store');
    }
    S.cfg.fps = recordingFps({ requested: S.cfg.fps });
    syncConfigControls();
  } catch (e) { console.warn('[SF] Could not load settings:', e); }
}

function persistSettings() {
  if (!window.sf?.setSettings) return;
  screenforgeApi.setSettings({ cfg: S.cfg, adj: S.adj, bgPreset: S.bgPreset }).catch(() => {});
}

// Auto-persist on any setting change (debounced)
let _persistTimer = null;
function schedulePersist() {
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(persistSettings, 800);
}

// Patch the common setters to also persist
const _origSetFps     = typeof setFps     === 'function' ? setFps     : null;
const _origSetQuality = typeof setQuality === 'function' ? setQuality : null;

// We wrap them here at module level after the originals are defined
window.addEventListener('load', () => {
  // Persist whenever any control changes
  document.querySelectorAll('select, input[type="range"], input[type="checkbox"]').forEach(el => {
    el.addEventListener('change', schedulePersist);
  });
});


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LIVE RECORDING STATS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _statsInterval = null;
let _fpsCounter = { frames: 0, lastT: 0, fps: 0 };

function startStatsPolling() {
  stopStatsPolling();
  _fpsCounter = { frames: 0, lastT: performance.now(), fps: 0 };

  // Hook into the recorder to count chunks as "frames" proxy
  if (S.recorder) {
    const _orig = S.recorder.ondataavailable;
    S.recorder.ondataavailable = (e) => {
      if (_orig) _orig(e);
      _fpsCounter.frames++;
    };
  }

  _statsInterval = setInterval(async () => {
    if (!S.isRec) return;
    const statsBar = $('recStatsBar');
    if (!statsBar) return;

    // FPS estimate from chunk rate (each 250ms chunk ≈ current fps)
    const now = performance.now();
    const dt = (now - _fpsCounter.lastT) / 1000;
    if (dt > 0) {
      _fpsCounter.fps = Math.round(_fpsCounter.frames / dt);
      _fpsCounter.frames = 0;
      _fpsCounter.lastT = now;
    }

    // File size from chunks
    const totalBytes = S.chunks.reduce((s, c) => s + c.size, 0);
    const sizeMB = (totalBytes / 1024 / 1024).toFixed(1);

    // Elapsed
    const elapsed = Date.now() - S.recStartedAt - S.recPausedTotal;
    const elapsedStr = fmtTime(elapsed / 1000);

    // CPU/mem (if systeminformation available)
    let cpuMem = '';
    if (window.sf?.getSystemStats) {
      try {
        const stats = await screenforgeApi.getSystemStats();
        cpuMem = ` · CPU ${stats.cpu}% · RAM ${stats.mem}%`;
      } catch {}
    }

    const audioBits = S.audioInfo?.recordingTracks
      ? ` · audio ${S.audioInfo.micTracks ? 'mic' : ''}${S.audioInfo.micTracks && S.audioInfo.systemTracks ? '+' : ''}${S.audioInfo.systemTracks ? 'system' : ''}`
      : ' · no audio';
    const targetFps = recordingFps({ requested: S.cfg.fps, composited: !!S.canvasStream });
    statsBar.textContent = `⏺ ${elapsedStr}  ·  ${sizeMB} MB  ·  target ${targetFps} fps${audioBits}${cpuMem}`;
    statsBar.style.display = 'block';
  }, 2000);
}

function stopStatsPolling() {
  if (_statsInterval) { clearInterval(_statsInterval); _statsInterval = null; }
  const statsBar = $('recStatsBar');
  if (statsBar) statsBar.style.display = 'none';
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ANNOTATION LAYER (draw on screen during recording)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ANN = {
  active: false,
  tool: 'pen',        // 'pen' | 'arrow' | 'rect' | 'circle' | 'text' | 'laser' | 'eraser'
  color: '#f87171',
  size: 4,
  strokes: [],
  current: null,
  canvas: null,
  ctx: null,
  laserTrail: [],
};

function startAnnotationLayer() {
  let canvas = $('annotationCanvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'annotationCanvas';
    Object.assign(canvas.style, {
      position: 'fixed', inset: '0', zIndex: '9998',
      pointerEvents: 'none', display: 'none',
    });
    document.body.appendChild(canvas);
  }
  ANN.canvas = canvas;
  ANN.ctx = canvas.getContext('2d');
  ANN.strokes = [];
  ANN.active = false;
}

function stopAnnotationLayer() {
  if (ANN.canvas) { ANN.canvas.style.display = 'none'; }
  ANN.active = false;
  ANN.strokes = [];
}

function toggleAnnotationMode() {
  ANN.active = !ANN.active;
  if (!ANN.canvas) return;
  if (ANN.active) {
    ANN.canvas.width  = window.innerWidth;
    ANN.canvas.height = window.innerHeight;
    ANN.canvas.style.display  = 'block';
    ANN.canvas.style.pointerEvents = 'all';
    ANN.canvas.style.cursor   = annCursor();
    ANN.canvas.onpointerdown  = annDown;
    ANN.canvas.onpointermove  = annMove;
    ANN.canvas.onpointerup    = annUp;
    showFloatToast('✏️ Annotation mode ON');
  } else {
    ANN.canvas.style.pointerEvents = 'none';
    ANN.canvas.style.display  = 'none';
    showFloatToast('Annotation mode off');
  }
  const btn = $('annotateBtn');
  if (btn) btn.classList.toggle('is-active', ANN.active);
}

function setAnnotationTool(tool) {
  ANN.tool = tool;
  if (ANN.canvas) ANN.canvas.style.cursor = annCursor();
}
function setAnnotationColor(c) { ANN.color = c; }
function setAnnotationSize(s)  { ANN.size  = Number(s); }

function annCursor() {
  if (ANN.tool === 'laser')  return prefersReducedMotion() ? 'crosshair' : 'none';
  if (ANN.tool === 'eraser') return 'cell';
  return 'crosshair';
}

function annDown(e) {
  const pt = { x: e.clientX, y: e.clientY };
  if (ANN.tool === 'eraser') {
    annErase(pt); return;
  }
  ANN.current = { tool: ANN.tool, color: ANN.color, size: ANN.size, pts: [pt], start: pt };
}

function annMove(e) {
  const pt = { x: e.clientX, y: e.clientY };

  if (ANN.tool === 'laser') {
    if (prefersReducedMotion()) {
      ANN.laserTrail = [];
      redrawAnnotations();
      return;
    }
    ANN.laserTrail.push({ ...pt, t: Date.now() });
    if (ANN.laserTrail.length > 40) ANN.laserTrail.shift();
    redrawAnnotations();
    return;
  }
  if (!ANN.current) return;
  ANN.current.pts.push(pt);
  redrawAnnotations();
}

function annUp(e) {
  if (!ANN.current) return;
  ANN.strokes.push({ ...ANN.current });
  ANN.current = null;
  redrawAnnotations();
}

function annErase(pt) {
  ANN.strokes = ANN.strokes.filter(s => {
    const dx = s.start.x - pt.x;
    const dy = s.start.y - pt.y;
    return Math.sqrt(dx*dx + dy*dy) > 30;
  });
  redrawAnnotations();
}

function clearAnnotations() {
  ANN.strokes = [];
  redrawAnnotations();
  showFloatToast('Annotations cleared');
}

function redrawAnnotations() {
  if (!ANN.ctx) return;
  const ctx = ANN.ctx;
  ctx.clearRect(0, 0, ANN.canvas.width, ANN.canvas.height);

  // Draw laser trail
  if (ANN.laserTrail.length > 1) {
    const now = Date.now();
    for (let i = 1; i < ANN.laserTrail.length; i++) {
      const p1 = ANN.laserTrail[i-1], p2 = ANN.laserTrail[i];
      const age = (now - p2.t) / 600;
      ctx.globalAlpha = Math.max(0, 1 - age);
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = 6 * (1 - age * 0.5);
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Draw completed strokes
  for (const s of ANN.strokes) drawStroke(ctx, s);
  // Draw current stroke
  if (ANN.current) drawStroke(ctx, ANN.current);
}

function drawStroke(ctx, s) {
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle   = s.color;
  ctx.lineWidth   = s.size;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.globalAlpha = 0.92;
  const pts = s.pts;
  if (!pts?.length) { ctx.restore(); return; }

  if (s.tool === 'pen') {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();

  } else if (s.tool === 'arrow') {
    const p0 = pts[0], p1 = pts[pts.length-1];
    const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    const len = Math.sqrt((p1.x-p0.x)**2 + (p1.y-p0.y)**2);
    if (len < 4) { ctx.restore(); return; }
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    const hw = Math.max(8, s.size * 3);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p1.x - hw * Math.cos(ang - 0.4), p1.y - hw * Math.sin(ang - 0.4));
    ctx.lineTo(p1.x - hw * Math.cos(ang + 0.4), p1.y - hw * Math.sin(ang + 0.4));
    ctx.closePath(); ctx.fill();

  } else if (s.tool === 'rect') {
    const p0 = pts[0], p1 = pts[pts.length-1];
    ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);

  } else if (s.tool === 'circle') {
    const p0 = pts[0], p1 = pts[pts.length-1];
    const rx = (p1.x - p0.x) / 2, ry = (p1.y - p0.y) / 2;
    ctx.beginPath();
    ctx.ellipse(p0.x + rx, p0.y + ry, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI*2);
    ctx.stroke();
  }
  ctx.restore();
}

// Laser-trail auto-fade loop
(function laserFadeLoop() {
  if (ANN.tool === 'laser' && ANN.active && ANN.laserTrail.length > 0) {
    const now = Date.now();
    ANN.laserTrail = ANN.laserTrail.filter(p => now - p.t < 700);
    redrawAnnotations();
  }
  if (prefersReducedMotion()) setTimeout(laserFadeLoop, 250);
  else requestAnimationFrame(laserFadeLoop);
})();


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CLIP LIBRARY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _libraryClips = [];

async function showLibraryPanel() {
  const panel = $('libraryPanel');
  if (!panel) return;
  openAccessibleDialog('libraryPanel', 'libraryCloseBtn');
  await refreshClipLibrary();
}

function hideLibraryPanel(options) {
  closeAccessibleDialog('libraryPanel', options);
}

async function refreshClipLibrary() {
  if (!window.sf?.getClipLibrary) return;
  const grid = $('libraryGrid');
  grid?.setAttribute('aria-busy', 'true');
  try {
    _libraryClips = await screenforgeApi.getClipLibrary();
    renderLibrary();
  } catch (e) {
    console.warn('Library load failed:', e);
    if (grid) {
      grid.innerHTML = `<div role="alert" style="grid-column:1/-1;text-align:center;padding:40px 20px;color:#fca5a5;font-size:12px">Clip library could not be loaded.</div>`;
    }
  } finally {
    grid?.setAttribute('aria-busy', 'false');
  }
}

function renderLibrary() {
  const grid = $('libraryGrid');
  if (!grid) return;

  if (!_libraryClips.length) {
    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:40px 20px;color:rgba(255,255,255,.25);font-size:12px">
        <div style="font-size:32px;margin-bottom:12px">📁</div>
        No clips saved yet.<br>Recordings auto-save here after export.
      </div>`;
    return;
  }

  grid.innerHTML = _libraryClips.map((clip, i) => {
    const sizeMB = (Number(clip.size) / 1024 / 1024).toFixed(1);
    const date   = new Date(clip.mtime).toLocaleDateString();
    const thumb  = filePathToUrl(clip.thumbnail);
    const title  = escapeHtml(clip.title || clip.name || 'Untitled clip');
    return `
      <article class="lib-card" aria-labelledby="libraryClipTitle${i}" style="
        background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
        border-radius:10px;overflow:hidden;transition:border-color .15s"
        onmouseover="this.style.borderColor='rgba(94,234,212,.3)'"
        onmouseout="this.style.borderColor='rgba(255,255,255,.08)'">
        <div style="aspect-ratio:16/9;background:#0a0d18;position:relative;overflow:hidden">
          ${thumb ? `<img src="${escapeHtml(thumb)}" style="width:100%;height:100%;object-fit:cover" alt="">` :
            `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.28)"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3V9Z"/></svg></div>`}
          <div style="position:absolute;bottom:6px;right:6px;background:rgba(0,0,0,.7);
            border-radius:4px;padding:2px 6px;font-size:10px;color:#dce8f8">${sizeMB} MB</div>
        </div>
        <div style="padding:10px 12px">
          <div id="libraryClipTitle${i}" style="font-size:12px;font-weight:600;color:#dce8f8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
               title="${title}">${title}</div>
          <div style="font-size:10px;color:rgba(255,255,255,.35);margin-top:3px">${escapeHtml(date)}</div>
          <div style="display:flex;gap:6px;margin-top:8px">
            <button type="button" aria-label="Edit ${title}" onclick="openLibraryClip(${i})" style="
              flex:1;padding:5px;border-radius:6px;border:none;font-size:10px;font-weight:600;
              background:rgba(94,234,212,.12);color:#6ee7b7;cursor:pointer">▶ Edit</button>
            <button type="button" aria-label="Show ${title} in Finder" onclick="showInFinderLib(${i})" style="
              padding:5px 8px;border-radius:6px;border:none;font-size:10px;
              background:rgba(255,255,255,.07);color:rgba(255,255,255,.5);cursor:pointer">⌂</button>
            <button type="button" aria-label="Delete ${title}" onclick="deleteLibraryClip(${i})" style="
              padding:5px 8px;border-radius:6px;border:none;font-size:10px;
              background:rgba(248,113,113,.1);color:#fca5a5;cursor:pointer">✕</button>
          </div>
        </div>
      </article>`;
  }).join('');
}

async function openLibraryClip(i) {
  const clip = _libraryClips[i];
  if (!clip) return;
  hideLibraryPanel({ restoreFocus: false });
  await openEditor(clip.path, [], null);
  requestAnimationFrame(() => $('screenEditor')?.querySelector('button')?.focus());
}

function showInFinderLib(i) {
  const clip = _libraryClips[i];
  if (clip) screenforgeApi.showInFinder(clip.path);
}

async function deleteLibraryClip(i) {
  const clip = _libraryClips[i];
  if (!clip) return;
  if (!confirm(`Delete "${clip.title || clip.name}"?`)) return;
  await screenforgeApi.deleteClip(clip.path);
  await refreshClipLibrary();
  $('libraryCloseBtn')?.focus();
}

async function changeLibraryDir() {
  const dir = await screenforgeApi.setLibraryDir();
  if (dir) { showFloatToast('Library folder updated'); await refreshClipLibrary(); }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REMOTE CONTROL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _remoteUrl = null;

async function loadRemoteUrl() {
  if (!window.sf?.getRemoteUrl) return;
  try {
    _remoteUrl = await screenforgeApi.getRemoteUrl();
    const el = $('remoteUrlDisplay');
    if (el && _remoteUrl) {
      el.textContent = _remoteUrl;
      el.title = 'Open on phone to control recording';
    }
    const el2 = $('remoteUrlText');
    if (el2 && _remoteUrl) el2.value = _remoteUrl;
  } catch {}
}

function copyRemoteUrl() {
  if (_remoteUrl) {
    screenforgeApi.copyToClipboard(_remoteUrl);
    showFloatToast('Remote URL copied!');
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SILENCE DETECTION UI
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _silences = [];

function setSilenceOption(key, value) {
  if (!['silenceThreshold', 'silenceMinDuration', 'silencePadding'].includes(key)) return;
  S.cfg[key] = Number(value);
  schedulePersist();
}

function silenceRemovalRange(silence) {
  return CreatorEngine.silencesToRemovals([silence], {
    start: Number(S.trimIn || 0),
    end: Number(S.trimOut || S.dur || 0),
    padding: Number(S.cfg.silencePadding ?? 0.12),
    minDuration: 0.08,
  })[0] || null;
}

async function runSilenceDetect() {
  if (!S.videoPath || !window.sf?.silenceDetect) return;
  const btn = $('silenceDetectBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Detecting…'; }
  try {
    _silences = await screenforgeApi.silenceDetect({
      inputPath: S.videoPath,
      threshold: Number(S.cfg.silenceThreshold ?? -35),
      duration: Number(S.cfg.silenceMinDuration ?? 0.5),
    });
    renderSilenceList();
    showFloatToast(`Found ${_silences.length} reviewable pause${_silences.length === 1 ? '' : 's'}`);
  } catch (e) {
    showFloatToast('Silence analysis failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Analyze pauses'; }
  }
}

function renderSilenceList() {
  const el = $('silenceList');
  if (!el) return;
  if (!_silences.length) { el.innerHTML = '<div style="color:rgba(255,255,255,.3);font-size:11px;padding:8px">No pauses found yet</div>'; return; }
  el.innerHTML = _silences.map((s, i) => {
    const range = silenceRemovalRange(s);
    const removed = range && rangeIsRemoved(range.start, range.end);
    return `
    <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <span style="font-size:10px;color:rgba(255,255,255,.4);min-width:28px">#${i+1}</span>
      <span style="font-size:11px;color:#dce8f8;flex:1">${fmtTime(s.start)} → ${fmtTime(s.end)}</span>
      <span style="font-size:10px;color:rgba(255,255,255,.35)">${s.duration.toFixed(1)}s</span>
      <button onclick="seekToSilence(${s.start})" style="
        padding:2px 8px;border-radius:4px;border:none;font-size:10px;
        background:rgba(94,234,212,.1);color:#6ee7b7;cursor:pointer">Go</button>
      <button onclick="cutSilence(${i})" style="
        padding:2px 8px;border-radius:4px;border:none;font-size:10px;
        background:${removed ? 'rgba(16,185,129,.1)' : 'rgba(248,113,113,.1)'};color:${removed ? '#6ee7b7' : '#fca5a5'};cursor:pointer">${removed ? 'Restore' : 'Remove'}</button>
    </div>`;
  }).join('');
}

function seekToSilence(t) {
  const vid = $('videoPreview');
  if (vid) vid.currentTime = t;
}

function cutSilence(i) {
  const s = _silences[i];
  if (!s) return;
  const range = silenceRemovalRange(s);
  if (!range) return;
  if (rangeIsRemoved(range.start, range.end)) {
    restoreTimelineRange(range.start, range.end);
    showFloatToast(`Pause ${i + 1} restored`);
  } else {
    removeTimelineRange(range.start, range.end, 'silence');
    showFloatToast(`Pause ${i + 1} removed with speech padding`);
  }
}

async function cutAllSilences() {
  if (!_silences.length) {
    showFloatToast('Analyze pauses first');
    return;
  }
  const silenceRanges = CreatorEngine.silencesToRemovals(_silences, {
    start: Number(S.trimIn || 0),
    end: Number(S.trimOut || S.dur || 0),
    padding: Number(S.cfg.silencePadding ?? 0.12),
    minDuration: 0.08,
  }).map(range => ({ ...range, source: 'silence' }));
  const nonSilence = (S.removedRanges || []).filter(range => range.source !== 'silence');
  S.removedRanges = [...nonSilence, ...silenceRanges];
  syncRemovedRanges();
  showFloatToast(`${silenceRanges.length} pauses removed non-destructively`);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BACKGROUND MUSIC
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _bgMusicPath = null;

async function pickBackgroundMusic() {
  if (!window.sf?.pickBgMusic) return;
  const p = await screenforgeApi.pickBgMusic();
  if (!p) return;
  _bgMusicPath = p;
  syncBackgroundMusicUi();
  const name = p.split(/[\\/]/).pop();
  showFloatToast(`Background music: ${name}`);
}

function clearBackgroundMusic() {
  _bgMusicPath = null;
  syncBackgroundMusicUi();
}

function syncBackgroundMusicUi() {
  const name = _bgMusicPath ? _bgMusicPath.split(/[\\/]/).pop() : 'None';
  const label = $('bgMusicName');
  if (label) label.textContent = name;
  const row = $('bgMusicRow');
  if (row) row.style.display = _bgMusicPath ? 'flex' : 'none';
  const controls = $('bgMusicControls');
  if (controls) controls.classList.toggle('hidden', !_bgMusicPath);
  if ($('bgMusicVolume')) $('bgMusicVolume').value = Math.round(Number(S.cfg.musicVolume ?? 0.12) * 100);
  if ($('bgMusicVolumeLabel')) $('bgMusicVolumeLabel').textContent = `${Math.round(Number(S.cfg.musicVolume ?? 0.12) * 100)}%`;
  if ($('musicDucking')) $('musicDucking').checked = S.cfg.musicDucking !== false;
}

function setMusicVolume(value) {
  S.cfg.musicVolume = clamp(Number(value) / 100, 0.02, 0.35);
  if ($('bgMusicVolumeLabel')) $('bgMusicVolumeLabel').textContent = `${Math.round(S.cfg.musicVolume * 100)}%`;
  schedulePersist();
}

function setMusicDucking(enabled) {
  S.cfg.musicDucking = !!enabled;
  schedulePersist();
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MULTI-CLIP RECORDER (record multiple clips in one session)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _multiClips = [];   // [ { path, duration, title } ]

function addToMultiClip(path) {
  _multiClips.push({ path, title: `Clip ${_multiClips.length + 1}` });
  renderMultiClipList();
}

function renderMultiClipList() {
  const el = $('multiClipList');
  if (!el) return;
  if (!_multiClips.length) {
    el.innerHTML = '<div style="color:rgba(255,255,255,.3);font-size:11px;padding:8px">No clips. Record multiple sessions.</div>';
    return;
  }
  el.innerHTML = _multiClips.map((c, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <span style="display:flex;color:rgba(255,255,255,.4)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3V9Z"/></svg></span>
      <span style="font-size:11px;color:#dce8f8;flex:1">${escapeHtml(c.title)}</span>
      <button aria-label="Remove ${escapeHtml(c.title)}" onclick="removeMultiClip(${i})" style="
        padding:2px 8px;border-radius:4px;border:none;font-size:10px;
        background:rgba(248,113,113,.1);color:#fca5a5;cursor:pointer">✕</button>
    </div>`).join('');

  const mergeBtn = $('mergeClipsBtn');
  if (mergeBtn) mergeBtn.disabled = _multiClips.length < 2;
}

function removeMultiClip(i) {
  _multiClips.splice(i, 1);
  renderMultiClipList();
}

async function mergeAllClips() {
  if (_multiClips.length < 2) { showFloatToast('Need at least 2 clips to merge'); return; }
  const btn = $('mergeClipsBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Merging…'; }
  try {
    const out = await screenforgeApi.mergeClips({
      clips: _multiClips.map(c => c.path),
      outputName: `Merged-${Date.now()}.mp4`,
      outputDir: S.cfg.outputDir || null,
    });
    showFloatToast('Clips merged!');
    _multiClips = [];
    renderMultiClipList();
    await openEditor(out, [], null);
  } catch (e) {
    showFloatToast('Merge failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⛓ Merge All Clips'; }
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  NORMALIZE AUDIO
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function normalizeAudio() {
  if (!S.videoPath) return;
  const btn = $('normalizeBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Normalizing…'; }
  try {
    const out = await screenforgeApi.normalizeAudio({ inputPath: S.videoPath, outputDir: S.cfg.outputDir || '' });
    showFloatToast('Audio normalized!');
    await openEditor(out, S.keyframes, structuredClone(S.recEvents));
  } catch (e) {
    showFloatToast('Normalize failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Normalize'; }
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GIF PREVIEW EXPORT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function exportGifPreview() {
  if (!S.videoPath) return;
  const btn = $('gifPreviewBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating GIF…'; }
  try {
    const vid = $('videoPreview');
    const start = vid ? vid.currentTime : 0;
    const out = await screenforgeApi.exportGifPreview({
      inputPath: S.videoPath,
      start,
      duration: 3,
      scale: 480,
      outputDir: S.cfg.outputDir || '',
    });
    screenforgeApi.showInFinder(out);
    showFloatToast('GIF created! Opening Finder…');
  } catch (e) {
    showFloatToast('GIF failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'GIF'; }
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BURN CAPTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function burnCaptionsToVideo() {
  if (!S.videoPath) return;
  if (!S.transcript?.srtPath && !S.transcript?.srt) {
    showFloatToast('No captions to burn. Generate transcript first.');
    return;
  }
  const btn = $('burnCaptionsBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Burning…'; }
  try {
    let srtPath = S.transcript?.srtPath;
    if (!srtPath && S.transcript?.srt) {
      // Save SRT to temp file
      srtPath = await screenforgeApi.saveSrt({ srt: S.transcript.srt, videoPath: S.videoPath });
    }
    const out = await screenforgeApi.burnCaptions({
      inputPath: S.videoPath,
      srtPath,
      outputDir: S.cfg.outputDir || '',
    });
    showFloatToast('Captions burned in!');
    screenforgeApi.showInFinder(out);
  } catch (e) {
    showFloatToast('Burn captions failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Captions'; }
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RECORDING TEMPLATE SYSTEM
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _templateNames = [];

async function saveRecordingTemplate() {
  const name = String(prompt('Template name:', 'My Setup') || '').trim().slice(0, 80);
  if (!name || ['__proto__', 'prototype', 'constructor'].includes(name)) return;
  const templates = Object.assign(Object.create(null), (await screenforgeApi.getSetting('templates')) || {});
  templates[name] = structuredClone(S.cfg);
  await screenforgeApi.setSetting('templates', templates);
  renderTemplateList();
  showFloatToast(`Template "${name}" saved`);
}

async function loadTemplateList() {
  if (!window.sf?.getSetting) return;
  const templates = (await screenforgeApi.getSetting('templates')) || {};
  renderTemplateList(templates);
}

function renderTemplateList(templates) {
  const el = $('templateList');
  if (!el) return;
  const entries = Object.entries(templates || {});
  _templateNames = entries.map(([name]) => name);
  if (!entries.length) {
    el.innerHTML = '<div style="color:rgba(255,255,255,.3);font-size:11px;padding:4px">No templates saved</div>';
    return;
  }
  el.innerHTML = entries.map(([name], index) => `
    <div style="display:flex;align-items:center;gap:6px;padding:4px 0">
      <span style="font-size:11px;color:#dce8f8;flex:1">${escapeHtml(name)}</span>
      <button onclick="applyTemplateAt(${index})" style="
        padding:2px 8px;border-radius:4px;border:none;font-size:10px;
        background:rgba(94,234,212,.1);color:#6ee7b7;cursor:pointer">Apply</button>
      <button aria-label="Delete ${escapeHtml(name)}" onclick="deleteTemplateAt(${index})" style="
        padding:2px 8px;border-radius:4px;border:none;font-size:10px;
        background:rgba(248,113,113,.1);color:#fca5a5;cursor:pointer">✕</button>
    </div>`).join('');
}

function applyTemplateAt(index) {
  const name = _templateNames[index];
  if (typeof name === 'string') applyTemplate(name);
}

function deleteTemplateAt(index) {
  const name = _templateNames[index];
  if (typeof name === 'string') deleteTemplate(name);
}

async function applyTemplate(name) {
  const templates = (await screenforgeApi.getSetting('templates')) || {};
  if (Object.prototype.hasOwnProperty.call(templates, name) && templates[name] && typeof templates[name] === 'object') {
    Object.assign(S.cfg, templates[name]);
    syncConfigControls();
    showFloatToast(`Template "${name}" applied`);
  }
}

async function deleteTemplate(name) {
  const templates = Object.assign(Object.create(null), (await screenforgeApi.getSetting('templates')) || {});
  delete templates[name];
  await screenforgeApi.setSetting('templates', templates);
  renderTemplateList(templates);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CHAPTER MARKER NAMES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function renameMarker(id) {
  const kf = S.keyframes.find(k => k.id === id && k.type === 'marker');
  if (!kf) return;
  const name = prompt('Chapter name:', kf.label || '');
  if (name === null) return;
  kf.label = name;
  renderKfLists();
  showFloatToast(`Chapter renamed: ${name}`);
}

function exportChapters() {
  const speed = Math.max(0.01, Number(S.cfg.speedMultiplier || 1));
  const markers = S.keyframes
    .filter(k => k.type === 'marker')
    .map(marker => ({ ...marker, outputTime: mapExportTime(marker.time) }))
    .filter(marker => marker.outputTime != null)
    .map(marker => ({ ...marker, outputTime: marker.outputTime / speed }))
    .sort((a, b) => a.outputTime - b.outputTime)
    .filter((marker, index, list) => index === 0 || marker.outputTime - list[index - 1].outputTime >= 1);
  if (!markers.length) { showFloatToast('No chapter markers to export'); return; }
  const lines = [];
  if (markers[0].outputTime >= 1) lines.push('00:00 Introduction');
  markers.forEach((marker, index) => {
    const total = Math.max(0, Math.floor(marker.outputTime));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const stamp = hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    const title = String(marker.label || `Chapter ${index + 1}`).replace(/[\r\n]+/g, ' ').trim();
    lines.push(`${stamp} ${title}`);
  });
  screenforgeApi.copyToClipboard(lines.join('\n'));
  showFloatToast('YouTube chapters copied to clipboard');
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  KEYBOARD SHORTCUT HELP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function showShortcutsHelp() {
  openAccessibleDialog('shortcutsModal');
}
function hideShortcutsHelp() {
  closeAccessibleDialog('shortcutsModal');
}
