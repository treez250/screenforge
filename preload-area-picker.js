'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sf', Object.freeze({
  areaSelected: rect => ipcRenderer.send('area-selected', rect),
  areaCanceled: () => ipcRenderer.send('area-canceled'),
}));
