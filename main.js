// main.js — Electron main process.
// Owns the network scan and the RTSP→WebSocket video bridge.

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { scanNetwork } = require('./scanner');
const videoStream = require('./stream');
const store = require('./store');
const passfinder = require('./passfinder');
const security = require('./security');
const org = require('./org');
const frames = require('./frames');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    title: 'Patrol Sense — IP Camera Scanner',
    autoHideMenuBar: true,
    // Drop the native OS title bar for a seamless all-black look, keeping the
    // window controls (min/max/close). The renderer draws its own titlebar.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#000000',
      symbolColor: '#ffffff',
      height: 40,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Forward renderer console output to the main process stdout for debugging.
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    console.log('[renderer]', message);
  });
}

// ---------------------------------------------------------------------------
// Stream control
// ---------------------------------------------------------------------------

// Build the RTSP URL for a Hikvision camera.
//   Main stream:  rtsp://user:pass@ip:554/Streaming/Channels/101
//   Sub  stream:  rtsp://user:pass@ip:554/Streaming/Channels/102
function buildHikvisionUrl({ ip, port = 554, username, password, channel = 1, subStream = false }) {
  const cred = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@` : '';
  const streamId = `${channel}0${subStream ? 2 : 1}`; // 101 main, 102 sub
  return `rtsp://${cred}${ip}:${port}/Streaming/Channels/${streamId}`;
}

function sendToUi(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

ipmainHandlers();

function ipmainHandlers() {
  ipcMain.handle('scan:start', async (event) => {
    const send = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('scan:progress', payload);
    };
    try {
      const result = await scanNetwork(send);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---- Saved cameras ----
  ipcMain.handle('cameras:list', async () => store.list());
  ipcMain.handle('cameras:save', async (_e, cam) => {
    try { return { ok: true, camera: store.save(cam) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('cameras:delete', async (_e, id) => {
    try { return { ok: true, cameras: store.remove(id) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // ---- Streaming ----
  // opts: { key, cameraId?, ip, port, username, password, channel, subStream, rtspUrl }
  // `key` identifies the stream/canvas (e.g. 'single' or a camera id). If
  // `cameraId` is given, stored credentials are used (and may be overridden by
  // explicit fields).
  ipcMain.handle('stream:start', async (_event, opts) => {
    const key = opts.key || 'single';
    let cfg = { ...opts };

    if (opts.cameraId) {
      const saved = store.get(opts.cameraId);
      if (!saved) return { ok: false, error: 'Saved camera not found.' };
      cfg = {
        ...saved,
        // allow explicit overrides from the form
        username: opts.username || saved.username,
        password: opts.password || saved.password,
        channel: opts.channel || saved.channel,
        subStream: opts.subStream != null ? opts.subStream : saved.subStream,
        rtspUrl: opts.rtspUrl || saved.rtspUrl,
      };
    }

    const rtspUrl = cfg.rtspUrl && cfg.rtspUrl.trim()
      ? cfg.rtspUrl.trim()
      : buildHikvisionUrl(cfg);

    try {
      const wsPort = videoStream.start(key, rtspUrl, {
        onError: (line) => sendToUi('stream:error', { key, message: line }),
      });
      const safeUrl = rtspUrl.replace(/\/\/[^@/]+@/, '//***:***@');
      return { ok: true, key, wsPort, rtspUrl: safeUrl };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('stream:stop', async (_e, key) => {
    if (key) videoStream.stop(key);
    else videoStream.stopAll();
    return { ok: true };
  });

  ipcMain.handle('stream:stopAll', async () => {
    videoStream.stopAll();
    return { ok: true };
  });

  // ---- Password recovery (own camera) ----
  ipcMain.handle('cred:find', async (event, opts) => {
    const { ip, port = 80, username = 'admin', candidates = [], delayMs, maxAttempts } = opts || {};
    if (!ip) return { ok: false, error: 'No camera IP.' };
    const onProgress = (p) => {
      if (!event.sender.isDestroyed()) event.sender.send('cred:progress', p);
    };
    return passfinder.find(ip, port, username, candidates, { onProgress, delayMs, maxAttempts });
  });

  ipcMain.handle('cred:cancel', async () => {
    passfinder.cancel();
    return { ok: true };
  });

  ipcMain.handle('cred:commonList', async () => passfinder.COMMON);

  // ---- App-lock security (local PIN + recovery code) ----
  ipcMain.handle('security:status', async () => security.status());
  ipcMain.handle('security:setPin', async (_e, pin) => security.setPin(pin));
  ipcMain.handle('security:verifyPin', async (_e, pin) => security.verifyPin(pin));
  ipcMain.handle('security:changePin', async (_e, cur, next) => security.changePin(cur, next));
  ipcMain.handle('security:resetWithRecovery', async (_e, code, next) =>
    security.resetPinWithRecovery(code, next));
  ipcMain.handle('security:disablePin', async (_e, cur) => security.disablePin(cur));
  ipcMain.handle('security:setAutoLock', async (_e, mins) => security.setAutoLock(mins));

  // ---- Organization / onboarding profile ----
  ipcMain.handle('org:get', async () => org.get());
  ipcMain.handle('org:save', async (_e, profile) => {
    try { return { ok: true, profile: org.save(profile) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // ---- Captured frames ----
  ipcMain.handle('frames:save', async (_e, payload) => frames.save(payload || {}));
  ipcMain.handle('frames:list', async (_e, cameraId, filters) => frames.list(cameraId, filters || {}));
  ipcMain.handle('frames:count', async (_e, cameraId) => frames.count(cameraId));
  ipcMain.handle('frames:clear', async (_e, cameraId) => frames.clear(cameraId));

  // ---- Factory reset ----
  // Wipes all local data (org, cameras, frames, security) after the renderer
  // has verified the PIN, returning the app to first-run onboarding.
  ipcMain.handle('app:reset', async (_e, pin) => {
    // If a PIN is set, it must be verified before wiping anything.
    if (security.status().pinSet && !security.verifyPin(pin)) {
      return { ok: false, error: 'Incorrect PIN.' };
    }
    try {
      videoStream.stopAll();
      store.clearAll();
      frames.clearAll();
      org.clear();
      security.reset();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  videoStream.stopAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => videoStream.stopAll());
