// store.js — persist saved cameras to userData/cameras.json.
//
// Passwords are encrypted at rest with Electron's safeStorage (backed by the
// OS keychain) when available, and never handed back to the renderer — the
// renderer references a saved camera by id and the main process supplies the
// password when building the RTSP URL.

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function filePath() {
  return path.join(app.getPath('userData'), 'cameras.json');
}

function encryptPassword(pw) {
  if (!pw) return { password: '', enc: false };
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return { password: safeStorage.encryptString(pw).toString('base64'), enc: true };
    }
  } catch (_) {}
  return { password: Buffer.from(pw, 'utf8').toString('base64'), enc: false };
}

function decryptPassword(rec) {
  if (!rec || !rec.password) return '';
  const buf = Buffer.from(rec.password, 'base64');
  if (rec.enc) {
    try {
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(buf);
      }
    } catch (_) { return ''; }
  }
  return buf.toString('utf8');
}

// Raw records (with encrypted password) as stored on disk.
function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch (_) {
    return [];
  }
}

function writeRaw(records) {
  fs.writeFileSync(filePath(), JSON.stringify(records, null, 2), 'utf8');
}

// Public view handed to the renderer — no password, just `hasPassword`.
function publicView(rec) {
  return {
    id: rec.id,
    name: rec.name || rec.ip,
    ip: rec.ip,
    port: rec.port || 554,
    username: rec.username || '',
    channel: rec.channel || 1,
    subStream: rec.subStream !== false,
    rtspUrl: rec.rtspUrl || '',
    vendor: rec.vendor || '',
    location: rec.location || '',
    // Frame-capture settings (canvas capture in the renderer).
    captureMode: rec.captureMode || 'off', // 'off' | 'interval' | 'motion'
    intervalSec: rec.intervalSec || 10,
    // Motion sensitivity 0–100 (higher = more sensitive). 50 is the recommended
    // default; cameras saved before this field existed fall back to it.
    sensitivity: rec.sensitivity != null ? rec.sensitivity : 50,
    // Minimum object size to detect 0–100 (higher = only larger objects).
    // 50 is recommended; older cameras without the field fall back to it.
    objectSize: rec.objectSize != null ? rec.objectSize : 50,
    hasPassword: !!rec.password,
  };
}

function list() {
  return readRaw().map(publicView);
}

// Add or update. Dedupe by ip + username + channel + subStream unless an id is
// supplied (explicit update). Returns the public view of the saved camera.
function save(cam) {
  const records = readRaw();
  const { password, enc } = encryptPassword(cam.password || '');

  let idx = -1;
  if (cam.id) {
    idx = records.findIndex((r) => r.id === cam.id);
  } else {
    idx = records.findIndex(
      (r) =>
        r.ip === cam.ip &&
        (r.username || '') === (cam.username || '') &&
        (r.channel || 1) === (cam.channel || 1) &&
        (r.subStream !== false) === (cam.subStream !== false)
    );
  }

  const prev = idx >= 0 ? records[idx] : {};
  const record = {
    id: (idx >= 0 && records[idx].id) || cam.id || crypto.randomUUID(),
    name: cam.name || cam.ip,
    ip: cam.ip,
    port: cam.port || 554,
    username: cam.username || '',
    channel: cam.channel || 1,
    subStream: cam.subStream !== false,
    rtspUrl: cam.rtspUrl || '',
    vendor: cam.vendor != null ? cam.vendor : prev.vendor || '',
    location: cam.location != null ? cam.location : prev.location || '',
    captureMode: cam.captureMode != null ? cam.captureMode : prev.captureMode || 'off',
    intervalSec: cam.intervalSec != null ? cam.intervalSec : prev.intervalSec || 10,
    sensitivity: cam.sensitivity != null ? cam.sensitivity : (prev.sensitivity != null ? prev.sensitivity : 50),
    objectSize: cam.objectSize != null ? cam.objectSize : (prev.objectSize != null ? prev.objectSize : 50),
    // Keep the existing password if the caller didn't provide a new one.
    password: password || (idx >= 0 ? records[idx].password : ''),
    enc: password ? enc : (idx >= 0 ? records[idx].enc : false),
  };

  if (idx >= 0) records[idx] = record;
  else records.push(record);

  writeRaw(records);
  return publicView(record);
}

function remove(id) {
  const records = readRaw().filter((r) => r.id !== id);
  writeRaw(records);
  return list();
}

// Full record incl. decrypted password — main-process only.
function get(id) {
  const rec = readRaw().find((r) => r.id === id);
  if (!rec) return null;
  return { ...publicView(rec), password: decryptPassword(rec) };
}

function clearAll() {
  try { fs.unlinkSync(filePath()); } catch (_) {}
}

module.exports = { list, save, remove, get, clearAll };
