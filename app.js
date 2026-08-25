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
  cfg: {
    zoom: true, cursor: true, pad: true, shortcuts: true, clickRings: true,
    mic: false, systemAudio: false, audioCleanup: true,
    webcam: false, zoomLevel: 2, webcamPos: 'br', frame: true,
    webcamRect: null, webcamAvoidCursor: true,
    captureArea: null,
    cursorTheme: 'accent', cursorSize: 1, cursorTrail: true,
    captions: true,
    // New in v2
    fps: 60, quality: 'high', countdown: 3,
    micDefaultVersion: 2, countdownDefaultVersion: 2,
    micDeviceId: '', camDeviceId: '',
    webcamShape: 'rounded',     // 'circle' | 'rounded' | 'rect'
    webcamBorderColor: '#ffffff', webcamBorderWidth: 2,
    outputDir: '',              // empty = Desktop
    speedMultiplier: 1,         // export-time speed (0.25/0.5/1/2/4)
    watermark: { enabled: false, text: '', position: 'br', opacity: 0.5, size: 18 },
  },
  bgPreset: 0,
  // Blur zones for privacy redaction
  blurZones: [],   // [{ startTime, endTime, xPct, yPct, wPct, hPct, radius }]
  recSessionId: null,
  autoSaveTimer: null,

  // Recording (direct stream, no canvas needed)
  rawStream: null,
  micStream: null,
  camStream: null,
  canvasStream: null,
  drawLoop: null,
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
  trimIn:     0,
  trimOut:    0,
  isDragTrim: null,
  dragX0:     0,
  dragV0:     0,
  keyframes:  [],   // { id, type:'zoom'|'text'|'key'|'click'|'marker', time, ...props }
  cuts:       [],   // [ seconds, ... ], razor cut points
  razorMode:  false,
  adj:        { b: 0, c: 0, s: 0 },
  transcript: { text: '', cues: [] },

  // ── Text overlay builder ──
  selectedPreset: 'lower-third',
  textPos:        'bl',
  textStyle:      { bold: true, italic: false, shadow: false, outline: false },
};

const IS_ELECTRON = !!window.sf;
const sf = window.sf || {
  async getSources() {
    return [{
      id: 'browser-display',
      name: 'Browser display capture',
      thumbnail: null,
      appIcon: null,
      isScreen: true,
      bounds: null,
      browserFallback: true,
    }];
  },
  setSourceBounds() {},
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
  async probeVideo(filePath) {
    return new Promise(resolve => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => resolve({
        duration: v.duration || 0,
        width: v.videoWidth || 0,
        height: v.videoHeight || 0,
      });
      v.onerror = () => resolve({ duration: 0, width: 0, height: 0 });
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
// TEXT PRESETS: every property locked in, user only picks color + duration
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

// Mesh gradient presets: vivid, saturated Screen-Studio-style blobs
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  INIT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

window.addEventListener('DOMContentLoaded', async () => {
  showRuntimeMode();
  initBgSwatches();
  initBgCanvas();
  loadSources();
  loadDevices();
  syncCaptureNav();
  checkRecoverySessions();
  loadPersistedSettings().then(() => syncRecordMeBtn());
  loadRemoteUrl();

  if (IS_ELECTRON) {
    sf.onGlobalStop(()        => stopRecording());
    sf.onFloatPause(()        => togglePauseRecording());
    sf.onFloatMarker(()       => addMarker());
    sf.onFloatScreenshot(()   => takeScreenshotDuringRecording());
    sf.onExportProgress(t     => onExportTick(t));
    sf.onCursorMove(d         => ingestCursor(d));
    sf.onMouseDown(d          => ingestClick(d));
    sf.onKeyDown(d            => ingestKey(d));
  }

  const vid = $('videoPreview');
  vid.addEventListener('loadedmetadata', onVideoLoaded);
  vid.addEventListener('timeupdate',     onTimeUpdate);
  vid.addEventListener('ended', () => { $('playBtn').textContent = '▶'; });

  document.addEventListener('mousemove', e => { doTrimDrag(e); doMiniTrimDrag(e); });
  document.addEventListener('mouseup',   () => { endTrimDrag(); endMiniTrimDrag(); });

  document.addEventListener('keydown', e => {
    if (!$('screenEditor').classList.contains('flex')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' ||
        e.target.tagName === 'SELECT') return;
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
});

function showRuntimeMode() {
  if (IS_ELECTRON) return;
  const banner = document.createElement('div');
  banner.className = 'nd';
  banner.style.cssText = `
    position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:9999;
    padding:7px 12px;border-radius:999px;
    background:rgba(251,191,36,.13);border:1px solid rgba(251,191,36,.28);
    color:#fde68a;font:700 11px/1.2 Inter,-apple-system,sans-serif;
    box-shadow:0 10px 30px rgba(0,0,0,.28);pointer-events:none;
  `;
  banner.textContent = 'Browser preview mode: recording downloads as WebM. Launch Electron for project saving and MP4 export.';
  document.body.appendChild(banner);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SOURCES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Auto-refresh interval for the source list (clears when recording starts)
let _sourceRefreshTimer = null;

async function loadSources() {
  const grid = $('sourceGrid');
  // Only show spinner on first load (grid is empty), not on silent refreshes
  if (!S.sources.length) {
    grid.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 0;gap:10px">
        <div style="
          width:26px;height:26px;border-radius:50%;
          border:2px solid rgba(94,234,212,.15);
          border-top-color:rgba(94,234,212,.7);
          animation:spin .8s linear infinite">
        </div>
        <span style="font-size:10px;color:rgba(255,255,255,.25);letter-spacing:.05em">Scanning sources…</span>
      </div>`;
  }
  try {
    const fresh = await sf.getSources();
    // Merge: update existing entries, add new ones, keep selection stable
    const prevSelectedId = S.selected?.id;
    S.sources = fresh;
    S.selected = fresh.find(s => s.id === prevSelectedId) || null;
    filterSources(S.activeTab);
    // Start live-refresh so new windows appearing get picked up automatically
    _startSourceRefresh();
  } catch(e) {
    grid.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 0;gap:8px">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(255,80,80,.55)" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span style="font-size:10px;color:rgba(255,255,255,.25)">${e.message}</span>
        <button onclick="loadSources()" style="
          padding:5px 14px;border-radius:6px;font-size:10px;font-weight:600;
          background:rgba(94,234,212,.08);border:1px solid rgba(94,234,212,.18);
          color:rgba(94,234,212,.7);cursor:pointer">↻ Retry</button>
      </div>`;
  }
}

function _startSourceRefresh() {
  clearInterval(_sourceRefreshTimer);
  // Silent refresh every 4 seconds while not recording
  _sourceRefreshTimer = setInterval(async () => {
    if (S.isRec) { clearInterval(_sourceRefreshTimer); return; }
    try {
      const fresh = await sf.getSources();
      const prevId = S.selected?.id;
      S.sources = fresh;
      S.selected = fresh.find(s => s.id === prevId) || S.selected;
      filterSources(S.activeTab);
    } catch {}
  }, 4000);
}

function reloadSources() { S.sources = []; loadSources(); }

function filterSources(type) {
  S.activeTab = type;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.remove('tab-active'); b.classList.add('text-muted');
  });
  const tab = $(`tab-${type}`);
  if (tab) { tab.classList.add('tab-active'); tab.classList.remove('text-muted'); }
  S.filtered = S.sources.filter(s => type === 'screen' ? s.isScreen : !s.isScreen);
  renderSources();
  syncCaptureNav();
}

// Build the thumbnail cell: handles null thumbnails with icon or letter fallback
function _thumbCell(s) {
  if (s.thumbnail) {
    // Real thumbnail: show it, and on error fall back to icon/placeholder
    const iconFallback = s.appIcon
      ? `this.onerror=null;this.src='${s.appIcon}'`
      : `this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='flex'`;
    return `
      <img src="${s.thumbnail}"
        style="width:100%;height:100%;object-fit:cover;display:block;position:absolute;inset:0"
        onerror="${iconFallback}" alt="">
      <div style="display:none;position:absolute;inset:0;flex-direction:column;align-items:center;justify-content:center;gap:6px">
        ${_placeholderCell(s)}
      </div>`;
  }
  // No thumbnail at all: show app icon or initial letter
  if (s.appIcon) {
    return `<img src="${s.appIcon}" style="width:48px;height:48px;object-fit:contain;border-radius:12px;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)" alt="">`;
  }
  return _placeholderCell(s);
}

function _placeholderCell(s) {
  const initial = (s.name || '?')[0].toUpperCase();
  const colors  = ['#3b82f6','#8b5cf6','#ec4899','#10b981','#f59e0b','#6366f1'];
  const color   = colors[initial.charCodeAt(0) % colors.length];
  const icon    = s.isScreen
    ? `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`
    : `<div style="width:40px;height:40px;border-radius:12px;background:${color};display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;color:#fff">${initial}</div>`;
  return icon;
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
    return `
      <div class="src-card ${isSelected ? 'selected' : ''}" onclick="selectSource(${i})" style="cursor:pointer">
        <div style="position:relative;overflow:hidden;aspect-ratio:16/9;background:#0a0c12;border-radius:8px 8px 0 0">
          ${_thumbCell(s)}
          ${isSelected ? '<div style="position:absolute;inset:0;background:rgba(94,234,212,.07);border-radius:8px 8px 0 0"></div>' : ''}
          ${s.isScreen ? `<div style="position:absolute;top:5px;left:5px;background:rgba(0,0,0,.6);border-radius:4px;padding:2px 5px;font-size:9px;font-weight:700;color:rgba(255,255,255,.6);letter-spacing:.04em">DISPLAY</div>` : ''}
        </div>
        <div style="padding:5px 9px 7px;display:flex;align-items:center;gap:6px;min-width:0">
          ${s.appIcon && !s.isScreen ? `<img src="${s.appIcon}" style="width:14px;height:14px;border-radius:3px;flex-shrink:0;object-fit:contain" onerror="this.style.display='none'" alt="">` : ''}
          <p style="font-size:11px;color:rgba(255,255,255,${isSelected ? '.85' : '.42'});white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0;font-weight:${isSelected ? '600' : '400'}">${s.name}</p>
        </div>
      </div>`;
  }).join('');

  if (!S.selected && S.filtered.length) selectSource(0);
}

function selectSource(i) {
  S.selected = S.filtered[i];
  S.sourceBounds = S.selected?.bounds || null;
  if (!S.selected?.isScreen) S.cfg.captureArea = null;
  sf.setSourceBounds(S.sourceBounds);
  renderSources();
  drawBgPreview();
  syncCaptureNav();
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SETTINGS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function toggleSetting(key) {
  S.cfg[key] = !S.cfg[key];
  $(`toggle-${key}`)?.classList.toggle('toggle-on', S.cfg[key]);
  if (key === 'frame' || key === 'pad') drawBgPreview();
  if (key === 'webcam') syncRecordMeBtn();
  syncCaptureNav();
  schedulePersist?.();
}

// ── "Record Me" quick-toggle ─────────────────────────────────────────────────
function toggleRecordMe() {
  S.cfg.webcam = !S.cfg.webcam;
  // Sync the side-panel webcam toggle too
  $('toggle-webcam')?.classList.toggle('toggle-on', S.cfg.webcam);
  syncCaptureNav();
  syncRecordMeBtn();
  schedulePersist?.();

  // If turning on, pre-warm the camera so there's no delay when recording starts
  if (S.cfg.webcam && !S.camStream) {
    const constraints = {
      audio: false,
      video: S.cfg.camDeviceId
        ? { deviceId: { exact: S.cfg.camDeviceId }, width: 640, height: 480 }
        : { width: 640, height: 480 }
    };
    navigator.mediaDevices.getUserMedia(constraints)
      .then(stream => { S.camStream = stream; })
      .catch(() => {});
  } else if (!S.cfg.webcam && S.camStream && !S.isRec) {
    // Release camera when turned off (and not recording)
    S.camStream.getTracks().forEach(t => t.stop());
    S.camStream = null;
  }
}

function syncRecordMeBtn() {
  const btn    = $('recordMeBtn');
  const icon   = $('recordMeIcon');
  const svg    = $('recordMeIconSvg');
  const label  = $('recordMeLabel');
  const sub    = $('recordMeSub');
  const status = $('recordMeStatus');
  if (!btn) return;

  if (S.cfg.webcam) {
    btn.classList.add('rmt-on');
    btn.style.background     = 'rgba(94,234,212,.08)';
    btn.style.borderColor    = 'rgba(94,234,212,.35)';
    icon.style.background    = 'rgba(94,234,212,.15)';
    svg.querySelector('rect,path') && (svg.querySelectorAll('[stroke]').forEach(el => el.setAttribute('stroke', '#6ee7b7')));
    // Re-color all stroked paths in the SVG
    svg.querySelectorAll('*').forEach(el => el.setAttribute('stroke', '#6ee7b7'));
    label.style.color        = '#6ee7b7';
    sub.textContent          = 'Record Me is ON. Camera will appear in a corner box';
    sub.style.color          = 'rgba(110,231,183,.45)';
    status.textContent       = 'ON';
    status.style.background  = 'rgba(94,234,212,.15)';
    status.style.color       = '#6ee7b7';
  } else {
    btn.classList.remove('rmt-on');
    btn.style.background     = 'rgba(255,255,255,.05)';
    btn.style.borderColor    = 'rgba(255,255,255,.1)';
    icon.style.background    = 'rgba(255,255,255,.07)';
    svg.querySelectorAll('*').forEach(el => el.setAttribute('stroke', 'rgba(255,255,255,.45)'));
    label.style.color        = 'rgba(255,255,255,.55)';
    sub.textContent          = 'Put your camera in a corner box';
    sub.style.color          = 'rgba(255,255,255,.25)';
    status.textContent       = 'OFF';
    status.style.background  = 'rgba(255,255,255,.06)';
    status.style.color       = 'rgba(255,255,255,.25)';
  }
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
    sf.setSourceBounds(S.sourceBounds);
    renderSources();
  }

  try {
    const result = await sf.selectCaptureArea(S.sourceBounds);
    if (!result?.captureArea) return;
    S.cfg.captureArea = sanitizeCaptureArea(result.captureArea);
    if (!S.cfg.captureArea) return;
    S.sourceBounds = result.sourceBounds || S.sourceBounds;
    sf.setSourceBounds(S.sourceBounds);
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
    $(id)?.classList.toggle('active', (key === 'display' ? 'screen' : key) === mode);
  });
  $('nav-camera')?.classList.toggle('active', !!S.cfg.webcam);
  $('nav-mic')?.classList.toggle('active', !!S.cfg.mic);
  $('nav-systemAudio')?.classList.toggle('active', !!S.cfg.systemAudio);
  if ($('navCameraText')) $('navCameraText').textContent = S.cfg.webcam ? 'Camera' : 'No camera';
  if ($('navMicText')) $('navMicText').textContent = S.cfg.mic ? 'Microphone' : 'No microphone';
  if ($('navSystemText')) $('navSystemText').textContent = S.cfg.systemAudio ? 'System audio' : 'No system audio';

  const chip = $('areaChip');
  if (chip) chip.style.display = S.cfg.captureArea ? 'flex' : 'none';
  if ($('areaChipText') && S.cfg.captureArea) {
    const a = S.cfg.captureArea;
    $('areaChipText').textContent = `Area ${Math.round(a.wPct * 100)}% x ${Math.round(a.hPct * 100)}%`;
  }
}

function setZoomLevel(level) {
  S.cfg.zoomLevel = level;
  document.querySelectorAll('.zoom-level-btn').forEach(b => {
    const on = b.id === `zl-${level}`;
    b.classList.toggle('active', on);
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
}

function eventTime(_payload) {
  if (!S.recPerfStartedAt) return 0;
  const pausedNow = S.recPausedAt ? performance.now() - S.recPausedAt : 0;
  return Math.max(0, (performance.now() - S.recPerfStartedAt - S.recPausedTotal - pausedNow) / 1000);
}

function normalizePoint(payload) {
  const b = payload?.bounds || S.sourceBounds;
  if (!b || !b.width || !b.height) return { xPct: 0.5, yPct: 0.5, inside: true };
  const xPct = (payload.x - b.x) / b.width;
  const yPct = (payload.y - b.y) / b.height;
  return {
    xPct: clamp(xPct, 0.04, 0.96),
    yPct: clamp(yPct, 0.06, 0.94),
    inside: xPct >= 0 && xPct <= 1 && yPct >= 0 && yPct <= 1,
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
  if (S.cfg.zoom) {
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


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RECORDING: direct stream capture (reliable even when window hides)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function startRecording() {
  if (!S.selected) {
    const first = S.sources.find(s => s.isScreen);
    if (first) { S.selected = first; S.sourceBounds = first.bounds || null; sf.setSourceBounds(S.sourceBounds); renderSources(); }
    else { alert('No source selected'); return; }
  }

  const btn = $('recordBtn');
  btn.disabled = true;

  try {
    btn.textContent = 'Choose source…';
    S.rawStream = await getDesktopCaptureStream();

    btn.textContent = 'Preparing inputs…';
    const micConstraints = S.cfg.micDeviceId
      ? { audio: { deviceId: { exact: S.cfg.micDeviceId } }, video: false }
      : { audio: true, video: false };
    S.micStream = S.cfg.mic ? await getOptionalMedia(micConstraints) : null;

    // Webcam with specific device if selected
    const camConstraints = {
      audio: false,
      video: S.cfg.camDeviceId
        ? { deviceId: { exact: S.cfg.camDeviceId }, width: 640, height: 480 }
        : { width: 640, height: 480 }
    };
    S.camStream = S.cfg.webcam ? (S.camStream || await getOptionalMedia(camConstraints)) : null;

    const cdSecs = S.cfg.countdown ?? 3;
    await runPrepCountdown(cdSecs, (remaining) => {
      btn.textContent = cdSecs > 0 ? `Recording in ${remaining}…` : 'Starting…';
    });
    btn.textContent = 'Starting…';

    S.chunks = [];
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
                   .find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';

    const needsCanvasComposite = !!S.camStream || !!S.cfg.captureArea;
    const recordStream = needsCanvasComposite ? await buildCompositedStream(S.rawStream, S.camStream) : new MediaStream(S.rawStream.getVideoTracks());
    const mixedAudio = mixAudioTracks([S.rawStream, S.micStream].filter(Boolean));
    for (const track of mixedAudio?.getAudioTracks?.() || []) recordStream.addTrack(track);

    const qualityBitrates = { draft: 4_000_000, good: 8_000_000, high: 12_000_000, ultra: 20_000_000, lossless: 40_000_000 };
    const videoBitsPerSecond = qualityBitrates[S.cfg.quality] || 12_000_000;

    S.recorder = new MediaRecorder(recordStream, {
      mimeType: mime,
      videoBitsPerSecond,
    });
    S.recorder.ondataavailable = e => { if (e.data.size > 0) S.chunks.push(e.data); };
    S.recorder.onstop          = finishRecording;

    // Collect a chunk every 250 ms so we don't lose data if the renderer stops
    resetInteractionCapture();
    S.recorder.start(250);
    S.isRec = true;
    startAutoSave();
    startStatsPolling();
    startAnnotationLayer();

    // Get session ID for WS broadcast
    const sessionId = window.sf?.newSessionId ? await sf.newSessionId() : `sess-${Date.now()}`;
    S.recSessionId = sessionId;

    // Stop live source refresh while recording
    clearInterval(_sourceRefreshTimer);
    // Hide main window and show floating pill bar
    sf.startCursorPoll();
    sf.recordingStarted({ sessionId });

  } catch(e) {
    cleanupCaptureStreams();
    btn.disabled = false; btn.textContent = 'Start Intelligent Recording';
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
  sf.stopCursorPoll();
  if (S.recorder?.state !== 'inactive') S.recorder.stop();
  // Resume live source refresh after recording ends
  setTimeout(_startSourceRefresh, 2000);
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
  if (!IS_ELECTRON || S.selected?.browserFallback) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('This browser cannot capture the screen. Run `npm start` and use the Electron app.');
    }
    return withTimeout(navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: S.cfg.fps || 60 },
      audio: !!S.cfg.systemAudio,
    }), 20000, 'Screen capture permission timed out');
  }

  const fps = S.cfg.fps || 60;
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
        maxWidth: 3840, maxHeight: 2160,
        minFrameRate: 15, maxFrameRate: fps,
      }
    }
  });

  try {
    return await withTimeout(
      navigator.mediaDevices.getUserMedia(constraints(!!S.cfg.systemAudio)),
      15000,
      'Screen capture timed out'
    );
  } catch (e) {
    if (!S.cfg.systemAudio) throw e;
    console.warn('System audio capture unavailable, retrying video-only:', e.message);
    return withTimeout(
      navigator.mediaDevices.getUserMedia(constraints(false)),
      15000,
      'Screen capture timed out'
    );
  }
}

function mixAudioTracks(streams) {
  const tracks = streams.flatMap(stream => stream?.getAudioTracks?.() || []);
  if (!tracks.length) return null;
  if (tracks.length === 1) return new MediaStream([tracks[0]]);

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return new MediaStream(tracks);

  const ctx = new AudioCtx();
  const destination = ctx.createMediaStreamDestination();
  for (const track of tracks) {
    const stream = new MediaStream([track]);
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = 1 / Math.sqrt(tracks.length);
    source.connect(gain).connect(destination);
  }
  return destination.stream;
}

async function buildCompositedStream(screenStream, camStream) {
  const screenVideo = document.createElement('video');
  screenVideo.srcObject = screenStream;
  screenVideo.muted = true;
  await playMediaElement(screenVideo, 'Screen preview did not start');

  let camVideo = null;
  if (camStream) {
    camVideo = document.createElement('video');
    camVideo.srcObject = camStream;
    camVideo.muted = true;
    await playMediaElement(camVideo, 'Camera preview did not start');
  }

  const canvas = $('recCanvas');
  const settings = screenStream.getVideoTracks()[0]?.getSettings?.() || {};
  const sourceW = settings.width || 1920;
  const sourceH = settings.height || 1080;
  const area = captureAreaPx(sourceW, sourceH);
  canvas.width = area.w;
  canvas.height = area.h;
  const ctx = canvas.getContext('2d');

  const draw = () => {
    if (!S.rawStream) return;
    ctx.drawImage(screenVideo, area.x, area.y, area.w, area.h, 0, 0, canvas.width, canvas.height);
    if (camVideo) drawWebcamBubble(ctx, camVideo, canvas.width, canvas.height);
    S.drawLoop = requestAnimationFrame(draw);
  };
  draw();

  S.canvasStream = canvas.captureStream(S.cfg.fps || 60);
  return S.canvasStream;
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
  ctx.drawImage(camVideo, x, y, bubbleW, bubbleH);
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
  if (window.sf?.sendPauseState) sf.sendPauseState(S.isPaused);
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
  sf.recordingStopped();

  const btn = $('recordBtn');
  btn.disabled = true; btn.textContent = 'Processing…';

  try {
    const blob    = new Blob(S.chunks, { type: 'video/webm' });
    const ab      = await blob.arrayBuffer();
    const outPath = await sf.saveRecording({ buffer: ab, hasPad: S.cfg.pad });
    // Clean up auto-save recovery file after successful save
    if (S.recSessionId && window.sf?.deleteRecoverySession) {
      sf.deleteRecoverySession(`recovery-${S.recSessionId}.webm`).catch(() => {});
    }
    // Auto-save to clip library if enabled
    if (S.cfg.autoSaveToLibrary !== false && window.sf?.saveToLibrary) {
      sf.saveToLibrary({ sourcePath: outPath, title: `Recording ${new Date().toLocaleString()}` })
        .then(() => refreshClipLibrary())
        .catch(() => {});
    }
    const capturedKeyframes = [...S.keyframes].sort((a, b) => a.time - b.time);
    btn.disabled = false; btn.textContent = 'Start Intelligent Recording';
    openEditor(outPath, capturedKeyframes, structuredClone(S.recEvents));
  } catch(e) {
    btn.disabled = false; btn.textContent = 'Start Intelligent Recording';
    alert('Save failed: ' + e.message);
  }
}

function cleanupCaptureStreams() {
  S.rawStream?.getTracks().forEach(t => t.stop());
  S.micStream?.getTracks().forEach(t => t.stop());
  S.camStream?.getTracks().forEach(t => t.stop());
  S.canvasStream?.getTracks().forEach(t => t.stop());
  if (S.drawLoop) cancelAnimationFrame(S.drawLoop);
  S.rawStream = null;
  S.micStream = null;
  S.camStream = null;
  S.canvasStream = null;
  S.drawLoop = null;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  EDITOR
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function openEditor(videoPath, keyframes = [], recEvents = null) {
  S.videoPath = videoPath;
  S.keyframes = keyframes;
  S.recEvents = recEvents || { clicks: [], keys: [], cursor: [] };
  S.transcript = { text: '', cues: [] };
  S.adj        = { b: 0, c: 0, s: 0 };
  S.cuts       = [];
  S.blurZones  = [];
  S.razorMode  = false;

  showScreen('editor');

  const vid = $('videoPreview');
  vid.src = /^(blob:|data:|https?:|file:)/.test(videoPath) ? videoPath : `file://${videoPath}`;
  vid.style.filter = '';
  vid.load();

  ['brightness','contrast','saturation'].forEach(k => {
    const el = $(k); if (el) el.value = 0;
    const vl = $(k + 'Val'); if (vl) vl.textContent = '0';
  });

  try {
    const info = await sf.probeVideo(videoPath);
    S.videoW = info.width || 0;
    S.videoH = info.height || 0;
    if (info.duration > 0) { S.dur = info.duration; onVideoLoaded(); }
  } catch {}

  renderKfLists();
}

async function importVideo() {
  try {
    const filePath = await sf.openVideoFile();
    if (filePath) openEditor(filePath, [], { clicks: [], keys: [], cursor: [] });
  } catch (e) {
    alert('Import failed: ' + e.message);
  }
}

function currentProject() {
  return {
    version: 2,
    savedAt: new Date().toISOString(),
    videoPath: S.videoPath,
    duration: S.dur,
    videoW: S.videoW,
    videoH: S.videoH,
    trimIn: S.trimIn,
    trimOut: S.trimOut,
    keyframes: S.keyframes,
    cuts: S.cuts,
    blurZones: S.blurZones,
    recEvents: S.recEvents,
    adj: S.adj,
    cfg: S.cfg,
    bgPreset: S.bgPreset,
    transcript: S.transcript,
  };
}

async function saveProject() {
  if (!S.videoPath) { alert('Record or import a video first.'); return; }
  try {
    const out = await sf.saveProjectFile(currentProject());
    if (out) alert('Project saved.');
  } catch (e) {
    alert('Project save failed: ' + e.message);
  }
}

async function openProject() {
  try {
    const data = await sf.openProjectFile();
    if (!data?.project?.videoPath) return;
    const p = data.project;
    Object.assign(S.cfg, p.cfg || {});
    S.bgPreset = Number(p.bgPreset || 0);
    S.transcript = p.transcript || { text: '', cues: [] };
    await openEditor(p.videoPath, p.keyframes || [], p.recEvents || { clicks: [], keys: [], cursor: [] });
    S.transcript = p.transcript || { text: '', cues: [] };
    S.adj        = p.adj  || { b: 0, c: 0, s: 0 };
    S.cuts       = p.cuts || [];
    S.blurZones  = p.blurZones || [];
    S.trimIn = Number(p.trimIn || 0);
    S.trimOut = Number(p.trimOut || S.dur || 0);
    updateTrimHandles();
    updateTrimDisplay();
    drawKfLayer();
    renderKfLists();
    syncConfigControls();
  } catch (e) {
    alert('Project open failed: ' + e.message);
  }
}

function syncConfigControls() {
  for (const key of ['zoom','cursor','pad','shortcuts','clickRings','mic','systemAudio','audioCleanup','webcam','captions']) {
    const el = $(`toggle-${key}`);
    if (el) el.classList.toggle('toggle-on', !!S.cfg[key]);
  }
  if ($('cursorTheme')) $('cursorTheme').value = S.cfg.cursorTheme || 'accent';
  if ($('cursorSize')) $('cursorSize').value = S.cfg.cursorSize || 1;
  if ($('webcamPos')) $('webcamPos').value = S.cfg.webcamPos || 'br';
  if ($('webcamShape')) $('webcamShape').value = S.cfg.webcamShape || 'rounded';
  if ($('fpsSelect')) $('fpsSelect').value = S.cfg.fps || 60;
  if ($('qualitySelect')) $('qualitySelect').value = S.cfg.quality || 'high';
  if ($('countdownSelect')) $('countdownSelect').value = S.cfg.countdown ?? 3;
  setZoomLevel(S.cfg.zoomLevel || 2);
  if ($('brightness')) $('brightness').value = S.adj.b || 0;
  if ($('contrast')) $('contrast').value = S.adj.c || 0;
  if ($('saturation')) $('saturation').value = S.adj.s || 0;
  if ($('brightnessVal')) $('brightnessVal').textContent = S.adj.b || 0;
  if ($('contrastVal')) $('contrastVal').textContent = S.adj.c || 0;
  if ($('saturationVal')) $('saturationVal').textContent = S.adj.s || 0;
  if ($('videoPreview')) updateAdjust();
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
  el.innerHTML = devices.map(d =>
    `<option value="${d.deviceId}" ${d.deviceId === selected ? 'selected' : ''}>
       ${d.label || (d.kind === 'audioinput' ? 'Microphone' : 'Camera') + ' ' + (devices.indexOf(d) + 1)}
     </option>`
  ).join('');
  if (!el.innerHTML) el.innerHTML = '<option value="">Default</option>';
}

function setMicDevice(id) { S.cfg.micDeviceId = id; }
function setCamDevice(id) { S.cfg.camDeviceId = id; }
function setFps(fps) { S.cfg.fps = Number(fps); }
function setQuality(q) { S.cfg.quality = q; }
function setCountdown(n) {
  S.cfg.countdown = Number(n);
  S.cfg.countdownDefaultVersion = 2;
}
function setWebcamShape(shape) { S.cfg.webcamShape = shape; }
function setWebcamBorderColor(color) { S.cfg.webcamBorderColor = color; }
function setSpeedMultiplier(v) { S.cfg.speedMultiplier = Number(v); }

async function chooseOutputDir() {
  const dir = await sf.chooseOutputDir();
  if (dir) {
    S.cfg.outputDir = dir;
    const el = $('outputDirLabel');
    if (el) el.textContent = dir.split('/').pop() || dir;
  }
}

// ── Crash recovery ────────────────────────────────────────────────────────────

async function checkRecoverySessions() {
  if (!window.sf?.listRecoverySessions) return;
  const sessions = await sf.listRecoverySessions();
  if (!sessions.length) return;
  const panel = $('recoveryPanel');
  if (!panel) return;
  panel.classList.remove('hidden');
  const list = $('recoveryList');
  if (list) {
    list.innerHTML = sessions.map(s => {
      const mb = (s.size / 1024 / 1024).toFixed(1);
      const dt = new Date(s.mtime).toLocaleString();
      return `<div class="flex items-center gap-2 py-1.5 px-2 rounded-lg"
                   style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06)">
        <div class="flex-1 min-w-0">
          <div class="text-[11px] font-semibold" style="color:rgba(255,255,255,.8)">${mb} MB · ${dt}</div>
        </div>
        <button onclick="recoverSession('${s.path}')" class="nd px-2 py-1 rounded text-[10px] font-bold"
          style="background:rgba(96,165,250,.15);color:#60a5fa;border:1px solid rgba(96,165,250,.3)">Recover</button>
        <button onclick="dismissRecovery('${s.path}')" class="nd px-2 py-1 rounded text-[10px]"
          style="background:rgba(255,255,255,.06);color:rgba(255,255,255,.4)">Dismiss</button>
      </div>`;
    }).join('');
  }
}

async function recoverSession(filePath) {
  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Converting…'; }
  try {
    const outPath = await sf.saveRecording({ buffer: null, hasPad: false, recoveryPath: filePath });
    await sf.deleteRecoverySession(filePath);
    const panel = $('recoveryPanel');
    if (panel) panel.classList.add('hidden');
    openEditor(outPath, [], { clicks: [], keys: [], cursor: [] });
  } catch (e) {
    alert('Recovery failed: ' + e.message);
  }
}

async function dismissRecovery(filePath) {
  await sf.deleteRecoverySession(filePath);
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
      await sf.autoSaveChunk({ buffer: ab, sessionId: S.recSessionId });
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
    const outPath = await sf.takeScreenshot();
    if (outPath) {
      showFloatToast('📸 Screenshot saved');
    }
  } catch {}
}

function showFloatToast(msg) {
  let toast = $('floatToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'floatToast';
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

function addBlurZone() {
  const vid = $('videoPreview');
  if (!vid || !S.dur) return;
  const t = vid.currentTime;
  const radius = parseInt($('blurRadiusSlider')?.value || 20);
  S.blurZones.push({
    id: Date.now(),
    startTime: t,
    endTime: Math.min(t + 3, S.dur),
    xPct: 0.1, yPct: 0.1, wPct: 0.3, hPct: 0.2,
    radius,
  });
  renderBlurZoneList();
  drawKfLayer();
}

function removeBlurZone(id) {
  S.blurZones = S.blurZones.filter(z => z.id !== id);
  renderBlurZoneList();
  drawKfLayer();
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
         style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05)">
      <div class="flex-1 min-w-0">
        <div class="text-[11px] font-mono font-bold" style="color:rgba(139,92,246,.9)">
          ${fmtTime(z.startTime)} → ${fmtTime(z.endTime)}
        </div>
        <div class="text-[10px]" style="color:rgba(255,255,255,.3)">
          ${Math.round(z.wPct*100)}×${Math.round(z.hPct*100)}% · blur ${z.radius}px
        </div>
      </div>
      <button onclick="seekToBlur(${z.id})" title="Preview"
              class="w-6 h-6 flex items-center justify-center rounded text-[11px]"
              style="color:rgba(139,92,246,.7);background:rgba(139,92,246,.1)">▶</button>
      <button onclick="removeBlurZone(${z.id})" title="Remove"
              class="w-6 h-6 flex items-center justify-center rounded text-[11px]"
              style="color:rgba(248,113,113,.7);background:rgba(248,113,113,.1)">×</button>
    </div>`).join('');
}

function seekToBlur(id) {
  const z = S.blurZones.find(x => x.id === id);
  if (z) $('videoPreview').currentTime = z.startTime;
}

function buildBlurFilters() {
  if (!S.blurZones?.length) return '';
  return S.blurZones.map(z =>
    `boxblur=luma_radius=${z.radius}:luma_power=1` +
    `:x=${Math.round(z.xPct * 100)}%*iw/100` +
    `:y=${Math.round(z.yPct * 100)}%*ih/100` +
    `:w=${Math.round(z.wPct * 100)}%*iw/100` +
    `:h=${Math.round(z.hPct * 100)}%*ih/100` +
    `:enable='between(t\\,${z.startTime.toFixed(2)}\\,${z.endTime.toFixed(2)})'`
  ).join(',');
}

function backToRecorder() {
  $('videoPreview').pause();
  $('videoPreview').src = '';
  showScreen('recorder');
  $('recordBtn').disabled = false;
  $('recordBtn').textContent = 'Start Intelligent Recording';
}

function showScreen(which) {
  const isEd = which === 'editor';
  $('screenRecorder').classList.toggle('hidden',  isEd);
  $('screenRecorder').classList.toggle('flex',   !isEd);
  $('screenEditor').classList.toggle('hidden',   !isEd);
  $('screenEditor').classList.toggle('flex',      isEd);
  if (isEd) {
    initInspBgGrid();          // populate gradient thumbnail grid
    switchInspPanel('bg');     // default to Background panel
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PLAYBACK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onVideoLoaded() {
  const vid = $('videoPreview');
  if (!S.dur) S.dur = vid.duration || 0;
  S.trimIn  = 0;
  S.trimOut = S.dur;
  $('totalTime').textContent = fmtTime(S.dur);
  updateTrimDisplay(); updateTrimHandles(); drawRuler(); drawKfLayer();
}

function togglePlay() {
  const vid = $('videoPreview'), btn = $('playBtn');
  if (vid.paused) {
    if (vid.currentTime >= S.trimOut) vid.currentTime = S.trimIn;
    vid.play(); btn.textContent = '⏸';
  } else { vid.pause(); btn.textContent = '▶'; }
}

function seekRelative(dt) {
  const vid = $('videoPreview');
  vid.currentTime = clamp(vid.currentTime + dt, S.trimIn, S.trimOut);
}

function scrubClick(e) {
  const rect = $('scrubBar').getBoundingClientRect();
  const pct  = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  const t    = S.trimIn + pct * (S.trimOut - S.trimIn);
  $('videoPreview').currentTime = t;
  renderTextOverlays(t);
}

function setSpeed() {
  $('videoPreview').playbackRate = parseFloat($('speedSelect').value);
}

function toggleMute() {
  const vid = $('videoPreview');
  vid.muted = !vid.muted;
  $('muteBtn').textContent = vid.muted ? '🔇' : '🔊';
}

function onTimeUpdate() {
  const vid = $('videoPreview'), t = vid.currentTime;
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
  renderTextOverlays(t);
  renderCursorPreview(t);
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

function endTrimDrag() { S.isDragTrim = null; }

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
}

// ── Clip editing actions ──────────────────────────────────────────────────────

function setInPoint() {
  const vid = $('videoPreview');
  if (!vid || !S.dur) return;
  S.trimIn = clamp(vid.currentTime, 0, S.trimOut - 0.25);
  updateTrimHandles(); updateTrimDisplay();
}

function setOutPoint() {
  const vid = $('videoPreview');
  if (!vid || !S.dur) return;
  S.trimOut = clamp(vid.currentTime, S.trimIn + 0.25, S.dur);
  updateTrimHandles(); updateTrimDisplay();
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
}

function frameStep(dir) {
  const vid = $('videoPreview');
  if (!vid) return;
  vid.currentTime = clamp(vid.currentTime + dir / 30, S.trimIn, S.trimOut);
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

function endMiniTrimDrag() { _miniSide = null; }

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
}

function removeCut(t) {
  S.cuts = S.cuts.filter(c => Math.abs(c - t) > 0.01);
  drawKfLayer();
  renderCutList();
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
  el.innerHTML = activeCuts.map((t, i) => {
    const next = i < activeCuts.length - 1 ? activeCuts[i + 1] : S.trimOut;
    const segLen = fmtTime(next - t);
    return `
    <div class="flex items-center gap-1.5 px-2.5 py-2 rounded-lg group nd"
         style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05)">
      <button onclick="$('videoPreview').currentTime=${t};renderTextOverlays(${t})"
              class="flex items-center gap-1.5 flex-1 text-left" title="Jump to cut">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(248,113,113,.55)" stroke-width="2" stroke-linecap="round" style="flex-shrink:0"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/></svg>
        <span class="text-[12px] font-mono font-bold" style="color:rgba(255,255,255,.75)">${fmtTime(t)}</span>
        <span class="text-[10px] font-mono" style="color:rgba(255,255,255,.2)">+${segLen}</span>
      </button>
      <button onclick="removeCut(${t})"
              class="w-6 h-6 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity"
              style="color:rgba(248,113,113,.7);background:rgba(248,113,113,.1)"
              title="Remove cut">×</button>
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
      // Screen Studio style: "1s", "2s", "5s", integer seconds when step >= 1
      const lbl = (step >= 1 && Number.isInteger(t)) ? `${t}s` : fmtTime(t);
      ctx.fillText(lbl, x, H * 0.22);
    }
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  KEYFRAMES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function addZoomKeyframe() {
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
  $('textModal').classList.remove('hidden');
  setTimeout(() => $('textContent')?.focus(), 60);
}

function closeTextModal() {
  $('textModal').classList.add('hidden');
}

function renderPresetGrid() {
  const grid = $('presetGrid');
  if (!grid) return;
  grid.innerHTML = PRESETS.map(p => `
    <div id="pcard-${p.id}" onclick="selectPreset('${p.id}')"
      class="preset-card rounded-lg overflow-hidden border border-border cursor-pointer transition-all"
      style="background:#080c14;position:relative;aspect-ratio:16/9;">
      ${p.card}
      <div style="position:absolute;bottom:0;left:0;right:0;
           background:linear-gradient(transparent,rgba(0,0,0,.7));
           padding:2px 4px 3px;text-align:center;">
        <span style="font:600 7px/1 Inter,sans-serif;color:rgba(255,255,255,.7);letter-spacing:.4px;text-transform:uppercase">${p.label}</span>
      </div>
    </div>`).join('');
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

  S.textStyle = { bold: !!p.bold, italic: !!p.italic, shadow: !!p.shadow, outline: !!(p.outline) };
  S.textPos   = p.position;

  ['bold','italic','shadow','outline'].forEach(k => {
    const btn = $(`btn-${k}`);
    if (!btn) return;
    btn.classList.toggle('border-blue',   S.textStyle[k]);
    btn.classList.toggle('text-blue',     S.textStyle[k]);
    btn.classList.toggle('border-border', !S.textStyle[k]);
    btn.classList.toggle('text-muted',    !S.textStyle[k]);
  });

  document.querySelectorAll('.pos-btn').forEach(b => {
    b.classList.remove('border-blue','text-blue');
    b.classList.add('border-border','text-muted');
  });
  const posBtn = $(`pos-${p.position}`);
  if (posBtn) { posBtn.classList.add('border-blue','text-blue'); posBtn.classList.remove('border-border','text-muted'); }

  document.querySelectorAll('.preset-card').forEach(c => {
    const on = c.id === `pcard-${id}`;
    c.style.borderColor = on ? '#4da6ff' : '';
    c.style.boxShadow   = on ? '0 0 0 1px #4da6ff' : '';
  });

  liveTextPreview();
}

function toggleTextStyle(key) {
  S.textStyle[key] = !S.textStyle[key];
  const btn = $(`btn-${key}`);
  if (btn) {
    btn.classList.toggle('border-blue',   S.textStyle[key]);
    btn.classList.toggle('text-blue',     S.textStyle[key]);
    btn.classList.toggle('border-border', !S.textStyle[key]);
    btn.classList.toggle('text-muted',    !S.textStyle[key]);
  }
  liveTextPreview();
}

function setTextPos(pos) {
  S.textPos = pos;
  document.querySelectorAll('.pos-btn').forEach(b => {
    b.classList.remove('border-blue','text-blue');
    b.classList.add('border-border','text-muted');
  });
  const btn = $(`pos-${pos}`);
  if (btn) { btn.classList.add('border-blue','text-blue'); btn.classList.remove('border-border','text-muted'); }
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

  el.textContent      = txt;
  el.style.fontFamily = font;
  el.style.fontSize   = scaledSize + 'px';
  el.style.fontWeight = S.textStyle.bold   ? '700'    : '400';
  el.style.fontStyle  = S.textStyle.italic ? 'italic' : 'normal';
  el.style.color      = color;

  if (S.textStyle.outline) {
    el.style.textShadow = `-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000`;
  } else if (S.textStyle.shadow) {
    el.style.textShadow = '0 2px 8px rgba(0,0,0,.95),0 1px 2px rgba(0,0,0,.8)';
  } else {
    el.style.textShadow = 'none';
  }

  if (bgOp > 0) {
    const r = parseInt(bgColor.slice(1,3),16);
    const g = parseInt(bgColor.slice(3,5),16);
    const b = parseInt(bgColor.slice(5,7),16);
    el.style.backgroundColor = `rgba(${r},${g},${b},${bgOp})`;
    el.style.padding         = '2px 8px';
    el.style.borderRadius    = '4px';
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
}

function confirmText() {
  const txt = ($('textContent')?.value || '').trim();
  if (!txt) { closeTextModal(); return; }

  const startTime = parseFloat($('textStartTime')?.value ?? 0);
  const duration  = parseInt($('textDuration')?.value  || 4);
  const fadeIn    = parseFloat($('textFadeIn')?.value  || 0.3);
  const fadeOut   = parseFloat($('textFadeOut')?.value || 0.3);

  const kf = {
    id:        Date.now(),
    type:      'text',
    time:      Math.max(0, startTime),
    duration,
    fadeIn:    Math.min(fadeIn,  duration * 0.45),
    fadeOut:   Math.min(fadeOut, duration * 0.45),
    text:      txt,
    font:      $('textFont')?.value    || 'Inter,sans-serif',
    size:      parseInt($('textSize')?.value || 32),
    bold:      S.textStyle.bold,
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

  // Cut markers on the video track: click to remove
  const cutHtml = (S.cuts || []).map(t => {
    const pct = (t / S.dur) * 100;
    return `<div class="cut-marker" style="left:${pct}%"
      title="Cut @ ${fmtTime(t)}: click to remove"
      onclick="event.stopPropagation();removeCut(${t})"></div>`;
  }).join('');

  if (layer) layer.innerHTML = cutHtml;

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
      return `<div style="position:absolute;left:${pct}%;top:50%;
                   transform:translate(-50%,-50%);
                   width:10px;height:10px;border-radius:50%;
                   background:${color};border:1.5px solid #06070d;
                   cursor:pointer;z-index:20;pointer-events:auto;"
                class="keyframe-dot" title="${lbl}: click to remove"
                onclick="event.stopPropagation();removeKeyframe(${kf.id})"></div>`;
    }).join('');
  }
}

function renderKfLists() {
  const zooms  = S.keyframes.filter(k => k.type === 'zoom');
  const texts  = S.keyframes.filter(k => k.type === 'text' || k.type === 'caption');
  const events = S.keyframes.filter(k => k.type === 'key' || k.type === 'click' || k.type === 'marker');

  // Update count badges
  const zc = $('zoomCount'); if (zc) zc.textContent = zooms.length + ' kf';
  const tc = $('textCount'); if (tc) tc.textContent = texts.length + ' overlay' + (texts.length !== 1 ? 's' : '');

  const itemStyle = 'display:flex;justify-content:space-between;align-items:center;padding:4px 8px;border-radius:8px;background:rgba(255,255,255,.03);margin-bottom:3px';
  const monoStyle = (color) => `font-size:11px;font-family:monospace;color:${color}`;
  const lblStyle  = 'font-size:11px;color:rgba(255,255,255,.4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80px';
  const rmBtn     = (id) => `<button onclick="removeKeyframe(${id})" style="font-size:13px;color:rgba(248,113,113,.5);line-height:1" onmouseover="this.style.color='rgba(248,113,113,1)'" onmouseout="this.style.color='rgba(248,113,113,.5)'">×</button>`;

  const zl = $('zoomKfList');
  if (zl) zl.innerHTML = zooms.length
    ? zooms.map(k => `<div style="${itemStyle}">
        <span style="${monoStyle('rgba(251,191,36,.8)')}">${fmtTime(k.time)}</span>
        <span style="${lblStyle}">${k.zoomLevel}×${k.source === 'auto-click' ? ' auto' : ''}</span>
        ${rmBtn(k.id)}
      </div>`).join('')
    : '<p style="font-size:11px;font-style:italic;color:rgba(255,255,255,.2)">None yet</p>';

  const tl = $('textKfList');
  if (tl) tl.innerHTML = texts.length
    ? texts.map(k => `<div style="${itemStyle}">
        <span style="${monoStyle('rgba(74,222,128,.8)')}">${fmtTime(k.time)}</span>
        <span style="${lblStyle}">${k.text}</span>
        ${rmBtn(k.id)}
      </div>`).join('')
    : '<p style="font-size:11px;font-style:italic;color:rgba(255,255,255,.2)">None yet</p>';

  const el = $('eventKfList');
  if (el) el.innerHTML = events.length
    ? events.slice(0, 20).map(k => {
        const col = k.type === 'key' ? 'rgba(129,140,248,.8)' : k.type === 'marker' ? 'rgba(167,139,250,.8)' : 'rgba(248,113,113,.8)';
        const lbl = k.type === 'key' ? k.label : k.type === 'marker' ? k.label : 'click';
        return `<div style="${itemStyle}">
          <span style="${monoStyle(col)}">${fmtTime(k.time)}</span>
          <span style="${lblStyle}">${lbl}</span>
          ${rmBtn(k.id)}
        </div>`;
      }).join('')
    : '<p style="font-size:11px;font-style:italic;color:rgba(255,255,255,.2)">None yet</p>';

  renderCutList();
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TEXT OVERLAY PREVIEW  (CSS-based, live in video area)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Container is #previewArea; we inject <div> overlays into it
let _overlayEls = {};

function renderTextOverlays(t) {
  const area = $('previewArea');
  if (!area) return;

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
    if (!el) {
      el = document.createElement('div');
      el.style.cssText = `
        position:absolute; pointer-events:none; select:none; z-index:10;
        max-width:80%; word-break:break-word; text-align:center;
        transition: opacity .3s, transform .3s;
      `;
      area.appendChild(el);
      _overlayEls[kf.id] = el;
    }

    if (kf.type === 'key') {
      el.textContent = kf.label;
      el.style.fontFamily = 'Inter,sans-serif';
      el.style.fontSize = '28px';
      el.style.fontWeight = '800';
      el.style.fontStyle = 'normal';
      el.style.letterSpacing = '0';
      el.style.color = '#dce8f8';
      el.style.backgroundColor = 'rgba(9,13,24,.82)';
      el.style.border = '1px solid rgba(56,217,245,.38)';
      el.style.boxShadow = '0 18px 44px rgba(0,0,0,.36), inset 0 1px 0 rgba(255,255,255,.08)';
      el.style.padding = '10px 16px';
      el.style.borderRadius = '14px';
      positionOverlay(el, 'bc');
    } else if (kf.type === 'click') {
      el.textContent = '';
      el.style.width = '52px';
      el.style.height = '52px';
      el.style.borderRadius = '999px';
      el.style.border = '3px solid rgba(248,113,113,.92)';
      el.style.boxShadow = '0 0 0 14px rgba(248,113,113,.14), 0 0 36px rgba(248,113,113,.35)';
      el.style.backgroundColor = 'transparent';
      el.style.padding = '0';
      el.style.left = (kf.xPct * 100) + '%';
      el.style.top = (kf.yPct * 100) + '%';
      el.style.right = el.style.bottom = 'auto';
      el.style.transform = 'translate(-50%,-50%)';
    } else {
      el.textContent = kf.text;
      el.style.fontFamily  = kf.font;
      el.style.fontSize    = kf.size + 'px';
      el.style.fontWeight  = kf.bold   ? 'bold'   : 'normal';
      el.style.fontStyle   = kf.italic ? 'italic' : 'normal';
      el.style.color       = kf.color;

      if (kf.outline) {
        el.style.textShadow = `-2px -2px 0 #000,2px -2px 0 #000,-2px 2px 0 #000,2px 2px 0 #000`;
      } else if (kf.shadow) {
        el.style.textShadow = '0 3px 12px rgba(0,0,0,.95),0 1px 3px rgba(0,0,0,.8)';
      } else {
        el.style.textShadow = 'none';
      }

      if (kf.bgOpacity > 0) {
        const r = parseInt(kf.bgColor.slice(1,3),16);
        const g = parseInt(kf.bgColor.slice(3,5),16);
        const b = parseInt(kf.bgColor.slice(5,7),16);
        el.style.backgroundColor = `rgba(${r},${g},${b},${kf.bgOpacity/100})`;
        el.style.padding         = '6px 14px';
        el.style.borderRadius    = '6px';
      } else {
        el.style.backgroundColor = 'transparent';
        el.style.padding         = '0';
        el.style.borderRadius    = '0';
      }

      positionOverlay(el, kf.position);
    }

    // Per-keyframe fade in / fade out
    const elapsed   = t - kf.time;
    const remaining = (kf.time + kf.duration) - t;
    const fi = (kf.fadeIn  != null) ? kf.fadeIn  : 0.3;
    const fo = (kf.fadeOut != null) ? kf.fadeOut : 0.3;
    let opacity = 1;
    if (kf.animation !== 'none') {
      if (fi > 0 && elapsed   < fi) opacity = elapsed   / fi;
      if (fo > 0 && remaining < fo) opacity = Math.min(opacity, remaining / fo);
    }
    el.style.opacity = String(clamp(opacity, 0, 1));
  });
}

let _cursorPreviewEl = null;

function renderCursorPreview(t) {
  const area = $('previewArea');
  if (!area || !S.cfg.cursor) return;
  const p = nearestCursorPoint(t, 0.35);
  if (!p) {
    if (_cursorPreviewEl) _cursorPreviewEl.style.display = 'none';
    return;
  }
  if (!_cursorPreviewEl) {
    _cursorPreviewEl = document.createElement('div');
    _cursorPreviewEl.style.cssText = `
      position:absolute;pointer-events:none;z-index:12;width:18px;height:18px;
      border-radius:999px;border:2px solid rgba(255,255,255,.92);
      box-shadow:0 0 0 8px rgba(94,234,212,.14),0 10px 24px rgba(0,0,0,.38);
      transform:translate(-50%,-50%);transition:left .08s linear,top .08s linear;
    `;
    area.appendChild(_cursorPreviewEl);
  }
  _cursorPreviewEl.style.display = '';
  _cursorPreviewEl.style.left = (p.xPct * 100) + '%';
  _cursorPreviewEl.style.top = (p.yPct * 100) + '%';
}

function nearestCursorPoint(t, maxDt = 0.2) {
  const points = S.recEvents?.cursor || [];
  if (!points.length) return null;
  let best = null;
  for (const p of points) {
    const dt = Math.abs(p.time - t);
    if (dt <= maxDt && (!best || dt < best.dt)) best = { ...p, dt };
  }
  return best;
}

function positionOverlay(el, pos) {
  // Reset
  el.style.top = el.style.bottom = el.style.left = el.style.right = 'auto';
  el.style.transform = '';

  const margin = '8%';
  switch(pos) {
    case 'tl': el.style.top    = margin; el.style.left  = margin; el.style.textAlign = 'left';   break;
    case 'tc': el.style.top    = margin; el.style.left  = '50%';  el.style.transform = 'translateX(-50%)'; el.style.textAlign = 'center'; break;
    case 'tr': el.style.top    = margin; el.style.right = margin; el.style.textAlign = 'right';  break;
    case 'ml': el.style.top    = '50%';  el.style.left  = margin; el.style.transform = 'translateY(-50%)'; el.style.textAlign = 'left';   break;
    case 'mc': el.style.top    = '50%';  el.style.left  = '50%';  el.style.transform = 'translate(-50%,-50%)'; el.style.textAlign = 'center'; break;
    case 'mr': el.style.top    = '50%';  el.style.right = margin; el.style.transform = 'translateY(-50%)'; el.style.textAlign = 'right';  break;
    case 'bl': el.style.bottom = margin; el.style.left  = margin; el.style.textAlign = 'left';   break;
    case 'bc': el.style.bottom = margin; el.style.left  = '50%';  el.style.transform = 'translateX(-50%)'; el.style.textAlign = 'center'; break;
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
  $('videoPreview').style.filter =
    `brightness(${100 + b*2}%) contrast(${100 + c*2}%) saturate(${100 + s*2}%)`;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  EXPORT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function showExportPanel() {
  $('exportModal').classList.remove('hidden');
  $('exportProgress').classList.add('hidden');
  if ($('exportActions')) $('exportActions').classList.add('hidden');
  if ($('exportCancelBtn')) $('exportCancelBtn').classList.add('hidden');
  $('exportProgressBar').style.width = '5%';
  const btn = $('exportBtn');
  btn.disabled = false; btn.textContent = 'Export';
  // Update output dir label
  const label = $('outputDirLabel');
  if (label) label.textContent = S.cfg.outputDir ? S.cfg.outputDir.split('/').pop() || S.cfg.outputDir : 'Desktop';
  const destLabel = $('exportDestLabel');
  if (destLabel) destLabel.textContent = S.cfg.outputDir ? `Saves to ${S.cfg.outputDir.split('/').pop()}` : 'Saves to Desktop';
}

function closeExportPanel() { $('exportModal').classList.add('hidden'); }

function highlightPresetChip(el) {
  document.querySelectorAll('.export-chip').forEach(c => {
    c.style.background = 'rgba(255,255,255,.05)';
    c.style.color = 'rgba(255,255,255,.5)';
    c.style.borderColor = 'rgba(255,255,255,.1)';
  });
  el.style.background = 'rgba(96,165,250,.15)';
  el.style.color = '#93c5fd';
  el.style.borderColor = 'rgba(96,165,250,.3)';
}

function applyExportPreset() {
  const preset = $('exportPreset')?.value || 'youtube';
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
  $('toggle-export-pad')?.classList.toggle('toggle-on', p.pad);
}

let _lastExportPath = null;

async function runExport() {
  const btn    = $('exportBtn');
  const resVal = $('exportRes').value;
  const crf    = $('exportQuality').value;
  const format = $('exportFormat')?.value || 'mp4';
  const hasPad = $('toggle-export-pad').classList.contains('toggle-on');

  btn.disabled = true; btn.textContent = 'Exporting…';
  $('exportProgress').classList.remove('hidden');
  $('exportProgressBar').style.width = '5%';
  $('exportProgressText').textContent = 'Building export…';
  if ($('exportCancelBtn')) $('exportCancelBtn').classList.remove('hidden');
  if ($('exportActions')) $('exportActions').classList.add('hidden');

  const filters = buildFilters(resVal, hasPad);
  const audioFilters = buildAudioFilters();
  const ts      = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const ext     = format === 'gif' ? 'gif' : format === 'webm' ? 'webm' : 'mp4';
  const outName = `ScreenForge-${ts}.${ext}`;
  const outputDir = S.cfg.outputDir || '';

  const watermark = S.cfg.watermark?.enabled ? S.cfg.watermark : null;
  const speedMultiplier = S.cfg.speedMultiplier || 1;
  const blurZones = S.blurZones?.length ? S.blurZones : null;

  try {
    _lastExportPath = await sf.exportFinal({
      inputPath: S.videoPath, filters, audioFilters,
      outputName: outName, trimIn: S.trimIn, trimOut: S.trimOut,
      crf, format, outputDir, watermark, speedMultiplier, blurZones,
    });
    $('exportProgressBar').style.width = '100%';
    const destDir = outputDir ? outputDir.split('/').pop() : 'Desktop';
    $('exportProgressText').textContent = `Saved to ${destDir}: ${outName}`;
    btn.textContent = 'Done ✓';
    if ($('exportCancelBtn')) $('exportCancelBtn').classList.add('hidden');
    if ($('exportActions')) $('exportActions').classList.remove('hidden');
    if ($('exportRevealBtn')) $('exportRevealBtn').onclick = () => sf.showInFinder(_lastExportPath);
    if ($('exportCopyBtn')) $('exportCopyBtn').onclick = () => {
      sf.copyToClipboard(_lastExportPath);
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
  await sf.cancelExport();
  const btn = $('exportBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Export'; }
  if ($('exportCancelBtn')) $('exportCancelBtn').classList.add('hidden');
  if ($('exportProgressText')) $('exportProgressText').textContent = 'Cancelled';
}

function buildFilters(resVal, hasPad) {
  const parts = [];
  const { b, c, s } = S.adj;

  // Color grading
  if (b !== 0 || c !== 0) {
    parts.push(`eq=brightness=${(b * 0.004).toFixed(3)}:contrast=${(1 + c * 0.015).toFixed(3)}`);
  }
  if (s !== 0) parts.push(`hue=s=${(1 + s / 100).toFixed(3)}`);

  const zooms = S.keyframes
    .filter(k => k.type === 'zoom')
    .sort((a, b) => a.time - b.time)
    .slice(0, 80);
  if (zooms.length && S.videoW && S.videoH) {
    const ffIf = (cond, yes, no) => `if(${cond}\\,${yes}\\,${no})`;
    let zExpr = '1';
    let xExpr = '0.5';
    let yExpr = '0.5';
    for (const k of zooms.reverse()) {
      const start = Math.max(0, k.time).toFixed(2);
      const dur = Number(k.duration || 1.55);
      const end = (k.time + dur).toFixed(2);
      const cond = `between(t\\,${start}\\,${end})`;
      const p = `((t-${start})/${dur.toFixed(2)})`;
      const ease = k.easing === 'linear' ? p : `(0.5-0.5*cos(${p}*3.14159))`;
      const strength = Number(k.zoomLevel || k.strength || S.cfg.zoomLevel).toFixed(2);
      const zSmooth = `(1+(${strength}-1)*sin(${ease}*3.14159))`;
      zExpr = ffIf(cond, zSmooth, zExpr);
      xExpr = ffIf(cond, Number(k.xPct ?? 0.5).toFixed(3), xExpr);
      yExpr = ffIf(cond, Number(k.yPct ?? 0.5).toFixed(3), yExpr);
    }
    parts.push(
      `scale=w='ceil(${S.videoW}*${zExpr}/2)*2':h='ceil(${S.videoH}*${zExpr}/2)*2':eval=frame`,
      `crop=w=${S.videoW}:h=${S.videoH}:x='(iw-${S.videoW})*${xExpr}':y='(ih-${S.videoH})*${yExpr}'`
    );
  }

  // Scale + padding
  if (resVal !== 'source') {
    const [tw, th] = resVal.split(':').map(Number);
    if (hasPad) {
      const iw = Math.round(tw * 0.88), ih = Math.round(th * 0.88);
      parts.push(
        `scale=${iw}:${ih}:force_original_aspect_ratio=decrease`,
        `pad=${iw}:${ih}:(ow-iw)/2:(oh-ih)/2:color=0x090d18`,
        `pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:color=0x090d18`,
        'setsar=1'
      );
    } else {
      parts.push(
        `scale=${tw}:${th}:force_original_aspect_ratio=decrease`,
        `pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:color=0x090d18`,
        'setsar=1'
      );
    }
  }

  // Smooth cursor path, rendered at export time from captured cursor samples.
  if (S.cfg.cursor) {
    const cursor = buildCursorFilters();
    if (cursor) parts.push(...cursor);
  }

  // Click pulse overlays
  for (const kf of S.keyframes.filter(k => k.type === 'click')) {
    const end = kf.time + (kf.duration || 0.8);
    parts.push(
      `drawbox=x='w*${Number(kf.xPct ?? 0.5).toFixed(3)}-26':y='h*${Number(kf.yPct ?? 0.5).toFixed(3)}-26':w=52:h=52:color=0xf87171AA:t=4:enable='between(t\\,${kf.time.toFixed(2)}\\,${end.toFixed(2)})'`
    );
  }

  // Keyboard shortcut overlays
  for (const kf of S.keyframes.filter(k => k.type === 'key')) {
    const end = kf.time + (kf.duration || 1.4);
    const safe = ffText(kf.label);
    parts.push(
      `drawtext=text='${safe}':fontsize=34:fontcolor=0xdce8f8FF:box=1:boxcolor=0x090d18DD:boxborderw=14:x=(w-text_w)/2:y=h-text_h-h*0.12:shadowx=0:shadowy=2:shadowcolor=0x000000AA:enable='between(t\\,${kf.time.toFixed(2)}\\,${end.toFixed(2)})'`
    );
  }

  // Text overlays and captions via ffmpeg drawtext
  for (const kf of S.keyframes.filter(k => k.type === 'text' || k.type === 'caption')) {
    const end    = kf.time + kf.duration;
    const hex    = kf.color.replace('#','');
    const safe   = ffText(kf.text);
    const weight = kf.bold   ? ':font=Bold'   : '';
    const style  = kf.italic ? ':slant=italic' : '';

    // Position to ffmpeg x/y expression
    const posToXY = (pos) => {
      const m = 'w*0.05';
      switch(pos) {
        case 'tl': return `x=${m}:y=${m}`;
        case 'tc': return `x=(w-text_w)/2:y=${m}`;
        case 'tr': return `x=w-text_w-${m}:y=${m}`;
        case 'ml': return `x=${m}:y=(h-text_h)/2`;
        case 'mc': return `x=(w-text_w)/2:y=(h-text_h)/2`;
        case 'mr': return `x=w-text_w-${m}:y=(h-text_h)/2`;
        case 'bl': return `x=${m}:y=h-text_h-${m}`;
        case 'bc': return `x=(w-text_w)/2:y=h-text_h-h*0.08`;
        case 'br': return `x=w-text_w-${m}:y=h-text_h-${m}`;
        default:   return `x=(w-text_w)/2:y=h-text_h-h*0.08`;
      }
    };

    let shadowStr = '';
    if (kf.shadow)  shadowStr = ':shadowx=2:shadowy=2:shadowcolor=0x000000AA';
    if (kf.outline) shadowStr = ':borderw=2:bordercolor=0x000000FF';

    let bgStr = '';
    if (kf.bgOpacity > 0) {
      const bgAlpha = Math.round(kf.bgOpacity / 100 * 255).toString(16).padStart(2,'0');
      const bgHex   = kf.bgColor.replace('#','');
      bgStr = `:box=1:boxcolor=0x${bgHex}${bgAlpha}:boxborderw=8`;
    }

    // Fade-in / fade-out alpha expression
    const fadeSecs = Math.min(0.4, kf.duration * 0.15);
    let alphaExpr = '1';
    if (kf.animation !== 'none') {
      alphaExpr = `if(lt(t-${kf.time.toFixed(2)}\\,${fadeSecs.toFixed(2)})\\,(t-${kf.time.toFixed(2)})/${fadeSecs.toFixed(2)}\\,if(gt(t\\,${(end - fadeSecs).toFixed(2)})\\,(${end.toFixed(2)}-t)/${fadeSecs.toFixed(2)}\\,1))`;
    }

    parts.push(
      `drawtext=text='${safe}':fontsize=${kf.size}:fontcolor=0x${hex}FF` +
      `${weight}${style}${shadowStr}${bgStr}` +
      `:${posToXY(kf.position)}` +
      `:alpha='${alphaExpr}'` +
      `:enable='between(t\\,${kf.time.toFixed(2)}\\,${end.toFixed(2)})'`
    );
  }

  // Blur zones (privacy redaction)
  const blurF = buildBlurFilters();
  if (blurF) parts.push(blurF);

  return parts.length ? parts.join(',') : null;
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
  const points = (S.recEvents?.cursor || [])
    .filter((p, i) => i % 2 === 0 && p.time >= S.trimIn && p.time <= S.trimOut)
    .slice(0, 700);
  if (!points.length) return null;

  const themes = {
    accent: { ring: '0x5eead4DD', fill: '0xffffffEE', trail: '0x5eead455' },
    red:    { ring: '0xf87171DD', fill: '0xffffffEE', trail: '0xf8717155' },
    dark:   { ring: '0x111827DD', fill: '0xffffffEE', trail: '0x11182755' },
    light:  { ring: '0xffffffDD', fill: '0x111827EE', trail: '0xffffff55' },
  };
  const theme = themes[S.cfg.cursorTheme || 'accent'] || themes.accent;
  const scale = Number(S.cfg.cursorSize || 1);
  const radius = Math.round(8 * scale);
  const ring = Math.round(22 * scale);
  const filters = [];

  if (S.cfg.cursorTrail) {
    for (let i = 1; i < points.length; i += 3) {
      const prev = points[i - 1], p = points[i];
      const start = Math.max(0, p.time - 0.08).toFixed(2);
      const end = (p.time + 0.18).toFixed(2);
      filters.push(
        `drawbox=x='w*${Number(p.xPct).toFixed(3)}-${Math.round(radius / 2)}':y='h*${Number(p.yPct).toFixed(3)}-${Math.round(radius / 2)}':w=${radius}:h=${radius}:color=${theme.trail}:t=fill:enable='between(t\\,${start}\\,${end})'`
      );
      if (Math.abs(p.xPct - prev.xPct) + Math.abs(p.yPct - prev.yPct) > 0.02) {
        filters.push(
          `drawbox=x='w*${Number(prev.xPct).toFixed(3)}-${Math.round(radius / 3)}':y='h*${Number(prev.yPct).toFixed(3)}-${Math.round(radius / 3)}':w=${Math.round(radius * 0.7)}:h=${Math.round(radius * 0.7)}:color=${theme.trail}:t=fill:enable='between(t\\,${start}\\,${end})'`
        );
      }
    }
  }

  for (const p of points) {
    const start = Math.max(0, p.time - 0.06).toFixed(2);
    const end = (p.time + 0.14).toFixed(2);
    filters.push(
      `drawbox=x='w*${Number(p.xPct).toFixed(3)}-${ring / 2}':y='h*${Number(p.yPct).toFixed(3)}-${ring / 2}':w=${ring}:h=${ring}:color=${theme.ring}:t=3:enable='between(t\\,${start}\\,${end})'`,
      `drawbox=x='w*${Number(p.xPct).toFixed(3)}-${radius / 2}':y='h*${Number(p.yPct).toFixed(3)}-${radius / 2}':w=${radius}:h=${radius}:color=${theme.fill}:t=fill:enable='between(t\\,${start}\\,${end})'`
    );
  }

  return filters;
}

async function generateTranscript() {
  if (!S.videoPath) { alert('Record or import a video first.'); return null; }
  const result = await sf.generateTranscript({ inputPath: S.videoPath });
  S.transcript = {
    text: result.text || '',
    cues: result.srt ? parseSrt(result.srt) : [],
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

function ffText(text) {
  return String(text || '').replace(/[':=\[\]\\]/g, ' ').replace(/,/g, '\\,').replace(/\n/g, ' ');
}

function onExportTick(timeStr) {
  try {
    const p    = timeStr.split(':');
    const secs = parseInt(p[0])*3600 + parseInt(p[1])*60 + parseFloat(p[2]);
    const dur  = S.trimOut - S.trimIn;
    if (dur > 0) {
      const pct = clamp((secs / dur) * 100, 5, 95);
      $('exportProgressBar').style.width  = pct + '%';
      $('exportProgressText').textContent = `Exporting… ${fmtTime(secs)} / ${fmtTime(dur)}`;
    }
  } catch {}
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function $(id)            { return document.getElementById(id); }
function lerp(a, b, t)    { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sleep(ms)        { return new Promise(resolve => setTimeout(resolve, ms)); }
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function playMediaElement(el, message) {
  await withTimeout(el.play(), 5000, message);
  if (!el.videoWidth && el.readyState < 2) {
    await withTimeout(new Promise((resolve, reject) => {
      el.onloadedmetadata = resolve;
      el.onerror = () => reject(new Error(message));
    }), 5000, message);
  }
}
function fmtTime(secs) {
  if (!isFinite(secs) || secs < 0) secs = 0;
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2,'0')}`;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BACKGROUND PREVIEW CANVAS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _bgAnimT   = 0;
let _bgAnimRAF = null;
let _bgThumbImg = null;
let _bgThumbSrc = '';

function startBgAnim() {
  if (_bgAnimRAF) return;
  function tick() {
    _bgAnimT += 0.004;
    drawBgPreview();
    _bgAnimRAF = requestAnimationFrame(tick);
  }
  _bgAnimRAF = requestAnimationFrame(tick);
}

function stopBgAnim() {
  if (_bgAnimRAF) { cancelAnimationFrame(_bgAnimRAF); _bgAnimRAF = null; }
}

function initBgSwatches() {
  const row = $('bgSwatchRow');
  if (!row) return;
  row.innerHTML = BG_PRESETS.map((p, i) => {
    const [c1, c2] = p.swatch;
    return `<div class="bg-swatch${i === 0 ? ' active' : ''}"
                 style="background:linear-gradient(135deg,${c1},${c2})"
                 title="${p.label}"
                 onclick="selectBgPreset(${i})"></div>`;
  }).join('');
}

function initBgCanvas() {
  const wrap = $('bgPreviewWrap');
  if (!wrap) return;
  if (window.ResizeObserver) {
    new ResizeObserver(() => { _bgThumbImg = null; requestAnimationFrame(drawBgPreview); }).observe(wrap);
  }
  startBgAnim();
}

function selectBgPreset(idx) {
  S.bgPreset = idx;
  document.querySelectorAll('.bg-swatch').forEach((el, i) => el.classList.toggle('active', i === idx));
  document.querySelectorAll('.insp-bg-thumb').forEach((el, i) => el.classList.toggle('active', i === idx));
  drawBgPreview();
}

// ── Inspector panel navigation ────────────────────────────────────────────────

function switchInspPanel(name) {
  document.querySelectorAll('.insp-panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.insp-icon').forEach(b => b.classList.remove('active'));
  const panel = $('panel-' + name);
  if (panel) panel.classList.remove('hidden');
  const btn = $('insp-' + name);
  if (btn) btn.classList.add('active');
}

function switchBgTab(tab) {
  document.querySelectorAll('.insp-tab').forEach(b => b.classList.remove('active'));
  $('bgtab-' + tab)?.classList.add('active');
  const isGrad = tab === 'gradient';
  if ($('bgGradientGrid')) $('bgGradientGrid').classList.toggle('hidden', !isGrad);
  if ($('bgSolidPanel'))   $('bgSolidPanel').classList.toggle('hidden', isGrad);
}

function initInspBgGrid() {
  const grid = $('bgGradientGrid');
  if (!grid) return;
  grid.innerHTML = BG_PRESETS.map((p, i) => {
    const [c1, c2] = p.swatch;
    return `<div class="insp-bg-thumb${i === S.bgPreset ? ' active' : ''}"
                 style="background:linear-gradient(135deg,${c1},${c2})"
                 title="${p.label}"
                 onclick="selectBgPreset(${i})"></div>`;
  }).join('');
}

function applyBgSolid() {
  // TODO: wire solid color to bg canvas
}

function setBgSolidQuick(hex) {
  const inp = $('bgSolidColor');
  if (inp) { inp.value = hex; applyBgSolid(); }
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
  _bgMesh(ctx, W, H, preset);

  if (!S.selected?.thumbnail) {
    if (hint) hint.style.display = '';
    return;
  }
  if (hint) hint.style.display = 'none';

  // Use cached thumbnail to avoid reloading every animation frame
  if (_bgThumbSrc === S.selected.thumbnail && _bgThumbImg?.complete) {
    _bgThumb(ctx, _bgThumbImg, W, H);
    return;
  }

  const img = new Image();
  img.onload = () => {
    _bgThumbImg = img;
    _bgThumbSrc = S.selected.thumbnail;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    _bgMesh(ctx, W, H, preset);
    _bgThumb(ctx, img, W, H);
  };
  img.src = S.selected.thumbnail;
}

function _bgMesh(ctx, W, H, preset) {
  ctx.fillStyle = preset.base;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < preset.blobs.length; i++) {
    const blob = preset.blobs[i];
    // Each blob drifts on a unique Lissajous path, slow enough to feel organic
    const phase = i * 2.094; // 120° apart so blobs never clump
    const cx = W * (blob.x + Math.sin(_bgAnimT * 0.7 + phase)        * 0.055);
    const cy = H * (blob.y + Math.cos(_bgAnimT * 0.55 + phase + 0.9) * 0.045);
    const r  = Math.max(W, H) * blob.r;
    const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grd.addColorStop(0,   blob.color + 'e0');
    grd.addColorStop(0.3, blob.color + '99');
    grd.addColorStop(0.7, blob.color + '33');
    grd.addColorStop(1,   blob.color + '00');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, H);
  }
  // Vignette: darken edges so the thumbnail feels "lifted"
  const vig = ctx.createRadialGradient(W/2, H/2, Math.min(W,H)*.3, W/2, H/2, Math.max(W,H)*.8);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,.45)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);
}

function _bgThumb(ctx, img, W, H) {
  const pad    = S.cfg.pad   ? Math.min(W, H) * 0.13 : Math.min(W, H) * 0.06;
  const frameH = S.cfg.frame ? Math.round(Math.min(W, H) * 0.055) : 0;
  const availW = W - pad * 2;
  const availH = H - pad * 2 - frameH;
  const scale  = Math.min(availW / img.naturalWidth, availH / img.naturalHeight);
  const iw     = img.naturalWidth  * scale;
  const ih     = img.naturalHeight * scale;
  const ix     = (W - iw) / 2;
  const iy     = (H - ih - frameH) / 2 + frameH;
  const r      = 11;

  // Deep drop shadow
  ctx.save();
  ctx.shadowColor    = 'rgba(0,0,0,.72)';
  ctx.shadowBlur     = 64;
  ctx.shadowOffsetY  = 28;
  roundRect(ctx, ix, S.cfg.frame ? iy - frameH : iy, iw, ih + (S.cfg.frame ? frameH : 0), r);
  ctx.fillStyle = 'rgba(0,0,0,.01)';
  ctx.fill();
  ctx.restore();

  if (S.cfg.frame) {
    // macOS title bar
    ctx.save();
    const barGrd = ctx.createLinearGradient(ix, iy - frameH, ix, iy);
    barGrd.addColorStop(0, '#3d3d3f');
    barGrd.addColorStop(1, '#2c2c2e');
    roundRect(ctx, ix, iy - frameH, iw, frameH, [r, r, 0, 0]);
    ctx.fillStyle = barGrd;
    ctx.fill();
    ctx.restore();

    // Traffic lights
    const dotY  = iy - frameH * 0.5;
    const dotR  = Math.max(5, frameH * 0.23);
    const dotX0 = ix + frameH * 0.72;
    [['#ff5f57','#e0443e'], ['#febc2e','#d4a017'], ['#28c840','#1fa631']].forEach(([fill, stroke], n) => {
      ctx.beginPath();
      ctx.arc(dotX0 + n * dotR * 2.8, dotY, dotR, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = stroke; ctx.lineWidth = .6; ctx.stroke();
    });

    // Thumbnail content area
    ctx.save();
    roundRect(ctx, ix, iy, iw, ih, [0, 0, r, r]);
    ctx.clip();
    ctx.drawImage(img, ix, iy, iw, ih);
    ctx.restore();

    // Window border
    ctx.save();
    roundRect(ctx, ix, iy - frameH, iw, ih + frameH, r);
    ctx.strokeStyle = 'rgba(255,255,255,.13)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

  } else {
    ctx.save();
    roundRect(ctx, ix, iy, iw, ih, r);
    ctx.clip();
    ctx.drawImage(img, ix, iy, iw, ih);
    ctx.restore();

    ctx.save();
    roundRect(ctx, ix, iy, iw, ih, r);
    ctx.strokeStyle = 'rgba(255,255,255,.1)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  if (S.cfg.captureArea) {
    const a = sanitizeCaptureArea(S.cfg.captureArea);
    if (!a) return;
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
/* roundRect closes here; additional features below */
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PERSISTENT SETTINGS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function loadPersistedSettings() {
  if (!window.sf?.getAllSettings) return;
  try {
    const saved = await sf.getAllSettings();
    if (saved && Object.keys(saved).length) {
      // Merge saved cfg into S.cfg
      if (saved.cfg) Object.assign(S.cfg, saved.cfg);
      // Previous builds defaulted mic on, which can hang on macOS permission prompts.
      // Keep startup deterministic unless the user turns it back on in this build.
      if (saved.cfg?.mic === true && saved.cfg?.micDefaultVersion !== 2) S.cfg.mic = false;
      S.cfg.micDefaultVersion = 2;
      // Previous builds defaulted countdown to 5. Migrate that old default once.
      if (Number(saved.cfg?.countdown) === 5 && saved.cfg?.countdownDefaultVersion !== 2) S.cfg.countdown = 3;
      S.cfg.countdownDefaultVersion = 2;
      if (saved.adj) Object.assign(S.adj, saved.adj);
      if (saved.bgPreset !== undefined) { S.bgPreset = saved.bgPreset; selectBgPreset(S.bgPreset); }
      syncConfigControls();
      console.log('[SF] Settings restored from electron-store');
    }
  } catch (e) { console.warn('[SF] Could not load settings:', e); }
}

function persistSettings() {
  if (!window.sf?.setSettings) return;
  sf.setSettings({ cfg: S.cfg, adj: S.adj, bgPreset: S.bgPreset }).catch(() => {});
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
        const stats = await sf.getSystemStats();
        cpuMem = ` · CPU ${stats.cpu}% · RAM ${stats.mem}%`;
      } catch {}
    }

    statsBar.textContent = `⏺ ${elapsedStr}  ·  ${sizeMB} MB  ·  ~${S.cfg.fps} fps${cpuMem}`;
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
  if (ANN.tool === 'laser')  return 'none';
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
  requestAnimationFrame(laserFadeLoop);
})();


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CLIP LIBRARY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _libraryClips = [];

async function showLibraryPanel() {
  const panel = $('libraryPanel');
  if (!panel) return;
  panel.classList.remove('hidden');
  await refreshClipLibrary();
}

function hideLibraryPanel() {
  const panel = $('libraryPanel');
  if (panel) panel.classList.add('hidden');
}

async function refreshClipLibrary() {
  if (!window.sf?.getClipLibrary) return;
  try {
    _libraryClips = await sf.getClipLibrary();
    renderLibrary();
  } catch (e) { console.warn('Library load failed:', e); }
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
    const sizeMB = (clip.size / 1024 / 1024).toFixed(1);
    const date   = new Date(clip.mtime).toLocaleDateString();
    const thumb  = clip.thumbnail ? `file://${clip.thumbnail}` : '';
    return `
      <div class="lib-card" onclick="openLibraryClip(${i})" style="
        background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
        border-radius:10px;overflow:hidden;cursor:pointer;transition:border-color .15s"
        onmouseover="this.style.borderColor='rgba(94,234,212,.3)'"
        onmouseout="this.style.borderColor='rgba(255,255,255,.08)'">
        <div style="aspect-ratio:16/9;background:#0a0d18;position:relative;overflow:hidden">
          ${thumb ? `<img src="${thumb}" style="width:100%;height:100%;object-fit:cover">` :
            `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:28px">🎬</div>`}
          <div style="position:absolute;bottom:6px;right:6px;background:rgba(0,0,0,.7);
            border-radius:4px;padding:2px 6px;font-size:10px;color:#dce8f8">${sizeMB} MB</div>
        </div>
        <div style="padding:10px 12px">
          <div style="font-size:12px;font-weight:600;color:#dce8f8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
               title="${clip.title || clip.name}">${clip.title || clip.name}</div>
          <div style="font-size:10px;color:rgba(255,255,255,.35);margin-top:3px">${date}</div>
          <div style="display:flex;gap:6px;margin-top:8px">
            <button onclick="event.stopPropagation();openLibraryClip(${i})" style="
              flex:1;padding:5px;border-radius:6px;border:none;font-size:10px;font-weight:600;
              background:rgba(94,234,212,.12);color:#6ee7b7;cursor:pointer">▶ Edit</button>
            <button onclick="event.stopPropagation();showInFinderLib(${i})" style="
              padding:5px 8px;border-radius:6px;border:none;font-size:10px;
              background:rgba(255,255,255,.07);color:rgba(255,255,255,.5);cursor:pointer">⌂</button>
            <button onclick="event.stopPropagation();deleteLibraryClip(${i})" style="
              padding:5px 8px;border-radius:6px;border:none;font-size:10px;
              background:rgba(248,113,113,.1);color:#fca5a5;cursor:pointer">✕</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

async function openLibraryClip(i) {
  const clip = _libraryClips[i];
  if (!clip) return;
  hideLibraryPanel();
  await openEditor(clip.path, [], null);
}

function showInFinderLib(i) {
  const clip = _libraryClips[i];
  if (clip) sf.showInFinder(clip.path);
}

async function deleteLibraryClip(i) {
  const clip = _libraryClips[i];
  if (!clip) return;
  if (!confirm(`Delete "${clip.title || clip.name}"?`)) return;
  await sf.deleteClip(clip.path);
  await refreshClipLibrary();
}

async function changeLibraryDir() {
  const dir = await sf.setLibraryDir();
  if (dir) { showFloatToast('Library folder updated'); await refreshClipLibrary(); }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REMOTE CONTROL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _remoteUrl = null;

async function loadRemoteUrl() {
  if (!window.sf?.getRemoteUrl) return;
  try {
    _remoteUrl = await sf.getRemoteUrl();
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
    sf.copyToClipboard(_remoteUrl);
    showFloatToast('Remote URL copied!');
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SILENCE DETECTION UI
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _silences = [];

async function runSilenceDetect() {
  if (!S.videoPath || !window.sf?.silenceDetect) return;
  const btn = $('silenceDetectBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Detecting…'; }
  try {
    _silences = await sf.silenceDetect({ inputPath: S.videoPath, threshold: -35, duration: 0.5 });
    renderSilenceList();
    showFloatToast(`Found ${_silences.length} silence${_silences.length===1?'':'s'}`);
  } catch (e) {
    showFloatToast('Silence detect failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔇 Detect Silences'; }
  }
}

function renderSilenceList() {
  const el = $('silenceList');
  if (!el) return;
  if (!_silences.length) { el.innerHTML = '<div style="color:rgba(255,255,255,.3);font-size:11px;padding:8px">No silences found</div>'; return; }
  el.innerHTML = _silences.map((s, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <span style="font-size:10px;color:rgba(255,255,255,.4);min-width:28px">#${i+1}</span>
      <span style="font-size:11px;color:#dce8f8;flex:1">${fmtTime(s.start)} → ${fmtTime(s.end)}</span>
      <span style="font-size:10px;color:rgba(255,255,255,.35)">${s.duration.toFixed(1)}s</span>
      <button onclick="seekToSilence(${s.start})" style="
        padding:2px 8px;border-radius:4px;border:none;font-size:10px;
        background:rgba(94,234,212,.1);color:#6ee7b7;cursor:pointer">Go</button>
      <button onclick="cutSilence(${i})" style="
        padding:2px 8px;border-radius:4px;border:none;font-size:10px;
        background:rgba(248,113,113,.1);color:#fca5a5;cursor:pointer">Cut</button>
    </div>`).join('');
}

function seekToSilence(t) {
  const vid = $('videoPreview');
  if (vid) vid.currentTime = t;
}

function cutSilence(i) {
  const s = _silences[i];
  if (!s) return;
  // Add cut marks at silence start and end
  cutAtTime(s.start);
  cutAtTime(s.end);
  showFloatToast(`Silence ${i+1} cut`);
}

async function cutAllSilences() {
  for (const s of _silences) {
    cutAtTime(s.start);
    cutAtTime(s.end);
  }
  showFloatToast(`${_silences.length} silences cut`);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BACKGROUND MUSIC
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _bgMusicPath = null;

async function pickBackgroundMusic() {
  if (!window.sf?.pickBgMusic) return;
  const p = await sf.pickBgMusic();
  if (!p) return;
  _bgMusicPath = p;
  const parts = p.split('/');
  const name = parts[parts.length - 1];
  const el = $('bgMusicName');
  if (el) el.textContent = name;
  const el2 = $('bgMusicRow');
  if (el2) el2.style.display = 'flex';
  showFloatToast(`Background music: ${name}`);
}

function clearBackgroundMusic() {
  _bgMusicPath = null;
  const el = $('bgMusicName');
  if (el) el.textContent = 'None';
  const el2 = $('bgMusicRow');
  if (el2) el2.style.display = 'none';
}

function getBgMusicAudioFilter(volPct = 15) {
  if (!_bgMusicPath) return null;
  const safe = _bgMusicPath.replace(/\\/g, '/').replace(/'/g, "\\'");
  return `amix=inputs=2:duration=first:dropout_transition=3,volume=1`;
  // Note: full implementation adds -i bgMusicPath before the filter
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
    el.innerHTML = '<div style="color:rgba(255,255,255,.3);font-size:11px;padding:8px">No clips. Record multiple sessions</div>';
    return;
  }
  el.innerHTML = _multiClips.map((c, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <span style="font-size:18px">🎬</span>
      <span style="font-size:11px;color:#dce8f8;flex:1">${c.title}</span>
      <button onclick="removeMultiClip(${i})" style="
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
    const out = await sf.mergeClips({
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
    const out = await sf.normalizeAudio({ inputPath: S.videoPath });
    showFloatToast('Audio normalized!');
    await openEditor(out, S.keyframes, structuredClone(S.recEvents));
  } catch (e) {
    showFloatToast('Normalize failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📊 Normalize Audio'; }
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
    const out = await sf.exportGifPreview({ inputPath: S.videoPath, start, duration: 3, scale: 480 });
    sf.showInFinder(out);
    showFloatToast('GIF created! Opening Finder…');
  } catch (e) {
    showFloatToast('GIF failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🎞 GIF Preview'; }
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
      srtPath = await sf.saveSrt({ srt: S.transcript.srt, videoPath: S.videoPath });
    }
    const out = await sf.burnCaptions({ inputPath: S.videoPath, srtPath });
    showFloatToast('Captions burned in!');
    sf.showInFinder(out);
  } catch (e) {
    showFloatToast('Burn captions failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📝 Burn Captions'; }
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RECORDING TEMPLATE SYSTEM
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function saveRecordingTemplate() {
  const name = prompt('Template name:', 'My Setup');
  if (!name) return;
  const templates = (await sf.getSetting('templates')) || {};
  templates[name] = structuredClone(S.cfg);
  await sf.setSetting('templates', templates);
  renderTemplateList();
  showFloatToast(`Template "${name}" saved`);
}

async function loadTemplateList() {
  if (!window.sf?.getSetting) return;
  const templates = (await sf.getSetting('templates')) || {};
  renderTemplateList(templates);
}

function renderTemplateList(templates) {
  const el = $('templateList');
  if (!el) return;
  const entries = Object.entries(templates || {});
  if (!entries.length) {
    el.innerHTML = '<div style="color:rgba(255,255,255,.3);font-size:11px;padding:4px">No templates saved</div>';
    return;
  }
  el.innerHTML = entries.map(([name]) => `
    <div style="display:flex;align-items:center;gap:6px;padding:4px 0">
      <span style="font-size:11px;color:#dce8f8;flex:1">${name}</span>
      <button onclick="applyTemplate('${name.replace(/'/g,"\\'")}')" style="
        padding:2px 8px;border-radius:4px;border:none;font-size:10px;
        background:rgba(94,234,212,.1);color:#6ee7b7;cursor:pointer">Apply</button>
      <button onclick="deleteTemplate('${name.replace(/'/g,"\\'")}')" style="
        padding:2px 8px;border-radius:4px;border:none;font-size:10px;
        background:rgba(248,113,113,.1);color:#fca5a5;cursor:pointer">✕</button>
    </div>`).join('');
}

async function applyTemplate(name) {
  const templates = (await sf.getSetting('templates')) || {};
  if (templates[name]) {
    Object.assign(S.cfg, templates[name]);
    syncConfigControls();
    showFloatToast(`Template "${name}" applied`);
  }
}

async function deleteTemplate(name) {
  const templates = (await sf.getSetting('templates')) || {};
  delete templates[name];
  await sf.setSetting('templates', templates);
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
  // Export chapter markers as ffmetadata string (for ffmpeg)
  const markers = S.keyframes.filter(k => k.type === 'marker').sort((a, b) => a.time - b.time);
  if (!markers.length) { showFloatToast('No chapter markers to export'); return; }
  let meta = ';FFMETADATA1\n';
  for (let i = 0; i < markers.length; i++) {
    const start = Math.round(markers[i].time * 1000);
    const end   = i < markers.length - 1 ? Math.round(markers[i+1].time * 1000) : Math.round(S.dur * 1000);
    meta += `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${start}\nEND=${end}\ntitle=${markers[i].label || `Chapter ${i+1}`}\n\n`;
  }
  sf.copyToClipboard(meta);
  showFloatToast('Chapters copied to clipboard (ffmetadata format)');
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  KEYBOARD SHORTCUT HELP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function showShortcutsHelp() {
  const el = $('shortcutsModal');
  if (el) el.classList.remove('hidden');
}
function hideShortcutsHelp() {
  const el = $('shortcutsModal');
  if (el) el.classList.add('hidden');
}
