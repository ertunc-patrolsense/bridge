// preload.js — safe bridge between the renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Scanning
  startScan: () => ipcRenderer.invoke('scan:start'),
  onScanProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('scan:progress', listener);
    return () => ipcRenderer.removeListener('scan:progress', listener);
  },

  // Saved cameras
  listCameras: () => ipcRenderer.invoke('cameras:list'),
  saveCamera: (cam) => ipcRenderer.invoke('cameras:save', cam),
  deleteCamera: (id) => ipcRenderer.invoke('cameras:delete', id),

  // Streaming (keyed — one key per canvas)
  startStream: (opts) => ipcRenderer.invoke('stream:start', opts),
  stopStream: (key) => ipcRenderer.invoke('stream:stop', key),
  stopAllStreams: () => ipcRenderer.invoke('stream:stopAll'),
  onStreamError: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('stream:error', listener);
    return () => ipcRenderer.removeListener('stream:error', listener);
  },

  // Password recovery (own camera)
  findPassword: (opts) => ipcRenderer.invoke('cred:find', opts),
  cancelFindPassword: () => ipcRenderer.invoke('cred:cancel'),
  commonPasswords: () => ipcRenderer.invoke('cred:commonList'),
  onCredProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('cred:progress', listener);
    return () => ipcRenderer.removeListener('cred:progress', listener);
  },

  // App-lock security (PIN + recovery)
  securityStatus: () => ipcRenderer.invoke('security:status'),
  setPin: (pin) => ipcRenderer.invoke('security:setPin', pin),
  verifyPin: (pin) => ipcRenderer.invoke('security:verifyPin', pin),
  changePin: (cur, next) => ipcRenderer.invoke('security:changePin', cur, next),
  resetPinWithRecovery: (code, next) => ipcRenderer.invoke('security:resetWithRecovery', code, next),
  disablePin: (cur) => ipcRenderer.invoke('security:disablePin', cur),
  setAutoLock: (mins) => ipcRenderer.invoke('security:setAutoLock', mins),

  // Organization / onboarding
  getOrganization: () => ipcRenderer.invoke('org:get'),
  saveOrganization: (profile) => ipcRenderer.invoke('org:save', profile),

  // Factory reset (verifies PIN in the main process)
  resetApp: (pin) => ipcRenderer.invoke('app:reset', pin),

  // Captured frames
  saveFrame: (payload) => ipcRenderer.invoke('frames:save', payload),
  listFrames: (cameraId, filters) => ipcRenderer.invoke('frames:list', cameraId, filters),
  countFrames: (cameraId) => ipcRenderer.invoke('frames:count', cameraId),
  clearFrames: (cameraId) => ipcRenderer.invoke('frames:clear', cameraId),
});
