// frames.js — on-disk storage for captured frames.
//
// Frames are grabbed from the live canvas in the renderer and sent here as JPEG
// data URLs. Each is written to userData/captures/<cameraId>/<ts>.jpg, with a
// per-camera index.json holding the metadata. Listing returns the frames (as
// data URLs) newest-first, with optional time / motion filters + pagination.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function baseDir() {
  return path.join(app.getPath('userData'), 'captures');
}
function camDir(cameraId) {
  return path.join(baseDir(), sanitize(cameraId));
}
function indexPath(cameraId) {
  return path.join(camDir(cameraId), 'index.json');
}
function sanitize(id) {
  return String(id || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function readIndex(cameraId) {
  try {
    return JSON.parse(fs.readFileSync(indexPath(cameraId), 'utf8'));
  } catch (_) {
    return [];
  }
}
function writeIndex(cameraId, list) {
  fs.writeFileSync(indexPath(cameraId), JSON.stringify(list, null, 2), 'utf8');
}

// Save one frame. `dataUrl` is a "data:image/jpeg;base64,…" string.
function save({ cameraId, dataUrl, motion = false, motionBox = null, width = 0, height = 0 }) {
  if (!cameraId || !dataUrl) return { ok: false, error: 'Missing cameraId or frame data.' };
  const m = /^data:image\/\w+;base64,(.+)$/s.exec(dataUrl);
  if (!m) return { ok: false, error: 'Invalid frame data URL.' };

  const buf = Buffer.from(m[1], 'base64');
  const dir = camDir(cameraId);
  fs.mkdirSync(dir, { recursive: true });

  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const file = `${timestamp.replace(/[:.]/g, '-')}_${id.slice(0, 8)}.jpg`;
  fs.writeFileSync(path.join(dir, file), buf);

  const meta = { id, cameraId, timestamp, file, motion: !!motion, motionBox: motionBox || null, size: buf.length, width, height };
  const list = readIndex(cameraId);
  list.push(meta);
  writeIndex(cameraId, list);
  return { ok: true, frame: meta };
}

// List frames newest-first. filters: { start, end, motionOnly, limit, offset }.
function list(cameraId, filters = {}) {
  const { start, end, motionOnly = false, limit = 60, offset = 0 } = filters;
  let items = readIndex(cameraId).slice().reverse(); // newest first

  if (motionOnly) items = items.filter((f) => f.motion);
  if (start) items = items.filter((f) => f.timestamp >= start);
  if (end) items = items.filter((f) => f.timestamp <= end);

  const total = items.length;
  const page = items.slice(offset, offset + limit).map((f) => ({
    ...f,
    dataUrl: loadDataUrl(cameraId, f.file),
  }));
  return { total, frames: page };
}

function count(cameraId) {
  return readIndex(cameraId).length;
}

function loadDataUrl(cameraId, file) {
  try {
    const buf = fs.readFileSync(path.join(camDir(cameraId), file));
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch (_) {
    return '';
  }
}

function clear(cameraId) {
  try {
    fs.rmSync(camDir(cameraId), { recursive: true, force: true });
  } catch (_) {}
  return { ok: true };
}

// Remove every captured frame for all cameras.
function clearAll() {
  try {
    fs.rmSync(baseDir(), { recursive: true, force: true });
  } catch (_) {}
  return { ok: true };
}

module.exports = { save, list, count, clear, clearAll };
