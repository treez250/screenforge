'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sf', Object.freeze({
  floatStop: () => ipcRenderer.send('float-stop'),
  floatPause: () => ipcRenderer.send('float-pause'),
  floatMarker: () => ipcRenderer.send('float-marker'),
  floatScreenshot: () => ipcRenderer.send('float-screenshot'),
  onPauseState: callback => ipcRenderer.on('pause-state', (_, value) => callback(Boolean(value))),
  onRecordingInfo: callback => ipcRenderer.on('recording-info', (_, value) => callback(value || {})),
}));
