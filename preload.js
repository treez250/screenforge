const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sf', {
  // ─── Sources ───────────────────────────────────────────────────────────────
  getSources:           ()     => ipcRenderer.invoke('get-sources'),
  openScreenRecordingSettings: () => ipcRenderer.invoke('open-screen-recording-settings'),

  // ─── Recording save ────────────────────────────────────────────────────────
  saveRecording:        (d)    => ipcRenderer.invoke('save-recording', d),
  startNativeMicRecording:(d)  => ipcRenderer.invoke('start-native-mic-recording', d),
  stopNativeMicRecording: (d)  => ipcRenderer.invoke('stop-native-mic-recording', d),

  // ─── File dialogs ──────────────────────────────────────────────────────────
  openVideoFile:        ()     => ipcRenderer.invoke('open-video-file'),
  saveProjectFile:      (d)    => ipcRenderer.invoke('save-project-file', d),
  openProjectFile:      ()     => ipcRenderer.invoke('open-project-file'),
  chooseOutputDir:      ()     => ipcRenderer.invoke('choose-output-dir'),

  // ─── Export ────────────────────────────────────────────────────────────────
  exportFinal:          (d)    => ipcRenderer.invoke('export-final', d),
  cancelExport:         ()     => ipcRenderer.invoke('cancel-export'),
  mergeClips:           (d)    => ipcRenderer.invoke('merge-clips', d),
  exportGifPreview:     (d)    => ipcRenderer.invoke('export-gif-preview', d),
  burnCaptions:         (d)    => ipcRenderer.invoke('burn-captions', d),
  normalizeAudio:       (d)    => ipcRenderer.invoke('normalize-audio', d),

  // ─── Media analysis ────────────────────────────────────────────────────────
  generateTranscript:   (d)    => ipcRenderer.invoke('generate-transcript', d),
  probeVideo:           (p)    => ipcRenderer.invoke('probe-video', p),
  silenceDetect:        (d)    => ipcRenderer.invoke('silence-detect', d),

  // ─── Area picker ───────────────────────────────────────────────────────────
  selectCaptureArea:    (b)    => ipcRenderer.invoke('select-capture-area', b),
  setSourceBounds:      (b)    => ipcRenderer.send('set-source-bounds', b),
  setCaptureSource:     (s)    => ipcRenderer.send('set-capture-source', s),
  audioDiagnostic:      (d)    => ipcRenderer.send('audio-diagnostic', d),

  // ─── Recording lifecycle ───────────────────────────────────────────────────
  startCursorPoll:      ()     => ipcRenderer.send('start-cursor-poll'),
  stopCursorPoll:       ()     => ipcRenderer.send('stop-cursor-poll'),
  recordingStarted:     (d)    => ipcRenderer.send('recording-started', d),
  recordingStopped:     ()     => ipcRenderer.send('recording-stopped'),

  // ─── Float bar ────────────────────────────────────────────────────────────
  sendPauseState:       (v)    => ipcRenderer.send('pause-state', v),

  // ─── Screenshot ───────────────────────────────────────────────────────────
  takeScreenshot:       ()     => ipcRenderer.invoke('take-screenshot'),

  // ─── Shell / filesystem ───────────────────────────────────────────────────
  showInFinder:         (p)    => ipcRenderer.invoke('show-in-finder', p),
  copyToClipboard:      (t)    => ipcRenderer.invoke('copy-to-clipboard', t),
  saveSrt:              (d)    => ipcRenderer.invoke('save-srt', d),

  // ─── Crash recovery ───────────────────────────────────────────────────────
  autoSaveChunk:        (d)    => ipcRenderer.invoke('auto-save-chunk', d),
  listRecoverySessions: ()     => ipcRenderer.invoke('list-recovery-sessions'),
  deleteRecoverySession:(p)    => ipcRenderer.invoke('delete-recovery-session', p),

  // ─── Settings (electron-store) ────────────────────────────────────────────
  getAllSettings:        ()        => ipcRenderer.invoke('get-all-settings'),
  getSetting:           (k)       => ipcRenderer.invoke('get-setting', k),
  setSetting:           (k, v)    => ipcRenderer.invoke('set-setting', k, v),
  setSettings:          (obj)     => ipcRenderer.invoke('set-settings', obj),

  // ─── Session ID ───────────────────────────────────────────────────────────
  newSessionId:         ()     => ipcRenderer.invoke('new-session-id'),

  // ─── Clip library ────────────────────────────────────────────────────────
  getLibraryDir:        ()     => ipcRenderer.invoke('get-library-dir'),
  setLibraryDir:        ()     => ipcRenderer.invoke('set-library-dir'),
  getClipLibrary:       ()     => ipcRenderer.invoke('get-clip-library'),
  saveToLibrary:        (d)    => ipcRenderer.invoke('save-to-library', d),
  deleteClip:           (p)    => ipcRenderer.invoke('delete-clip', p),
  renameClip:           (d)    => ipcRenderer.invoke('rename-clip', d),
  openLibraryDir:       ()     => ipcRenderer.invoke('open-library-dir'),
  generateThumbnail:    (p)    => ipcRenderer.invoke('generate-thumbnail', p),

  // ─── System stats ────────────────────────────────────────────────────────
  getSystemStats:       ()     => ipcRenderer.invoke('get-system-stats'),

  // ─── Background music ────────────────────────────────────────────────────
  pickBgMusic:          ()     => ipcRenderer.invoke('pick-bg-music'),

  // ─── Remote control ──────────────────────────────────────────────────────
  getRemotePort:        ()     => ipcRenderer.invoke('get-remote-port'),
  getRemoteUrl:         ()     => ipcRenderer.invoke('get-remote-url'),

  // ─── IPC listeners (main → renderer) ─────────────────────────────────────
  onCursorMove:         (cb)   => ipcRenderer.on('cursor-move',       (_, d) => cb(d)),
  onMouseDown:          (cb)   => ipcRenderer.on('mouse-down',        (_, d) => cb(d)),
  onKeyDown:            (cb)   => ipcRenderer.on('key-down',          (_, d) => cb(d)),
  onFloatPause:         (cb)   => ipcRenderer.on('float-pause',       ()     => cb()),
  onFloatMarker:        (cb)   => ipcRenderer.on('float-marker',      ()     => cb()),
  onFloatScreenshot:    (cb)   => ipcRenderer.on('float-screenshot',  ()     => cb()),
  onGlobalStop:         (cb)   => ipcRenderer.on('global-stop',       ()     => cb()),
  onExportProgress:     (cb)   => ipcRenderer.on('export-progress',   (_, d) => cb(d)),
  onPauseState:         (cb)   => ipcRenderer.on('pause-state',       (_, v) => cb(v)),
  onRecordingInfo:      (cb)   => ipcRenderer.on('recording-info',    (_, d) => cb(d)),
});
