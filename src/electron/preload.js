'use strict';

/**
 * Sandboxed preload for the Claude Anywhere dialog. Exposes a tiny, frozen API to the page;
 * the main process only honours these messages from the daemon origin.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld(
  'anywhereShell',
  Object.freeze({
    isElectron: true,
    platform: process.platform,
    hide: () => ipcRenderer.send('anywhere:hide'),
    setAlwaysOnTop: (on) => ipcRenderer.send('anywhere:always-on-top', !!on),
  })
);
