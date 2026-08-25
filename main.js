const {
  app, BrowserWindow, ipcMain, globalShortcut,
  desktopCapturer, session, screen, dialog, shell, clipboard, nativeImage, Menu, Tray,
  systemPreferences,
} = require('electron');
const path  = require('path');
const fs    = require('fs');
const { fileURLToPath } = require('url');
const { spawn, execFile } = require('child_process');
const os    = require('os');
const http  = require('http');
const { randomBytes, timingSafeEqual } = require('crypto');
const { buildExportPlan, exportArtifactPolicy } = require('./export-engine');
const { materializeFilterComplexArgs } = require('./export-runtime');
const { buildMergeClipsArgs, buildNormalizeAudioArgs } = require('./media-transforms');
const { discoverCaptureSources } = require('./renderer/source-discovery');
const {
  VIDEO_EXTENSIONS,
  cleanDisplayText,
  cleanFilenameStem,
  readBoundedRegularFile,
  reserveContainedFile,
  resolveContainedPath,
} = require('./security-utils');

let mainWindow, floatBar, areaPicker, tray;
let ffmpegPath;

const IPC_ROLE_PAGES = Object.freeze({
  main: path.join(__dirname, 'renderer', 'index.html'),
  float: path.join(__dirname, 'renderer', 'floatbar.html'),
  area: path.join(__dirname, 'renderer', 'area-picker.html'),
});

function ipcRoleWindow(role) {
  if (role === 'main') return mainWindow;
  if (role === 'float') return floatBar;
  if (role === 'area') return areaPicker;
  return null;
}

function isIpcSender(event, role) {
  const window = ipcRoleWindow(role);
  if (!event?.sender || !window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
  if (event.sender !== window.webContents) return false;
  if (event.senderFrame?.parent) return false;
  const rawUrl = event.senderFrame?.url || event.sender.getURL();
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'file:') return false;
    return path.resolve(fileURLToPath(parsed)) === path.resolve(IPC_ROLE_PAGES[role]);
  } catch {
    return false;
  }
}

function assertIpcSender(event, role) {
  if (!isIpcSender(event, role)) throw new Error('Unauthorized IPC sender');
}

function handleFrom(role, channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    // Sender check stays first and outside the try: an unauthorized caller must
    // never reach the handler, and must not be reported as a runtime fault.
    assertIpcSender(event, role);
    try {
      return await handler(event, ...args);
    } catch (err) {
      // Log and surface, then re-throw. Reject semantics are deliberate: every
      // `await screenforgeApi.x()` call site in the renderer catches, and
      // resolving with an error object instead would let success paths run on
      // failure data.
      reportRuntimeFault(`ipc:${channel}`, err);
      throw err;
    }
  });
}

function onFrom(role, channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
    if (!isIpcSender(event, role)) {
      log.warn?.(`ScreenForge blocked ${channel} from an unauthorized renderer`);
      return;
    }
    handler(event, ...args);
  });
}

try {
  ffmpegPath = require('ffmpeg-static');
  // In a packaged app the binary lives inside .asar which can't be executed.
  // Force the path into .asar.unpacked where electron-builder extracts it.
  if (app.isPackaged && ffmpegPath) {
    ffmpegPath = ffmpegPath.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    ffmpegPath = ffmpegPath.replace('app.asar/', 'app.asar.unpacked/');
  }
} catch { ffmpegPath = 'ffmpeg'; }

function getFfmpegPath() {
  const candidates = [
    ffmpegPath,
    typeof ffmpegPath === 'string' ? ffmpegPath.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep) : null,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    'ffmpeg',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'ffmpeg') return candidate;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch {}
  }
  return 'ffmpeg';
}

function safeSessionId(raw) {
  return String(raw || `sess-${Date.now()}`).replace(/[^a-z0-9_-]/gi, '-').slice(0, 80);
}

function fileUsable(filePath, minBytes = 1024) {
  try {
    return !!filePath && fs.existsSync(filePath) && fs.statSync(filePath).size > minBytes;
  } catch {
    return false;
  }
}

function normalizeDeviceLabel(label = '') {
  return String(label)
    .toLowerCase()
    .replace(/default\s*-\s*/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseAvfoundationAudioDevices(output = '') {
  const devices = [];
  let inAudio = false;
  for (const line of String(output).split(/\r?\n/)) {
    if (/AVFoundation audio devices:/i.test(line)) {
      inAudio = true;
      continue;
    }
    if (/AVFoundation video devices:/i.test(line)) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const match = line.match(/\[(\d+)\]\s+(.+)$/);
    if (match) devices.push({ index: Number(match[1]), name: match[2].trim() });
  }
  return devices;
}

function listAvfoundationAudioDevices(ffPath = getFfmpegPath()) {
  return new Promise((resolve) => {
    const ff = spawn(ffPath, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
    let output = '';
    ff.stderr.on('data', d => { output += d.toString(); });
    ff.stdout.on('data', d => { output += d.toString(); });
    ff.on('error', err => {
      log.warn?.(`ScreenForge native mic device list failed: ${err.message}`);
      resolve([]);
    });
    ff.on('close', () => resolve(parseAvfoundationAudioDevices(output)));
  });
}

function chooseNativeMicDevice(devices, preferredLabel = '') {
  if (!devices.length) return null;
  const preferred = normalizeDeviceLabel(preferredLabel);
  if (preferred) {
    const exact = devices.find(device => normalizeDeviceLabel(device.name) === preferred);
    if (exact) return exact;
    const contained = devices.find(device => {
      const name = normalizeDeviceLabel(device.name);
      return name.includes(preferred) || preferred.includes(name);
    });
    if (contained) return contained;
  }
  return devices.find(device => /macbook|built.?in/i.test(device.name))
      || devices.find(device => !/teams|virtual/i.test(device.name))
      || devices[0];
}

function mediaFileHasAudio(filePath, ffPath = getFfmpegPath()) {
  return new Promise((resolve) => {
    const ff = spawn(ffPath, ['-hide_banner', '-i', filePath]);
    let output = '';
    ff.stderr.on('data', d => { output += d.toString(); });
    ff.on('error', () => resolve(false));
    ff.on('close', () => resolve(/Audio:/i.test(output)));
  });
}

function mediaFileDuration(filePath, ffPath = getFfmpegPath()) {
  return new Promise((resolve) => {
    const ff = spawn(ffPath, ['-hide_banner', '-i', filePath]);
    let output = '';
    ff.stderr.on('data', d => { output += d.toString(); });
    ff.on('error', () => resolve(0));
    ff.on('close', () => {
      const match = output.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (!match) {
        resolve(0);
        return;
      }
      resolve(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    });
  });
}

function mediaFileMetadata(filePath, ffPath = getFfmpegPath()) {
  return new Promise((resolve) => {
    const fallback = { width: 0, height: 0, fps: 30, hasAudio: false, duration: 0 };
    const ff = spawn(ffPath, ['-hide_banner', '-i', filePath]);
    let output = '';
    ff.stderr.on('data', data => { output += data.toString(); });
    ff.on('error', () => resolve(fallback));
    ff.on('close', () => {
      const duration = output.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      const size = output.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})[\s,]/);
      const frameRate = output.match(/Video:.*?\b(\d+(?:\.\d+)?)\s+fps\b/i);
      resolve({
        width: size ? Number(size[1]) : 0,
        height: size ? Number(size[2]) : 0,
        fps: frameRate ? Number(frameRate[1]) : 30,
        hasAudio: /Audio:/i.test(output),
        duration: duration
          ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
          : 0,
      });
    });
  });
}

function buildSaveRecordingArgs({
  raw,
  out,
  nativeAudioPath,
  nativeAudioOffsetMs = 0,
  nativeAudioFormat = '',
  nativeAudioSampleRate = 48000,
  nativeAudioChannels = 1,
  rawHasAudio = false,
  rawDurationSec = 0,
}) {
  if (!fileUsable(nativeAudioPath)) return ['-y', '-i', raw, '-c', 'copy', out];

  const offset = Math.max(0, Number(nativeAudioOffsetMs) || 0) / 1000;
  const isRawPcm = nativeAudioFormat === 's16le' || /\.(pcm|s16le)$/i.test(nativeAudioPath);
  const args = ['-y', '-i', raw];
  if (offset >= 0.02) args.push('-ss', offset.toFixed(3));
  if (isRawPcm) {
    args.push(
      '-f', 's16le',
      '-ar', String(nativeAudioSampleRate || 48000),
      '-ac', String(nativeAudioChannels || 1),
    );
  }
  args.push('-i', nativeAudioPath);

  if (rawHasAudio) {
    args.push(
      '-filter_complex', '[1:a:0]aresample=async=1000:first_pts=0[native];[0:a:0][native]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]',
      '-map', '0:v:0',
      '-map', '[a]',
    );
  } else {
    args.push('-map', '0:v:0', '-map', '1:a:0');
  }

  args.push('-c:v', 'copy', '-c:a', 'libopus', '-b:a', '192k');
  if (!rawHasAudio) args.push('-af', 'aresample=async=1000:first_pts=0');
  if (rawDurationSec > 0) args.push('-t', rawDurationSec.toFixed(3));
  args.push(out);
  return args;
}

let uIOhook = null;
try { ({ uIOhook } = require('uiohook-napi')); } catch {}

// ─── Optional packages (degrade gracefully) ───────────────────────────────────
let Store, electronLog, uuidv4, si, WebSocketServer, sharp;
try {
  const electronStoreModule = require('electron-store');
  Store = electronStoreModule?.default || electronStoreModule;
  if (typeof Store !== 'function') Store = null;
} catch {}
try { electronLog   = require('electron-log');  }          catch {}
try { ({ v4: uuidv4 } = require('uuid'));       }          catch {}
try { si            = require('systeminformation'); }       catch {}
try { ({ WebSocketServer } = require('ws'));    }          catch {}
try { sharp         = require('sharp');         }          catch {}

const log = electronLog || console;

// ─── Crash guards ─────────────────────────────────────────────────────────────
//
// Without these, an unhandled rejection in any of the ~44 async IPC handlers, or
// a renderer/child-process death, kills or zombies the app with no log line and
// no message to the user. That is the single largest source of "it just gets
// flaky" reports: the failure is invisible, so it looks random.
//
// Every fault is logged, surfaced to the renderer out-of-band on 'main-error',
// and - for fatal paths - followed by best-effort cleanup of in-flight FFmpeg
// children and temp files so a crash does not leak processes or disk.

let runtimeFaultCount = 0;

function describeFault(err) {
  if (err instanceof Error) return err.stack || err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function reportRuntimeFault(origin, err, { fatal = false } = {}) {
  runtimeFaultCount += 1;
  const detail = describeFault(err);
  log.error?.(`ScreenForge fault [${origin}]${fatal ? ' (fatal)' : ''}: ${detail}`);
  try {
    safeSend(mainWindow, 'main-error', {
      origin,
      fatal,
      message: err instanceof Error ? err.message : String(err),
      at: Date.now(),
    });
  } catch {}
}

// Best-effort teardown of anything that would outlive a crash.
function reapChildProcesses(reason) {
  try {
    for (const [, rec] of activeNativeMicSessions) {
      try { rec.proc?.kill('SIGKILL'); } catch {}
    }
    activeNativeMicSessions.clear();
  } catch {}
  try { stopInputHook(); } catch {}
  log.warn?.(`ScreenForge reaped child processes after ${reason}`);
}

function installCrashGuards() {
  // Only meaningful in the main process. main-startup.test.js evaluates this
  // file in a vm that shares the real `process`, where `process.type` is
  // undefined, so the guards correctly no-op under test.
  if (process.type !== 'browser') return;

  process.on('uncaughtException', (err) => {
    reportRuntimeFault('uncaughtException', err, { fatal: true });
    reapChildProcesses('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    reportRuntimeFault('unhandledRejection', reason);
  });

  app.on('render-process-gone', (_event, _contents, details) => {
    reportRuntimeFault('render-process-gone', new Error(
      `renderer exited: ${details?.reason || 'unknown'} (exitCode ${details?.exitCode ?? 'n/a'})`,
    ), { fatal: true });
    reapChildProcesses('render-process-gone');
  });

  app.on('child-process-gone', (_event, details) => {
    reportRuntimeFault('child-process-gone', new Error(
      `${details?.type || 'child'} exited: ${details?.reason || 'unknown'}`,
    ));
  });
}

installCrashGuards();

// ─── Persistent settings ──────────────────────────────────────────────────────
const store = Store ? new Store({ name: 'screenforge-prefs' }) : null;

// ─── Clip library directory ───────────────────────────────────────────────────
function getLibraryDir() {
  const defaultDir = path.join(os.homedir(), 'Movies', 'ScreenForge');
  const storedDir = store?.get('libraryDir');
  const dir = store?.get('libraryDirApprovedVersion') === 1 && typeof storedDir === 'string'
    ? storedDir
    : defaultDir;
  fs.mkdirSync(dir, { recursive: true });
  return canonicalDirectory(dir);
}

function getRecoveryDir() {
  const dir = path.join(os.tmpdir(), 'screenforge-recovery');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return canonicalDirectory(dir);
}

const AUDIO_EXTENSIONS = Object.freeze(['.mp3', '.aac', '.m4a', '.wav', '.flac', '.ogg']);
const SUBTITLE_EXTENSIONS = Object.freeze(['.srt']);
const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
const ARTIFACT_EXTENSIONS = Object.freeze([...VIDEO_EXTENSIONS, '.gif', '.png', '.jpg', '.jpeg']);
const fileCapabilities = new Map();

function canonicalDirectory(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 4096 || rawPath.includes('\0')) {
    throw new Error('Invalid directory');
  }
  const absolute = path.resolve(rawPath);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Directory must not be a symbolic link');
  return fs.realpathSync(absolute);
}

function canonicalRegularFile(rawPath, extensions = []) {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 4096 || rawPath.includes('\0')) {
    throw new Error('Invalid file path');
  }
  const absolute = path.resolve(rawPath);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('A regular file is required');
  const allowed = extensions.map(value => String(value).toLowerCase());
  if (allowed.length && !allowed.includes(path.extname(absolute).toLowerCase())) {
    throw new Error('Unsupported file type');
  }
  return fs.realpathSync(absolute);
}

function grantFile(rawPath, capability, extensions = []) {
  const canonical = canonicalRegularFile(rawPath, extensions);
  const grants = fileCapabilities.get(canonical) || new Set();
  grants.add(capability);
  fileCapabilities.set(canonical, grants);
  return canonical;
}

function requireGrantedFile(rawPath, capabilities, extensions = []) {
  const canonical = canonicalRegularFile(rawPath, extensions);
  const allowed = Array.isArray(capabilities) ? capabilities : [capabilities];
  const grants = fileCapabilities.get(canonical);
  if (!grants || !allowed.some(capability => grants.has(capability))) {
    throw new Error('Choose this file in ScreenForge before using it');
  }
  return canonical;
}

function revokeFile(rawPath) {
  try { fileCapabilities.delete(fs.realpathSync(path.resolve(String(rawPath)))); } catch {}
}

function defaultOutputDirectory() {
  const desktop = path.join(os.homedir(), 'Desktop');
  fs.mkdirSync(desktop, { recursive: true });
  return canonicalDirectory(desktop);
}

function approvedOutputDirectory(requestedPath) {
  const defaultDir = defaultOutputDirectory();
  const approved = new Set([defaultDir]);
  const stored = store?.get('approvedOutputDir');
  if (store?.get('approvedOutputDirVersion') === 1 && typeof stored === 'string') {
    try { approved.add(canonicalDirectory(stored)); } catch {}
  }
  const candidate = requestedPath ? canonicalDirectory(String(requestedPath)) : defaultDir;
  if (!approved.has(candidate)) throw new Error('Choose the export destination in ScreenForge first');
  return candidate;
}

function safeArtifactPath(directory, requestedName, fallbackName, extensions = ARTIFACT_EXTENSIONS) {
  const rawName = path.basename(String(requestedName || fallbackName));
  let extension = path.extname(rawName).toLowerCase();
  if (!extensions.includes(extension)) extension = path.extname(fallbackName).toLowerCase();
  const fallbackStem = path.basename(fallbackName, path.extname(fallbackName));
  const stem = cleanFilenameStem(path.basename(rawName, path.extname(rawName)), fallbackStem);
  return resolveContainedPath(directory, `${stem}${extension}`, {
    directChild: true,
    extensions,
  });
}

function uniqueArtifactPath(directory, requestedName, fallbackName, extensions = ARTIFACT_EXTENSIONS) {
  const first = safeArtifactPath(directory, requestedName, fallbackName, extensions);
  const extension = path.extname(first);
  const stem = path.basename(first, extension);
  for (let suffix = 1; suffix < 10000; suffix += 1) {
    const name = suffix === 1 ? `${stem}${extension}` : `${stem} ${suffix}${extension}`;
    try {
      return reserveContainedFile(directory, name, {
        directChild: true,
        extensions,
      });
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'ELOOP') continue;
      throw error;
    }
  }
  throw new Error('Could not reserve a unique output filename');
}

function discardReservedFile(filePath) {
  try { fs.unlinkSync(filePath); } catch {}
}

function uniqueLibraryPath(dir, stem, extension, currentPath = null) {
  for (let suffix = 1; suffix < 10000; suffix += 1) {
    const name = suffix === 1 ? `${stem}${extension}` : `${stem} ${suffix}${extension}`;
    const candidate = resolveContainedPath(dir, name, {
      directChild: true,
      extensions: VIDEO_EXTENSIONS,
    });
    if (candidate === currentPath) return candidate;
    try {
      return reserveContainedFile(dir, name, {
        directChild: true,
        extensions: VIDEO_EXTENSIONS,
      });
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'ELOOP') continue;
      throw error;
    }
  }
  throw new Error('Could not reserve a unique library filename');
}

function getCaptionTempDir() {
  const directory = path.join(os.tmpdir(), 'screenforge-captions');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return canonicalDirectory(directory);
}

function createTrustedSubtitleAlias(sourcePath) {
  const subtitleData = readBoundedRegularFile(sourcePath, MAX_SUBTITLE_BYTES);
  const directory = canonicalDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-caption-burn-')));
  fs.chmodSync(directory, 0o700);
  const aliasPath = resolveContainedPath(directory, 'captions.srt', {
    directChild: true,
    extensions: SUBTITLE_EXTENSIONS,
  });
  try {
    fs.writeFileSync(aliasPath, subtitleData, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    try { fs.rmdirSync(directory); } catch {}
    throw error;
  }
  return {
    path: aliasPath,
    cleanup() {
      try { fs.unlinkSync(aliasPath); } catch {}
      try { fs.rmdirSync(directory); } catch {}
    },
  };
}

function readLibraryMetadata(metaPath) {
  try {
    const safePath = resolveContainedPath(getLibraryDir(), metaPath, {
      directChild: true,
      extensions: ['.json'],
    });
    const stat = fs.lstatSync(safePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) return {};
    return JSON.parse(fs.readFileSync(safePath, 'utf8'));
  } catch {
    return {};
  }
}

function safeLibraryThumbnail(thumbPath) {
  try {
    const safePath = resolveContainedPath(getLibraryDir(), thumbPath, {
      directChild: true,
      extensions: ['.jpg', '.jpeg', '.png'],
    });
    const stat = fs.lstatSync(safePath);
    return !stat.isSymbolicLink() && stat.isFile() ? safePath : null;
  } catch {
    return null;
  }
}

function safeLibraryWritablePath(rawPath, extensions) {
  const libraryDir = getLibraryDir();
  const safePath = resolveContainedPath(libraryDir, rawPath, {
    directChild: true,
    extensions,
  });
  try {
    const stat = fs.lstatSync(safePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Unsafe library sidecar');
    return safePath;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return reserveContainedFile(libraryDir, path.basename(safePath), {
    directChild: true,
    extensions,
  });
}

// ─── WebSocket remote-control server ─────────────────────────────────────────
let wsServer = null, wsPort = 0;
const remoteToken = randomBytes(24).toString('hex');
let recState = { isRec: false, isPaused: false, elapsed: 0, sessionId: null };
let activeCaptureSourceId = null;
const activeNativeMicSessions = new Map();
const NATIVE_AUDIO_EXTENSIONS = Object.freeze(['.wav', '.pcm', '.s16le']);

function hasValidRemoteToken(value) {
  const provided = Buffer.from(String(value || ''));
  const expected = Buffer.from(remoteToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function startWsServer() {
  if (wsServer) return;
  const httpServer = http.createServer((req, res) => {
    let requestUrl;
    try {
      requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (requestUrl.pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    if (!hasValidRemoteToken(requestUrl.searchParams.get('token'))) {
      res.writeHead(401, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end('Unauthorized');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ws:; img-src data:; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    res.end(remoteControlPage());
  });
  wsServer = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  httpServer.on('upgrade', (req, socket, head) => {
    let requestUrl;
    try {
      requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }
    if (requestUrl.pathname !== '/' || !hasValidRemoteToken(requestUrl.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, ws => wsServer.emit('connection', ws, req));
  });
  wsServer.on('connection', (ws) => {
    // Send current state
    ws.send(JSON.stringify({ type: 'state', ...recState }));
    ws.on('message', (msg) => {
      try {
        const cmd = JSON.parse(msg.toString('utf8'));
        const actions = {
          stop: 'global-stop',
          pause: 'float-pause',
          marker: 'float-marker',
          screenshot: 'float-screenshot',
        };
        if (typeof cmd?.action === 'string' && actions[cmd.action]) {
          safeSend(mainWindow, actions[cmd.action]);
        }
      } catch {}
    });
  });
  httpServer.listen(0, '0.0.0.0', () => {
    wsPort = httpServer.address().port;
    log.info(`ScreenForge remote control: http://localhost:${wsPort}`);
  });
}

function broadcastWsState(update) {
  Object.assign(recState, update);
  if (!wsServer) return;
  const msg = JSON.stringify({ type: 'state', ...recState });
  wsServer.clients.forEach(c => { try { c.send(msg); } catch {} });
}

function isLiveWindow(win) {
  try {
    return !!win && !win.isDestroyed?.() && !!win.webContents && !win.webContents.isDestroyed?.();
  } catch {
    return false;
  }
}

function safeSend(win, channel, payload) {
  try {
    if (!isLiveWindow(win)) return false;
    win.webContents.send(channel, payload);
    return true;
  } catch (err) {
    if (!/Object has been destroyed/i.test(String(err?.message || err))) {
      log.warn?.(`ScreenForge IPC send failed on ${channel}: ${err?.message || err}`);
    }
    return false;
  }
}

function safeWindowAction(win, action) {
  try {
    if (!win || win.isDestroyed?.()) return false;
    win[action]?.();
    return true;
  } catch {
    return false;
  }
}

function isTrustedLocalUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return false;
    resolveContainedPath(__dirname, decodeURIComponent(url.pathname), { allowRoot: true });
    return true;
  } catch {
    return false;
  }
}

function isExactLocalPageUrl(rawUrl, expectedPath) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) return false;
    return path.resolve(fileURLToPath(url)) === path.resolve(expectedPath);
  } catch {
    return false;
  }
}

function isMainMediaOwner(webContents, requestUrl = '') {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false;
  if (webContents !== mainWindow.webContents) return false;
  if (!isExactLocalPageUrl(webContents.getURL(), IPC_ROLE_PAGES.main)) return false;
  if (!requestUrl || requestUrl === 'null') return true;
  if (isExactLocalPageUrl(requestUrl, IPC_ROLE_PAGES.main)) return true;
  try {
    const origin = new URL(requestUrl);
    return origin.protocol === 'file:' && !origin.hostname && (origin.pathname === '' || origin.pathname === '/');
  } catch {
    return false;
  }
}

function lockDownWindowNavigation(win) {
  if (!win?.webContents) return;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const preventUntrustedNavigation = (event, targetUrl) => {
    if (!isTrustedLocalUrl(targetUrl)) event.preventDefault();
  };
  win.webContents.on('will-navigate', preventUntrustedNavigation);
  win.webContents.on('will-redirect', preventUntrustedNavigation);
}

function remoteControlPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ScreenForge Remote</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#080b14;font-family:-apple-system,sans-serif;color:#dce8f8;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:24px}
  h1{font-size:18px;font-weight:700;opacity:.6;letter-spacing:.08em}
  .dot{width:10px;height:10px;border-radius:50%;background:#f87171;display:inline-block;margin-right:6px;animation:pulse 1.2s infinite}
  .dot.paused{background:#fbbf24;animation:none}
  .dot.idle{background:#6b7280;animation:none}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.2}}
  .status{font-size:14px;font-weight:600}
  .timer{font-size:48px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;width:100%;max-width:320px}
  button{border:none;border-radius:16px;padding:18px;font-size:14px;font-weight:700;cursor:pointer;transition:background .15s;display:flex;flex-direction:column;align-items:center;gap:6px}
  .stop{background:rgba(248,113,113,.2);color:#fca5a5;grid-column:span 2}
  .stop:active{background:rgba(248,113,113,.4)}
  .pause{background:rgba(251,191,36,.15);color:#fde68a}
  .pause:active{background:rgba(251,191,36,.3)}
  .mark{background:rgba(99,102,241,.18);color:#a5b4fc}
  .mark:active{background:rgba(99,102,241,.35)}
  .shot{background:rgba(16,185,129,.12);color:#6ee7b7}
  .shot:active{background:rgba(16,185,129,.25)}
  .icon{font-size:26px}
</style></head>
<body>
<h1>⬡ SCREENFORGE REMOTE</h1>
<div class="status"><span class="dot idle" id="dot"></span><span id="statusLabel">Not recording</span></div>
<div class="timer" id="timer">0:00</div>
<div class="grid">
  <button class="stop" onclick="send('stop')"><span class="icon">⏹</span>Stop</button>
  <button class="pause" id="pauseBtn" onclick="send('pause')"><span class="icon" id="pauseIcon">⏸</span><span id="pauseLabel">Pause</span></button>
  <button class="mark" onclick="send('marker')"><span class="icon">⦿</span>Marker</button>
  <button class="shot" onclick="send('screenshot')"><span class="icon">▣</span>Screenshot</button>
</div>
<script>
  let ws, startedAt=0, paused=false, pausedAt=0, totalPaused=0;
  const dot=document.getElementById('dot'),label=document.getElementById('statusLabel'),
        timer=document.getElementById('timer'),pauseBtn=document.getElementById('pauseBtn'),
        pauseIcon=document.getElementById('pauseIcon'),pauseLabel=document.getElementById('pauseLabel');
  function connect(){
    const token=new URLSearchParams(location.search).get('token')||'';
    ws=new WebSocket('ws://'+location.host+'/?token='+encodeURIComponent(token));
    ws.onmessage=e=>{
      const d=JSON.parse(e.data);
      if(d.isRec&&!d.isPaused){dot.className='dot';label.textContent='Recording';startedAt=Date.now()-(d.elapsed||0);paused=false;}
      else if(d.isRec&&d.isPaused){dot.className='dot paused';label.textContent='Paused';paused=true;pausedAt=Date.now();}
      else{dot.className='dot idle';label.textContent='Stopped';}
      pauseIcon.textContent=d.isPaused?'▶':'⏸';pauseLabel.textContent=d.isPaused?'Resume':'Pause';
    };
    ws.onclose=()=>setTimeout(connect,2000);
  }
  function send(a){ws&&ws.readyState===1&&ws.send(JSON.stringify({action:a}));}
  setInterval(()=>{
    if(!startedAt||paused)return;
    const s=Math.floor((Date.now()-startedAt-totalPaused)/1000);
    timer.textContent=Math.floor(s/60)+':'+(s%60+'').padStart(2,'0');
  },500);
  connect();
</script></body></html>`;
}

// IPC: registered at module load so renderer never races

function serializeCaptureSources(sources, displays = screen.getAllDisplays()) {
  const SKIP = /^(ScreenForge|Electron Helper|com\.github\.electron|UserNotificationCenter)/i;
  return sources
    .filter(s => !SKIP.test(s.name))
    .map(s => {
      const isScreen = s.id.startsWith('screen:');
      let bounds = null;
      let displayId = '';
      let scaleFactor = 1;
      if (isScreen) {
        displayId = String(s.display_id || '');
        const matchedDisplay = displays.find(display => String(display.id) === displayId);
        bounds = matchedDisplay?.bounds || (displays.length === 1 ? displays[0].bounds : null);
        scaleFactor = Number(matchedDisplay?.scaleFactor || displays[0]?.scaleFactor || 1);
      }
      // Safe thumbnail extraction: NativeImage.toDataURL() returns '' for empty images
      let thumbnail = null;
      try {
        const dataUrl = isBlankNativeImage(s.thumbnail) ? null : s.thumbnail.toDataURL();
        // A truly empty NativeImage produces a tiny 1x1 transparent PNG, so check length
        if (dataUrl && dataUrl.length > 200) thumbnail = dataUrl;
      } catch {}

      let appIcon = null;
      try {
        const iconUrl = s.appIcon?.toDataURL();
        if (iconUrl && iconUrl.length > 200) appIcon = iconUrl;
      } catch {}

      return {
        id: String(s.id || '').slice(0, 240),
        name: cleanDisplayText(s.name, isScreen ? 'Display' : 'Untitled window', 240),
        thumbnail,
        appIcon,
        isScreen,
        bounds,
        displayId,
        scaleFactor,
      };
    })
    // Screens first, then windows alphabetically
    .sort((a, b) => {
      if (a.isScreen !== b.isScreen) return a.isScreen ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function sourceDiscoveryErrorLogger(context) {
  return (error, permission) => {
    const detail = cleanDisplayText(error?.message, 'Unknown source discovery error', 240);
    log.warn?.(`ScreenForge ${context} failed with Screen Recording status ${permission}: ${detail}`);
  };
}

handleFrom('main', 'get-sources', async () => {
  const displays = screen.getAllDisplays();
  return discoverCaptureSources({
    platform: process.platform,
    systemPreferences,
    enumerateSources: () => desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 640, height: 360 },
      fetchWindowIcons: true,
    }),
    transformSources: sources => serializeCaptureSources(sources, displays),
    onError: sourceDiscoveryErrorLogger('source discovery'),
  });
});

handleFrom('main', 'open-screen-recording-settings', async () => {
  if (process.platform !== 'darwin') return false;
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  return true;
});

function isBlankNativeImage(image) {
  try {
    if (!image || image.isEmpty()) return true;
    const sample = image.resize({ width: 8, height: 8, quality: 'good' }).toBitmap();
    if (!sample?.length) return true;
    let lit = 0;
    for (let i = 0; i < sample.length; i += 4) {
      const b = sample[i];
      const g = sample[i + 1];
      const r = sample[i + 2];
      const a = sample[i + 3];
      if (a > 16 && (r + g + b) > 36) lit++;
    }
    return lit < 3;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Global input capture (uiohook) - RECORDING-GATED.
//
// uiohook taps every keystroke and mouse click on the entire machine, not just
// inside ScreenForge. Running it for the app's whole lifetime means that merely
// having ScreenForge open logs passwords typed into other applications. The hook
// therefore only runs between 'recording-started' and 'recording-stopped'.
//
// Listeners are bound exactly once; only start/stop is toggled, because
// uIOhook.on() stacks duplicate handlers if called again.
// ---------------------------------------------------------------------------
let inputHookListenersBound = false;
let inputHookRunning = false;

function bindInputHookListeners() {
  if (!uIOhook || inputHookListenersBound) return;
  try {
    uIOhook.on('mousedown', e => {
      if (!inputHookRunning) return;
      const point = screen.getCursorScreenPoint();
      const payload = {
        x: point.x, y: point.y,
        button: e.button,
        bounds: activeSourceBounds,
        at: Date.now(),
      };
      safeSend(mainWindow, 'mouse-down', payload);
      safeSend(floatBar, 'mouse-down', payload);
    });
    uIOhook.on('keydown', e => {
      if (!inputHookRunning) return;
      const payload = {
        keycode: e.keycode,
        altKey: !!e.altKey,
        ctrlKey: !!e.ctrlKey,
        metaKey: !!e.metaKey,
        shiftKey: !!e.shiftKey,
        at: Date.now(),
      };
      safeSend(mainWindow, 'key-down', payload);
      safeSend(floatBar, 'key-down', payload);
    });
    inputHookListenersBound = true;
  } catch {
    uIOhook = null;
  }
}

function startInputHook() {
  if (!uIOhook || inputHookRunning) return;
  bindInputHookListeners();
  if (!uIOhook) return;
  try {
    uIOhook.start();
    inputHookRunning = true;
    log.info('ScreenForge input capture started (recording)');
  } catch (err) {
    inputHookRunning = false;
    log.warn?.(`ScreenForge could not start input capture: ${err.message}`);
  }
}

function stopInputHook() {
  if (!uIOhook) return;
  inputHookRunning = false;
  try {
    uIOhook.stop();
    log.info('ScreenForge input capture stopped');
  } catch {}
}

function inputHookIsRunning() {
  return inputHookRunning;
}

// Hide main window + show floating bar when recording starts
onFrom('main', 'recording-started', (_, info = {}) => {
  startInputHook();
  safeWindowAction(mainWindow, 'hide');
  showFloatBar(info);
  broadcastWsState({ isRec: true, isPaused: false, elapsed: 0, sessionId: info.sessionId || null });
  updateTrayMenu();
});

// Show main window + close floating bar when recording stops
onFrom('main', 'recording-stopped', () => {
  stopInputHook();
  safeWindowAction(floatBar, 'close');
  floatBar = null;
  safeWindowAction(mainWindow, 'show');
  safeWindowAction(mainWindow, 'focus');
  broadcastWsState({ isRec: false, isPaused: false, elapsed: 0 });
  updateTrayMenu();
});

handleFrom('main', 'start-native-mic-recording', async (_, options = {}) => {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'Native microphone capture is only available on macOS.' };
  }

  const sessionId = safeSessionId(options.sessionId);
  const existing = activeNativeMicSessions.get(sessionId);
  if (existing) {
    return { ok: true, sessionId, audioPath: existing.audioPath, device: existing.device, reused: true };
  }

  const ffPath = getFfmpegPath();
  const devices = await listAvfoundationAudioDevices(ffPath);
  const device = chooseNativeMicDevice(devices, options.preferredLabel || '');
  if (!device) {
    return { ok: false, reason: 'No AVFoundation microphone devices were found.', devices };
  }

  const audioName = `screenforge-native-mic-${sessionId}-${randomBytes(12).toString('hex')}.wav`;
  const audioPath = reserveContainedFile(os.tmpdir(), audioName, {
    directChild: true,
    extensions: NATIVE_AUDIO_EXTENSIONS,
  });
  const args = [
    '-hide_banner',
    '-y',
    '-fflags', '+genpts',
    '-thread_queue_size', '4096',
    '-f', 'avfoundation',
    '-i', `:${device.index}`,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ac', '1',
    '-ar', '48000',
    audioPath,
  ];

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(ffPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      discardReservedFile(audioPath);
      resolve({ ok: false, reason: `Native microphone recorder could not start: ${err.message}`, devices });
      return;
    }

    const rec = {
      proc,
      audioPath,
      audioFormat: 'wav',
      device,
      stderr: '',
      stopping: false,
      stopPromise: null,
    };
    activeNativeMicSessions.set(sessionId, rec);

    let settled = false;
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      if (proc.exitCode === null) {
        log.info(`ScreenForge native mic recording started on ${device.name} (${audioPath})`);
        settle({ ok: true, sessionId, audioPath, audioFormat: 'wav', sampleRate: 48000, channels: 1, device, devices });
      }
    }, 1800);

    proc.stderr.on('data', d => {
      rec.stderr += d.toString();
      if (!settled && /(Input #0|Output #0|Press \[q\]|Stream mapping)/i.test(rec.stderr)) {
        log.info(`ScreenForge native mic recording started on ${device.name} (${audioPath})`);
        settle({ ok: true, sessionId, audioPath, audioFormat: 'wav', sampleRate: 48000, channels: 1, device, devices });
      }
    });

    proc.on('error', err => {
      activeNativeMicSessions.delete(sessionId);
      settle({ ok: false, reason: `Native microphone recorder failed: ${err.message}`, devices });
    });

    proc.on('close', code => {
      activeNativeMicSessions.delete(sessionId);
      if (!settled) {
        settle({
          ok: false,
          reason: `Native microphone recorder exited before capture started (${code}).`,
          code,
          stderr: rec.stderr.slice(-1200),
          devices,
        });
      }
    });
  });
});

function stopNativeMicRecording(sessionIdRaw) {
  const sessionId = safeSessionId(sessionIdRaw);
  const rec = activeNativeMicSessions.get(sessionId);
  if (!rec) return Promise.resolve({ ok: false, reason: 'Native microphone capture is not active.' });
  if (rec.stopPromise) return rec.stopPromise;

  rec.stopping = true;
  rec.stopPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(interruptTimer);
      clearTimeout(killTimer);
      activeNativeMicSessions.delete(sessionId);
      let bytes = fileUsable(rec.audioPath, 2) ? fs.statSync(rec.audioPath).size : 0;
      const frameBytes = rec.audioFormat === 's16le' ? 2 : 1;
      if (frameBytes > 1 && bytes % frameBytes) {
        bytes -= bytes % frameBytes;
        try { fs.truncateSync(rec.audioPath, bytes); } catch {}
      }
      const ok = bytes > 1024;
      let grantedAudioPath = null;
      if (ok) {
        try { grantedAudioPath = grantFile(rec.audioPath, 'native-audio', NATIVE_AUDIO_EXTENSIONS); }
        catch { grantedAudioPath = null; }
      }
      log.info(`ScreenForge native mic recording stopped: ${rec.audioPath} (${bytes} bytes)`);
      resolve({
        ok: Boolean(grantedAudioPath),
        sessionId,
        audioPath: grantedAudioPath,
        audioFormat: rec.audioFormat || 'wav',
        sampleRate: 48000,
        channels: 1,
        bytes,
        code,
        device: rec.device,
        stderr: rec.stderr.slice(-1200),
      });
    };

    const interruptTimer = setTimeout(() => {
      try { rec.proc.kill('SIGINT'); } catch {}
    }, 1500);
    const killTimer = setTimeout(() => {
      try { rec.proc.kill('SIGKILL'); } catch {}
    }, 5000);

    rec.proc.once('close', finish);
    try { rec.proc.kill('SIGINT'); } catch {}
  });
  return rec.stopPromise;
}

handleFrom('main', 'stop-native-mic-recording', async (_, { sessionId } = {}) => stopNativeMicRecording(sessionId));

// Export
handleFrom('main', 'save-recording', async (_, {
  buffer,
  hasPad,
  recoveryPath,
  nativeAudioPath,
  nativeAudioOffsetMs,
  nativeAudioFormat,
  nativeAudioSampleRate,
  nativeAudioChannels,
}) => {
  const recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-recording-'));
  fs.chmodSync(recordingDir, 0o700);
  const raw = path.join(recordingDir, 'source.webm');
  const out = path.join(recordingDir, 'recording.webm');

  let safeRecoveryPath = null;
  if (recoveryPath) {
    safeRecoveryPath = requireGrantedFile(recoveryPath, 'recovery', ['.webm']);
  }
  if (safeRecoveryPath && fs.existsSync(safeRecoveryPath)) {
    fs.copyFileSync(safeRecoveryPath, raw);
  } else {
    // buffer may arrive as ArrayBuffer (structured clone) or plain array
    if (!buffer) throw new Error('No recording data was provided');
    const buf = buffer instanceof ArrayBuffer ? Buffer.from(buffer) : Buffer.from(new Uint8Array(buffer));
    fs.writeFileSync(raw, buf);
  }

  const ffPath = getFfmpegPath();
  let safeNativeAudioPath = null;
  if (nativeAudioPath) {
    safeNativeAudioPath = requireGrantedFile(nativeAudioPath, 'native-audio', NATIVE_AUDIO_EXTENSIONS);
  }
  const useNativeAudio = fileUsable(safeNativeAudioPath);
  const rawHasAudio = useNativeAudio ? await mediaFileHasAudio(raw, ffPath) : false;
  const rawDurationSec = useNativeAudio ? await mediaFileDuration(raw, ffPath) : 0;
  const args = buildSaveRecordingArgs({
    raw,
    out,
    nativeAudioPath: safeNativeAudioPath,
    nativeAudioOffsetMs,
    nativeAudioFormat,
    nativeAudioSampleRate,
    nativeAudioChannels,
    rawHasAudio,
    rawDurationSec,
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (pathToOpen, message) => {
      if (settled) return;
      settled = true;
      log.info(message);
      try {
        resolve(grantFile(pathToOpen, 'media', VIDEO_EXTENSIONS));
      } catch (error) {
        log.error?.(`ScreenForge could not authorize the recording: ${error.message}`);
        resolve(null);
      }
    };

    let ff;
    try {
      ff = spawn(ffPath, args);
    } catch (err) {
      finish(raw, `ScreenForge saved raw recording; remux spawn failed: ${err.message}`);
      return;
    }

    ff.on('error', err => {
      finish(raw, `ScreenForge saved raw recording; remux failed: ${err.message}`);
    });
    ff.on('close', code => {
      if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) {
        try { fs.unlinkSync(raw); } catch {}
        if (useNativeAudio) {
          try { fs.unlinkSync(safeNativeAudioPath); } catch {}
          revokeFile(safeNativeAudioPath);
        }
        finish(out, `ScreenForge saved ${useNativeAudio ? 'recording with native microphone audio' : 'remuxed recording'}: ${out}`);
      } else {
        finish(raw, `ScreenForge saved raw recording; remux exited ${code}`);
      }
    });
  });
});

handleFrom('main', 'open-video-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import video',
    properties: ['openFile'],
    filters: [
      { name: 'Video', extensions: ['mp4', 'mov', 'webm', 'm4v', 'mkv'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : grantFile(result.filePaths[0], 'media', VIDEO_EXTENSIONS);
});

handleFrom('main', 'save-project-file', async (_, project) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save ScreenForge project',
    defaultPath: path.join(os.homedir(), 'Desktop', `ScreenForge-${Date.now()}.screenforge`),
    filters: [{ name: 'ScreenForge Project', extensions: ['screenforge'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, JSON.stringify(project, null, 2));
  return result.filePath;
});

handleFrom('main', 'open-project-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open ScreenForge project',
    properties: ['openFile'],
    filters: [{ name: 'ScreenForge Project', extensions: ['screenforge'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const projectPath = canonicalRegularFile(result.filePaths[0], ['.screenforge']);
  const data = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  if (!data || typeof data !== 'object') throw new Error('Invalid ScreenForge project');
  if (typeof data.videoPath === 'string') {
    const videoPath = path.isAbsolute(data.videoPath)
      ? data.videoPath
      : path.resolve(path.dirname(projectPath), data.videoPath);
    data.videoPath = grantFile(videoPath, 'media', VIDEO_EXTENSIONS);
  }
  if (typeof data.backgroundMusicPath === 'string') {
    try { data.backgroundMusicPath = grantFile(data.backgroundMusicPath, 'audio', AUDIO_EXTENSIONS); }
    catch { data.backgroundMusicPath = null; }
  }
  if (typeof data.transcript?.srtPath === 'string') {
    try { data.transcript.srtPath = grantFile(data.transcript.srtPath, 'subtitle', SUBTITLE_EXTENSIONS); }
    catch { data.transcript.srtPath = null; }
  }
  return { filePath: projectPath, project: data };
});

handleFrom('main', 'select-capture-area', async (_, sourceBounds) => {
  const fallback = screen.getPrimaryDisplay().bounds;
  const bounds = sourceBounds?.width && sourceBounds?.height ? sourceBounds : fallback;
  const wasVisible = !!mainWindow?.isVisible();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('area-selected', onSelected);
      ipcMain.removeListener('area-canceled', onCanceled);
      if (areaPicker && !areaPicker.isDestroyed()) areaPicker.close();
      areaPicker = null;
      if (wasVisible) {
        safeWindowAction(mainWindow, 'show');
        safeWindowAction(mainWindow, 'focus');
      }
      resolve(payload);
    };
    const onSelected = (_event, rect) => {
      if (!isIpcSender(_event, 'area')) return;
      const minSize = 40;
      const xPct = Number.isFinite(Number(rect.xPct)) ? Number(rect.xPct) : Number(rect.x || 0) / bounds.width;
      const yPct = Number.isFinite(Number(rect.yPct)) ? Number(rect.yPct) : Number(rect.y || 0) / bounds.height;
      const wPct = Number.isFinite(Number(rect.wPct)) ? Number(rect.wPct) : Number(rect.w || 0) / bounds.width;
      const hPct = Number.isFinite(Number(rect.hPct)) ? Number(rect.hPct) : Number(rect.h || 0) / bounds.height;
      const x = Math.max(0, Math.min(bounds.width - minSize, xPct * bounds.width));
      const y = Math.max(0, Math.min(bounds.height - minSize, yPct * bounds.height));
      const w = Math.max(minSize, Math.min(bounds.width - x, wPct * bounds.width));
      const h = Math.max(minSize, Math.min(bounds.height - y, hPct * bounds.height));
      finish({
        screenBounds: { x: bounds.x + x, y: bounds.y + y, width: w, height: h },
        sourceBounds: bounds,
        captureArea: {
          xPct: x / bounds.width,
          yPct: y / bounds.height,
          wPct: w / bounds.width,
          hPct: h / bounds.height,
        },
      });
    };
    const onCanceled = (event) => {
      if (!isIpcSender(event, 'area')) return;
      finish(null);
    };

    ipcMain.on('area-selected', onSelected);
    ipcMain.on('area-canceled', onCanceled);
    if (wasVisible) safeWindowAction(mainWindow, 'hide');

    areaPicker = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      fullscreenable: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload-area-picker.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    lockDownWindowNavigation(areaPicker);
    areaPicker.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    areaPicker.loadFile(path.join(__dirname, 'renderer', 'area-picker.html'));
    areaPicker.on('closed', () => finish(null));
  });
});

function hasCommand(cmd) {
  return new Promise(resolve => {
    execFile('which', [cmd], (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

let activeExport = null;

// Final export from editor
handleFrom('main', 'export-final', async (_, options = {}) => {
  const inputPath = requireGrantedFile(options.inputPath, 'media', VIDEO_EXTENSIONS);
  const targetDir = approvedOutputDirectory(options.outputDir);
  const outputPolicy = exportArtifactPolicy(options.format);
  const inputMetadata = await mediaFileMetadata(inputPath);

  let backgroundMusic = options.backgroundMusic || null;
  if (backgroundMusic?.path) {
    const musicPath = requireGrantedFile(backgroundMusic.path, 'audio', AUDIO_EXTENSIONS);
    const duration = await mediaFileDuration(musicPath);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('ScreenForge could not read the selected background music file. Choose another track.');
    }
    backgroundMusic = { ...backgroundMusic, path: musicPath, duration };
  }

  let outputPath = null;
  let plan;
  try {
    outputPath = uniqueArtifactPath(
      targetDir,
      options.outputName,
      `ScreenForge-${Date.now()}${outputPolicy.extension}`,
      outputPolicy.extensions,
    );
    plan = buildExportPlan({
      inputPath,
      outputPath,
      filters: options.filters,
      sourceOverlays: options.sourceOverlays,
      cameraFilters: options.cameraFilters,
      postFilters: options.postFilters,
      presentation: options.presentation,
      audioFilters: options.audioFilters,
      trimIn: options.trimIn,
      trimOut: options.trimOut,
      crf: options.crf,
      format: options.format,
      speedMultiplier: options.speedMultiplier,
      watermark: options.watermark,
      blurZones: options.blurZones,
      removedRanges: options.removedRanges,
      hasAudio: options.hasAudio,
      backgroundMusic,
      sourceFrameRate: inputMetadata.fps,
    });
  } catch (error) {
    if (outputPath) discardReservedFile(outputPath);
    throw error;
  }

  let runtimePlan;
  try {
    runtimePlan = materializeFilterComplexArgs(plan.args);
  } catch (error) {
    discardReservedFile(plan.outputPath);
    throw new Error(`Export graph could not be prepared: ${error.message}`);
  }

  return new Promise((resolve, reject) => {
    let ff;
    try {
      ff = spawn(getFfmpegPath(), runtimePlan.args);
    } catch (error) {
      runtimePlan.cleanup();
      discardReservedFile(plan.outputPath);
      reject(new Error(`FFmpeg could not start: ${error.message}`));
      return;
    }
    const exportState = { process: ff, cancelled: false };
    activeExport = exportState;
    let stderrTail = '';
    let settled = false;

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      runtimePlan.cleanup();
      discardReservedFile(plan.outputPath);
      reject(error);
    };

    ff.stderr.on('data', data => {
      const chunk = data.toString();
      stderrTail = (stderrTail + chunk).slice(-12000);
      const match = chunk.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (match) safeSend(mainWindow, 'export-progress', match[1]);
    });
    ff.on('error', error => {
      if (activeExport === exportState) activeExport = null;
      rejectOnce(new Error(`FFmpeg could not start: ${error.message}`));
    });
    ff.on('close', code => {
      const cancelled = exportState.cancelled;
      if (activeExport === exportState) activeExport = null;
      if (settled) return;
      if (cancelled) {
        rejectOnce(new Error('Export cancelled'));
      } else if (code === 0) {
        settled = true;
        runtimePlan.cleanup();
        try {
          resolve(grantFile(plan.outputPath, 'artifact', outputPolicy.extensions));
        } catch (error) {
          reject(new Error(`Export completed but could not be authorized: ${error.message}`));
        }
      } else {
        const detail = stderrTail.trim().split(/\r?\n/).slice(-2).join(' ');
        rejectOnce(new Error(`Export failed (exit code ${code})${detail ? `: ${detail}` : ''}`));
      }
    });
  });
});

// ─── Settings persistence ─────────────────────────────────────────────────────
const RENDERER_CFG_KEYS = new Set([
  'zoom', 'cursor', 'pad', 'shortcuts', 'clickRings', 'mic', 'systemAudio',
  'audioCleanup', 'audioCleanupDefaultVersion', 'webcam', 'zoomLevel', 'webcamPos',
  'frame', 'webcamRect', 'webcamAvoidCursor', 'captureArea', 'cursorTheme',
  'cursorSize', 'cursorTrail', 'captions', 'fps', 'quality', 'countdown',
  'autoSaveToLibrary', 'micDefaultVersion', 'countdownDefaultVersion',
  'fpsDefaultVersion', 'micDeviceId', 'camDeviceId', 'webcamShape',
  'webcamBorderColor', 'webcamBorderWidth', 'speedMultiplier', 'watermark',
  'directorProfile', 'silenceThreshold', 'silenceMinDuration', 'silencePadding',
  'musicVolume', 'musicDucking', 'bgMode', 'bgSolidColor', 'bgPadding', 'bgBlur',
]);

function rendererCfg(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const safe = {};
  for (const [key, item] of Object.entries(value)) {
    if (RENDERER_CFG_KEYS.has(key)) safe[key] = item;
  }
  return safe;
}

function rendererSettingsSnapshot() {
  const cfg = rendererCfg(store?.get('cfg'));
  const approvedOutputDir = store?.get('approvedOutputDir');
  if (store?.get('approvedOutputDirVersion') === 1 && typeof approvedOutputDir === 'string') {
    try { cfg.outputDir = approvedOutputDirectory(approvedOutputDir); } catch {}
  }
  return {
    cfg,
    adj: store?.get('adj') || {},
    bgPreset: store?.get('bgPreset') ?? 0,
  };
}

handleFrom('main', 'get-all-settings', () => rendererSettingsSnapshot());
handleFrom('main', 'get-setting', (_, key) => key === 'templates' ? (store?.get('templates') || {}) : null);
handleFrom('main', 'set-setting', (_, key, value) => {
  if (key !== 'templates') throw new Error('This setting is owned by ScreenForge');
  const encoded = JSON.stringify(value || {});
  if (encoded.length > 500000) throw new Error('Template data is too large');
  store?.set('templates', JSON.parse(encoded));
  return true;
});
handleFrom('main', 'set-settings', (_, value = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings payload');
  if (Object.prototype.hasOwnProperty.call(value, 'cfg')) store?.set('cfg', rendererCfg(value.cfg));
  if (Object.prototype.hasOwnProperty.call(value, 'adj')) {
    const raw = value.adj && typeof value.adj === 'object' ? value.adj : {};
    const adj = Object.fromEntries(['b', 'c', 's'].map(key => [key, Math.max(-50, Math.min(50, Number(raw[key]) || 0))]));
    store?.set('adj', adj);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'bgPreset')) {
    store?.set('bgPreset', Math.max(0, Math.min(5, Math.round(Number(value.bgPreset) || 0))));
  }
  return true;
});

// ─── Session ID generator ─────────────────────────────────────────────────────
handleFrom('main', 'new-session-id', () => uuidv4 ? uuidv4() : `sess-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);

// ─── Clip library ─────────────────────────────────────────────────────────────
handleFrom('main', 'get-library-dir', () => getLibraryDir());

handleFrom('main', 'set-library-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose clip library folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: getLibraryDir(),
  });
  if (result.canceled) return null;
  const directory = canonicalDirectory(result.filePaths[0]);
  store?.set('libraryDir', directory);
  store?.set('libraryDirApprovedVersion', 1);
  return directory;
});

handleFrom('main', 'get-clip-library', async () => {
  const dir = getLibraryDir();
  try {
    const files = fs.readdirSync(dir)
      .filter(f => /\.(mp4|mov|webm|mkv|m4v)$/i.test(f))
      .map(f => {
        let p;
        try { p = grantFile(path.join(dir, f), 'media', VIDEO_EXTENSIONS); }
        catch { return null; }
        const stat = fs.lstatSync(p);
        const metaPath = p.replace(/\.[^.]+$/, '.json');
        const meta = readLibraryMetadata(metaPath);
        const thumbPath = p.replace(/\.[^.]+$/, '.thumb.jpg');
        const title = cleanDisplayText(meta?.title, f, 200);
        const tags = Array.isArray(meta?.tags)
          ? meta.tags.map(tag => cleanDisplayText(tag, '', 60)).filter(Boolean).slice(0, 24)
          : [];
        const savedAt = typeof meta?.savedAt === 'string' && Number.isFinite(Date.parse(meta.savedAt))
          ? new Date(meta.savedAt).toISOString()
          : stat.mtime.toISOString();
        return {
          name: f,
          path: p,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          thumbnail: safeLibraryThumbnail(thumbPath),
          title,
          tags,
          savedAt,
        };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    return files;
  } catch { return []; }
});

handleFrom('main', 'save-to-library', async (_, payload = {}) => {
  const { sourcePath, title, tags = [] } = payload;
  const safeSourcePath = requireGrantedFile(sourcePath, ['media', 'artifact'], VIDEO_EXTENSIONS);
  const dir = getLibraryDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = path.extname(safeSourcePath).toLowerCase();
  if (!VIDEO_EXTENSIONS.includes(ext)) throw new Error('Unsupported recording format');
  const safeTitle = cleanDisplayText(title, `Recording ${ts}`, 160);
  const safeName = cleanFilenameStem(safeTitle, `Recording-${ts}`);
  const dest = uniqueLibraryPath(dir, safeName, ext);
  try {
    fs.copyFileSync(safeSourcePath, dest);
    // Write sidecar metadata
    const safeTags = Array.isArray(tags)
      ? tags.map(tag => cleanDisplayText(tag, '', 60)).filter(Boolean).slice(0, 24)
      : [];
    const meta = { title: safeTitle, tags: safeTags, savedAt: new Date().toISOString() };
    const metaPath = safeLibraryWritablePath(dest.replace(/\.[^.]+$/, '.json'), ['.json']);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    // Generate thumbnail
    await generateThumbnail(dest);
    return grantFile(dest, 'media', VIDEO_EXTENSIONS);
  } catch (error) {
    discardReservedFile(dest);
    throw error;
  }
});

handleFrom('main', 'delete-clip', async (_, filePath) => {
  try {
    const safePath = resolveContainedPath(getLibraryDir(), filePath, {
      directChild: true,
      extensions: VIDEO_EXTENSIONS,
    });
    const canonicalPath = canonicalRegularFile(safePath, VIDEO_EXTENSIONS);
    fs.unlinkSync(canonicalPath);
    revokeFile(canonicalPath);
    // Remove sidecar files
    const base = safePath.replace(/\.[^.]+$/, '');
    ['.json', '.thumb.jpg'].forEach(ext => { try { fs.unlinkSync(base + ext); } catch {} });
    return true;
  } catch { return false; }
});

handleFrom('main', 'rename-clip', async (_, payload = {}) => {
  const dir = getLibraryDir();
  const filePath = resolveContainedPath(dir, payload.filePath, {
    directChild: true,
    extensions: VIDEO_EXTENSIONS,
  });
  const canonicalPath = canonicalRegularFile(filePath, VIDEO_EXTENSIONS);
  const safeTitle = cleanDisplayText(payload.newTitle, '', 160);
  if (!safeTitle) throw new Error('A clip name is required');
  const ext = path.extname(canonicalPath).toLowerCase();
  const safeName = cleanFilenameStem(safeTitle, 'Recording');
  const newPath = uniqueLibraryPath(dir, safeName, ext, canonicalPath);
  if (newPath !== canonicalPath) {
    try { fs.renameSync(canonicalPath, newPath); }
    catch (error) {
      discardReservedFile(newPath);
      throw error;
    }
  }
  // Rename sidecars
  const oldBase = canonicalPath.replace(/\.[^.]+$/, '');
  const newBase = newPath.replace(/\.[^.]+$/, '');
  if (newBase !== oldBase) {
    ['.json', '.thumb.jpg'].forEach(e => {
      try { fs.renameSync(oldBase + e, newBase + e); } catch {}
    });
  }
  // Update json title
  try {
    const meta = readLibraryMetadata(newBase + '.json');
    meta.title = safeTitle;
    const metaPath = safeLibraryWritablePath(newBase + '.json', ['.json']);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch {
    const metaPath = safeLibraryWritablePath(newBase + '.json', ['.json']);
    fs.writeFileSync(metaPath, JSON.stringify({
      title: safeTitle,
      tags: [],
      savedAt: new Date().toISOString(),
    }, null, 2));
  }
  revokeFile(canonicalPath);
  return grantFile(newPath, 'media', VIDEO_EXTENSIONS);
});

handleFrom('main', 'open-library-dir', async () => shell.openPath(getLibraryDir()));

// ─── Thumbnail generation ──────────────────────────────────────────────────────
async function generateThumbnail(videoPath) {
  const safeVideoPath = canonicalRegularFile(videoPath, VIDEO_EXTENSIONS);
  const thumbPath = safeLibraryWritablePath(safeVideoPath.replace(/\.[^.]+$/, '.thumb.jpg'), ['.jpg']);
  const tmpPng = safeLibraryWritablePath(`${thumbPath}.tmp.png`, ['.png']);
  return new Promise((resolve) => {
    const ff = spawn(getFfmpegPath(), [
      '-y', '-ss', '1', '-i', safeVideoPath,
      '-vframes', '1', '-q:v', '2', tmpPng,
    ]);
    ff.on('close', async () => {
      try {
        if (sharp) {
          await sharp(tmpPng).resize(320, 180, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(thumbPath);
          fs.unlinkSync(tmpPng);
        } else {
          fs.renameSync(tmpPng, thumbPath);
        }
        resolve(thumbPath);
      } catch { resolve(null); }
    });
  });
}
handleFrom('main', 'generate-thumbnail', async (_, videoPath) => {
  const safePath = resolveContainedPath(getLibraryDir(), videoPath, {
    directChild: true,
    extensions: VIDEO_EXTENSIONS,
  });
  return generateThumbnail(safePath);
});

// ─── System stats (for live recording overlay) ────────────────────────────────
handleFrom('main', 'get-system-stats', async () => {
  if (!si) return { cpu: 0, mem: 0, disk: 0 };
  try {
    const [cpu, mem] = await Promise.all([
      si.currentLoad(),
      si.mem(),
    ]);
    return {
      cpu:  Math.round(cpu.currentLoad),
      mem:  Math.round((mem.used / mem.total) * 100),
      memUsedGB: (mem.used / 1e9).toFixed(1),
      memTotalGB: (mem.total / 1e9).toFixed(1),
    };
  } catch { return { cpu: 0, mem: 0 }; }
});

// ─── Silence detection ────────────────────────────────────────────────────────
handleFrom('main', 'silence-detect', async (_, { inputPath, threshold = -35, duration = 0.5 }) => {
  const safeInputPath = requireGrantedFile(inputPath, ['media', 'artifact'], VIDEO_EXTENSIONS);
  const safeThreshold = Math.max(-100, Math.min(-1, Number(threshold) || -35));
  const safeDuration = Math.max(0.05, Math.min(30, Number(duration) || 0.5));
  return new Promise((resolve) => {
    const args = ['-i', safeInputPath, '-af',
      `silencedetect=n=${safeThreshold}dB:d=${safeDuration}`,
      '-f', 'null', '-'];
    const ff = spawn(getFfmpegPath(), args);
    let out = '';
    ff.stderr.on('data', d => out += d.toString());
    ff.on('close', () => {
      const silences = [];
      const startRe = /silence_start:\s*([\d.]+)/g;
      const endRe   = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g;
      let m;
      const starts = [];
      while ((m = startRe.exec(out)) !== null) starts.push(parseFloat(m[1]));
      let i = 0;
      while ((m = endRe.exec(out)) !== null) {
        silences.push({ start: starts[i] || 0, end: parseFloat(m[1]), duration: parseFloat(m[2]) });
        i++;
      }
      resolve(silences);
    });
  });
});

// ─── Merge clips ─────────────────────────────────────────────────────────────
handleFrom('main', 'merge-clips', async (_, { clips, outputName, outputDir }) => {
  if (!Array.isArray(clips) || clips.length < 2 || clips.length > 100) throw new Error('Choose between 2 and 100 clips');
  const safeClips = clips.map(filePath => requireGrantedFile(filePath, ['media', 'artifact'], VIDEO_EXTENSIONS));
  const targetDir = approvedOutputDirectory(outputDir);
  const metadata = await Promise.all(safeClips.map(filePath => mediaFileMetadata(filePath)));
  if (metadata.some(item => !item.width || !item.height || !item.duration)) {
    throw new Error('ScreenForge could not read one or more selected clips');
  }
  const out = uniqueArtifactPath(targetDir, outputName, `Merged-${Date.now()}.mp4`, ['.mp4']);
  let args;
  try {
    args = buildMergeClipsArgs({ clips: safeClips, metadata, outputPath: out });
  } catch (error) {
    discardReservedFile(out);
    throw error;
  }
  return new Promise((resolve, reject) => {
    let ff;
    try { ff = spawn(getFfmpegPath(), args); }
    catch (error) {
      discardReservedFile(out);
      reject(new Error(`Merge could not start: ${error.message}`));
      return;
    }
    let stderrTail = '';
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      discardReservedFile(out);
      reject(error);
    };
    ff.stderr.on('data', data => { stderrTail = (stderrTail + data.toString()).slice(-8000); });
    ff.on('error', error => fail(new Error(`Merge could not start: ${error.message}`)));
    ff.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        const detail = stderrTail.trim().split(/\r?\n/).slice(-2).join(' ');
        fail(new Error(`Merge failed${detail ? `: ${detail}` : ''}`));
        return;
      }
      settled = true;
      try { resolve(grantFile(out, 'artifact', ['.mp4'])); }
      catch (error) { reject(error); }
    });
  });
});

// ─── Background music mix ─────────────────────────────────────────────────────
handleFrom('main', 'pick-bg-music', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose background music',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'aac', 'm4a', 'wav', 'flac', 'ogg'] }],
  });
  return result.canceled ? null : grantFile(result.filePaths[0], 'audio', AUDIO_EXTENSIONS);
});

// ─── GIF preview generation ───────────────────────────────────────────────────
handleFrom('main', 'export-gif-preview', async (_, { inputPath, start = 0, duration = 3, scale = 480, outputDir }) => {
  const safeInputPath = requireGrantedFile(inputPath, ['media', 'artifact'], VIDEO_EXTENSIONS);
  const targetDir = approvedOutputDirectory(outputDir);
  const sourceStem = cleanFilenameStem(path.basename(safeInputPath, path.extname(safeInputPath)), 'ScreenForge');
  const out = uniqueArtifactPath(targetDir, `${sourceStem}-preview.gif`, `ScreenForge-${Date.now()}-preview.gif`, ['.gif']);
  const safeStart = Math.max(0, Math.min(86400, Number(start) || 0));
  const safeDuration = Math.max(0.2, Math.min(15, Number(duration) || 3));
  const safeScale = Math.max(160, Math.min(1920, Math.round(Number(scale) || 480)));
  return new Promise((resolve, reject) => {
    let ff;
    try { ff = spawn(getFfmpegPath(), [
      '-y', '-ss', String(safeStart), '-t', String(safeDuration), '-i', safeInputPath,
      '-vf', `fps=12,scale=${safeScale}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
      '-loop', '0', out,
    ]); } catch (error) {
      discardReservedFile(out);
      reject(new Error(`GIF export could not start: ${error.message}`));
      return;
    }
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      discardReservedFile(out);
      reject(error);
    };
    ff.on('error', error => fail(new Error(`GIF export could not start: ${error.message}`)));
    ff.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error('GIF failed'));
      }
      else {
        settled = true;
        try { resolve(grantFile(out, 'artifact', ['.gif'])); }
        catch (error) { reject(error); }
      }
    });
  });
});

// ─── Remote control ───────────────────────────────────────────────────────────
handleFrom('main', 'get-remote-port', () => wsPort);
handleFrom('main', 'get-remote-url', async () => {
  if (!wsPort) return null;
  try {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          return `http://${addr.address}:${wsPort}/?token=${remoteToken}`;
        }
      }
    }
    return `http://localhost:${wsPort}/?token=${remoteToken}`;
  } catch { return null; }
});

// Relay pause-state back to float bar + WS clients
onFrom('main', 'pause-state', (_, isPaused) => {
  safeSend(floatBar, 'pause-state', isPaused);
  broadcastWsState({ isPaused });
});

// ─── Save SRT caption file ─────────────────────────────────────────────────────
handleFrom('main', 'save-srt', async (_, { srt, videoPath }) => {
  requireGrantedFile(videoPath, ['media', 'artifact'], VIDEO_EXTENSIONS);
  const content = String(srt || '');
  if (!content || Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
    throw new Error('Caption data is empty or too large');
  }
  const captionDir = getCaptionTempDir();
  const srtPath = resolveContainedPath(captionDir, `captions-${randomBytes(12).toString('hex')}.srt`, {
    directChild: true,
    extensions: SUBTITLE_EXTENSIONS,
  });
  fs.writeFileSync(srtPath, content, { mode: 0o600, flag: 'wx' });
  return grantFile(srtPath, 'subtitle', SUBTITLE_EXTENSIONS);
});

// ─── Burn captions into video ─────────────────────────────────────────────────
handleFrom('main', 'burn-captions', async (_, { inputPath, srtPath, outputDir, fontSize = 22 }) => {
  const safeInputPath = requireGrantedFile(inputPath, ['media', 'artifact'], VIDEO_EXTENSIONS);
  const safeSubtitlePath = requireGrantedFile(srtPath, 'subtitle', SUBTITLE_EXTENSIONS);
  const targetDir = approvedOutputDirectory(outputDir);
  const sourceStem = cleanFilenameStem(path.basename(safeInputPath, path.extname(safeInputPath)), 'ScreenForge');
  const out = uniqueArtifactPath(targetDir, `${sourceStem}-captioned.mp4`, `ScreenForge-${Date.now()}-captioned.mp4`, ['.mp4']);
  let subtitleAlias;
  try { subtitleAlias = createTrustedSubtitleAlias(safeSubtitlePath); }
  catch (error) {
    discardReservedFile(out);
    throw error;
  }
  const safeSrt = subtitleAlias.path.replace(/\\/g, '/').replace(/:/g, '\\:');
  const safeFontSize = Math.max(10, Math.min(96, Math.round(Number(fontSize) || 22)));
  return new Promise((resolve, reject) => {
    let ff;
    try { ff = spawn(getFfmpegPath(), [
      '-y', '-i', safeInputPath,
      '-vf', `subtitles='${safeSrt}':force_style='FontSize=${safeFontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2'`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'fast',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out,
    ]); } catch (error) {
      discardReservedFile(out);
      subtitleAlias.cleanup();
      reject(new Error(`Caption burn could not start: ${error.message}`));
      return;
    }
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      discardReservedFile(out);
      subtitleAlias.cleanup();
      reject(error);
    };
    ff.on('error', error => fail(new Error(`Caption burn could not start: ${error.message}`)));
    ff.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error('Caption burn failed'));
      }
      else {
        settled = true;
        subtitleAlias.cleanup();
        try { resolve(grantFile(out, 'artifact', ['.mp4'])); }
        catch (error) { reject(error); }
      }
    });
  });
});

// ─── Normalize audio ─────────────────────────────────────────────────────────
handleFrom('main', 'normalize-audio', async (_, { inputPath, outputDir }) => {
  const safeInputPath = requireGrantedFile(inputPath, ['media', 'artifact'], VIDEO_EXTENSIONS);
  const metadata = await mediaFileMetadata(safeInputPath);
  if (!metadata.hasAudio) throw new Error('This clip has no audio track to normalize');
  const targetDir = approvedOutputDirectory(outputDir);
  const sourceStem = cleanFilenameStem(path.basename(safeInputPath, path.extname(safeInputPath)), 'ScreenForge');
  const out = uniqueArtifactPath(targetDir, `${sourceStem}-normalized.mp4`, `ScreenForge-${Date.now()}-normalized.mp4`, ['.mp4']);
  return new Promise((resolve, reject) => {
    let ff;
    try { ff = spawn(getFfmpegPath(), buildNormalizeAudioArgs({ inputPath: safeInputPath, outputPath: out })); }
    catch (error) {
      discardReservedFile(out);
      reject(new Error(`Normalize could not start: ${error.message}`));
      return;
    }
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      discardReservedFile(out);
      reject(error);
    };
    ff.on('error', error => fail(new Error(`Normalize could not start: ${error.message}`)));
    ff.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error('Normalize failed'));
      }
      else {
        settled = true;
        try { resolve(grantFile(out, 'artifact', ['.mp4'])); }
        catch (error) { reject(error); }
      }
    });
  });
});

// Cancel in-progress export
handleFrom('main', 'cancel-export', async () => {
  if (activeExport) {
    activeExport.cancelled = true;
    try { activeExport.process.kill('SIGTERM'); } catch {}
    return true;
  }
  return false;
});

// Take a screenshot from the primary display
handleFrom('main', 'take-screenshot', async () => {
  let out = null;
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 3840, height: 2160 } });
    if (!sources.length) return null;
    const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    out = uniqueArtifactPath(
      defaultOutputDirectory(),
      `ScreenForge-Screenshot-${ts}.png`,
      `ScreenForge-Screenshot-${Date.now()}.png`,
      ['.png'],
    );
    fs.writeFileSync(out, sources[0].thumbnail.toPNG());
    return grantFile(out, 'artifact', ['.png']);
  } catch {
    if (out) discardReservedFile(out);
    return null;
  }
});

// Shell helpers
handleFrom('main', 'show-in-finder', async (_, filePath) => {
  const safePath = requireGrantedFile(filePath, ['media', 'artifact', 'audio', 'subtitle']);
  shell.showItemInFolder(safePath);
  return true;
});
handleFrom('main', 'copy-to-clipboard', async (_, text) => {
  clipboard.writeText(String(text || '').slice(0, 200000));
  return true;
});

// Choose output directory
handleFrom('main', 'choose-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose export destination',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: path.join(os.homedir(), 'Desktop'),
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const directory = canonicalDirectory(result.filePaths[0]);
  store?.set('approvedOutputDir', directory);
  store?.set('approvedOutputDirVersion', 1);
  return directory;
});

// Auto-save chunk for crash recovery
handleFrom('main', 'auto-save-chunk', async (_, { buffer, sessionId }) => {
  const dir = getRecoveryDir();
  const file = resolveContainedPath(dir, `recovery-${safeSessionId(sessionId)}.webm`, {
    directChild: true,
    namePattern: /^recovery-[a-z0-9_-]+\.webm$/i,
  });
  const buf = buffer instanceof ArrayBuffer ? Buffer.from(buffer) : Buffer.from(new Uint8Array(buffer));
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_TRUNC
    | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(file, flags, 0o600);
  try { fs.writeFileSync(descriptor, buf); }
  finally { fs.closeSync(descriptor); }
  return grantFile(file, 'recovery', ['.webm']);
});

// List crash-recovery sessions
handleFrom('main', 'list-recovery-sessions', async () => {
  const dir = getRecoveryDir();
  try {
    return fs.readdirSync(dir)
      .filter(f => f.startsWith('recovery-') && f.endsWith('.webm'))
      .map(f => {
        try {
          const p = resolveContainedPath(dir, f, {
            directChild: true,
            namePattern: /^recovery-[a-z0-9_-]+\.webm$/i,
          });
          const stat = fs.lstatSync(p);
          if (stat.isSymbolicLink() || !stat.isFile()) return null;
          const grantedPath = grantFile(p, 'recovery', ['.webm']);
          return { name: f, path: grantedPath, size: stat.size, mtime: stat.mtime.toISOString() };
        } catch {
          return null;
        }
      })
      .filter(f => f && f.size > 50000)
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  } catch { return []; }
});

handleFrom('main', 'delete-recovery-session', async (_, filePath) => {
  try {
    const candidate = resolveContainedPath(getRecoveryDir(), filePath, {
      directChild: true,
      namePattern: /^recovery-[a-z0-9_-]+\.webm$/i,
    });
    const safePath = requireGrantedFile(candidate, 'recovery', ['.webm']);
    fs.unlinkSync(safePath);
    revokeFile(safePath);
    return true;
  } catch {
    return false;
  }
});

handleFrom('main', 'generate-transcript', async (_, { inputPath }) => {
  const safeInputPath = requireGrantedFile(inputPath, ['media', 'artifact'], VIDEO_EXTENSIONS);
  const whisper = await hasCommand('whisper') || await hasCommand('whisper.cpp');
  if (!whisper) {
    throw new Error('No local Whisper CLI found. Install whisper or whisper.cpp to generate on-device transcripts.');
  }
  const outDir = canonicalDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-transcript-')));
  fs.chmodSync(outDir, 0o700);

  return new Promise((resolve, reject) => {
    const args = whisper.endsWith('whisper.cpp')
      ? ['-f', safeInputPath, '-osrt', '-otxt', '-of', path.join(outDir, 'transcript')]
      : [safeInputPath, '--model', 'base', '--output_format', 'all', '--output_dir', outDir];
    const proc = spawn(whisper, args);
    let err = '';
    proc.stderr.on('data', d => err += d.toString());
    proc.on('error', error => reject(new Error(`Transcript generator could not start: ${error.message}`)));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || 'Transcript generation failed'));
      try {
        const files = fs.readdirSync(outDir);
        const srtFile = files.find(f => f.endsWith('.srt'));
        const txtFile = files.find(f => f.endsWith('.txt'));
        const safeTranscriptFile = (fileName, extensions) => {
          if (!fileName) return null;
          const candidate = resolveContainedPath(outDir, fileName, { directChild: true, extensions });
          const stat = fs.lstatSync(candidate);
          if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024 * 1024) {
            throw new Error('Transcript output is invalid or too large');
          }
          return canonicalRegularFile(candidate, extensions);
        };
        const safeSrtFile = safeTranscriptFile(srtFile, SUBTITLE_EXTENSIONS);
        const safeTextFile = safeTranscriptFile(txtFile, ['.txt']);
        const srtPath = safeSrtFile ? grantFile(safeSrtFile, 'subtitle', SUBTITLE_EXTENSIONS) : null;
        resolve({
          srtPath,
          srt: safeSrtFile ? fs.readFileSync(safeSrtFile, 'utf8') : '',
          text: safeTextFile ? fs.readFileSync(safeTextFile, 'utf8') : '',
        });
      } catch (error) {
        reject(error);
      }
    });
  });
});

// Probe video duration / metadata
handleFrom('main', 'probe-video', async (_, filePath) => {
  const safeFilePath = requireGrantedFile(filePath, ['media', 'artifact'], VIDEO_EXTENSIONS);
  return mediaFileMetadata(safeFilePath);
});

let activeSourceBounds = null;

// Cursor polling
let cursorPoll = null;
onFrom('main', 'start-cursor-poll', () => {
  if (cursorPoll) clearInterval(cursorPoll);
  cursorPoll = setInterval(() => {
    const pt = screen.getCursorScreenPoint();
    const payload = { ...pt, bounds: activeSourceBounds, at: Date.now() };
    safeSend(mainWindow, 'cursor-move', payload);
    safeSend(floatBar, 'cursor-move', payload);
  }, 16);
});
onFrom('main', 'stop-cursor-poll', () => {
  if (cursorPoll) { clearInterval(cursorPoll); cursorPoll = null; }
});

onFrom('main', 'set-source-bounds', (_, bounds) => {
  activeSourceBounds = bounds || null;
});

onFrom('main', 'set-capture-source', (_, source = {}) => {
  activeCaptureSourceId = source?.id || null;
});

onFrom('main', 'audio-diagnostic', (_, payload = {}) => {
  try {
    log.info('ScreenForge audio diagnostic:', JSON.stringify(payload));
  } catch {
    log.info('ScreenForge audio diagnostic:', payload);
  }
});

// Float bar relay
onFrom('float', 'float-stop', () => {
  safeSend(mainWindow, 'global-stop');
});
onFrom('float', 'float-pause', () => {
  safeSend(mainWindow, 'float-pause');
});
onFrom('float', 'float-marker', () => {
  safeSend(mainWindow, 'float-marker');
});
onFrom('float', 'float-screenshot', () => {
  safeSend(mainWindow, 'float-screenshot');
});
// (pause-state relay is handled in the new IPC section above);

// ─── Floating recording bar ───────────────────────────────────────────────────
function showFloatBar(info = {}) {
  safeWindowAction(floatBar, 'close');
  floatBar = null;
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  floatBar = new BrowserWindow({
    width: 620, height: 52,
    x: Math.floor(width / 2 - 310),
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-floatbar.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    }
  });
  lockDownWindowNavigation(floatBar);
  floatBar.on('closed', () => { floatBar = null; });
  floatBar.webContents.once('did-finish-load', () => {
    safeSend(floatBar, 'recording-info', {
      webcam: !!info.webcam,
      sessionId: info.sessionId || null,
    });
  });
  floatBar.loadFile(path.join(__dirname, 'renderer', 'floatbar.html'));
}

// ─── Tray menu ────────────────────────────────────────────────────────────────
function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: recState.isRec ? '⏺ Recording in progress' : '⬡ ScreenForge', enabled: false },
    { type: 'separator' },
    recState.isRec
      ? { label: '⏹ Stop Recording', click: () => safeSend(mainWindow, 'global-stop') }
      : { label: 'Open ScreenForge', click: () => { safeWindowAction(mainWindow, 'show'); safeWindowAction(mainWindow, 'focus'); } },
    recState.isRec
      ? { label: recState.isPaused ? '▶ Resume' : '⏸ Pause', click: () => safeSend(mainWindow, 'float-pause') }
      : { type: 'separator' },
    { label: 'Open Clip Library', click: () => shell.openPath(getLibraryDir()) },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(recState.isRec ? 'Recording…' : 'ScreenForge');
}

// ─── App ready ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Start WebSocket remote control (if ws package available)
  if (WebSocketServer) startWsServer();

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details = {}) => {
    if (permission !== 'media') return false;
    const requestUrl = details.requestingUrl || requestingOrigin || '';
    return isMainMediaOwner(webContents, requestUrl);
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    if (permission !== 'media') {
      callback(false);
      return;
    }
    const requestUrl = details.requestingUrl || '';
    const allowed = isMainMediaOwner(webContents, requestUrl);
    log.info(`ScreenForge media permission ${allowed ? 'allowed' : 'denied'}: ${details.mediaType || 'unknown'} ${requestUrl || webContents?.getURL?.() || ''}`);
    callback(allowed);
  });

  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    const mainFrame = mainWindow?.webContents?.mainFrame;
    const validFrame = Boolean(
      req.frame
      && mainFrame
      && req.frame === mainFrame
      && !req.frame.parent
      && isExactLocalPageUrl(req.frame.url, IPC_ROLE_PAGES.main)
      && (req.securityOrigin === 'null' || !req.securityOrigin || /^file:\/\//i.test(req.securityOrigin))
    );
    if (!validFrame) {
      cb({});
      return;
    }
    discoverCaptureSources({
      platform: process.platform,
      systemPreferences,
      enumerateSources: () => desktopCapturer.getSources({ types: ['screen', 'window'] }),
      onError: sourceDiscoveryErrorLogger('recording source discovery'),
    }).then(result => {
      if (!result.ok) {
        cb({});
        return;
      }
      const sources = result.sources;
      const selected = activeCaptureSourceId
        ? sources.find(source => source.id === activeCaptureSourceId)
        : null;
      const fallback = sources.find(source => source.name.toLowerCase().includes('screen')) || sources[0];
      const source = selected || fallback;
      if (!source) {
        cb({});
        return;
      }
      const grant = { video: source };
      if (req.audioRequested) grant.audio = 'loopback';
      cb(grant);
    }).catch(error => {
      log.warn?.(`ScreenForge recording source request failed: ${cleanDisplayText(error?.message, 'Unknown error', 240)}`);
      cb({});
    });
  });

  mainWindow = new BrowserWindow({
    width: 1280, height: 820,
    minWidth: 1080, minHeight: 700,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#080a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,  // keep canvas/RAF running when window is hidden
    }
  });
  lockDownWindowNavigation(mainWindow);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    // Restore window size/position if saved
    const bounds = store?.get('windowBounds');
    if (bounds) {
      try { mainWindow.setBounds(bounds); } catch {}
    }
  });
  mainWindow.on('close', () => {
    try { store?.set('windowBounds', mainWindow.getBounds()); } catch {}
  });

  bindInputHookListeners();

  globalShortcut.register('CommandOrControl+Shift+S', () => {
    safeSend(mainWindow, 'global-stop');
  });
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    safeSend(mainWindow, 'float-pause');
  });
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    safeSend(mainWindow, 'float-marker');
  });
  globalShortcut.register('CommandOrControl+Shift+G', () => {
    safeSend(mainWindow, 'float-screenshot');
  });
});

app.on('will-quit', () => {
  for (const rec of activeNativeMicSessions.values()) {
    try { rec.proc.kill('SIGINT'); } catch {}
  }
  activeNativeMicSessions.clear();
  globalShortcut.unregisterAll();
  stopInputHook();
});
app.on('window-all-closed', () => app.quit());
