'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function electronStub() {
  return {
    app: {
      isPackaged: false,
      whenReady: () => ({ then() {} }),
      on() {},
    },
    BrowserWindow: class {},
    ipcMain: { handle() {}, on() {} },
    globalShortcut: {},
    desktopCapturer: {},
    session: {},
    screen: {},
    dialog: {},
    shell: {},
    clipboard: {},
    nativeImage: {},
    Menu: {},
    Tray: class {},
  };
}

test('main startup constructs the ESM default export from electron-store', () => {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  let constructed = 0;

  class FakeElectronStore {
    constructor(options) {
      constructed += 1;
      assert.equal(options?.name, 'screenforge-prefs');
    }
  }

  const optionalModules = {
    electron: electronStub(),
    'electron-store': { __esModule: true, default: FakeElectronStore },
    'electron-log': console,
    'uiohook-napi': { uIOhook: null },
    uuid: { v4: () => 'test-uuid' },
    systeminformation: {},
    ws: { WebSocketServer: class {} },
    sharp: () => {},
  };

  const localRequire = id => {
    if (Object.prototype.hasOwnProperty.call(optionalModules, id)) return optionalModules[id];
    if (id.startsWith('./')) return require(path.resolve(root, id));
    return require(id);
  };

  const context = {
    Buffer,
    URL,
    __dirname: root,
    __filename: path.join(root, 'main.js'),
    clearInterval,
    clearTimeout,
    console,
    exports: {},
    module: { exports: {} },
    process,
    require: localRequire,
    setInterval,
    setTimeout,
  };

  assert.doesNotThrow(() => vm.runInNewContext(source, context, { filename: 'main.js' }));
  assert.equal(constructed, 1);
});

test('installed electron-store default export can persist settings', () => {
  const electronStoreModule = require('electron-store');
  const ElectronStore = electronStoreModule?.default || electronStoreModule;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenforge-store-test-'));

  try {
    assert.equal(typeof ElectronStore, 'function');
    const testStore = new ElectronStore({ name: 'prefs', cwd: tempDir });
    testStore.set('startupProbe', 'ready');
    assert.equal(testStore.get('startupProbe'), 'ready');
    assert.equal(fs.existsSync(path.join(tempDir, 'prefs.json')), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
