// security.js — local app-lock: a PIN plus a one-time recovery code.
//
// The PIN and recovery code are never stored in plain text. Each is salted and
// hashed with scrypt; only the hashes live on disk (userData/security.json).
// Mirrors the Patrol Sense Bridge app-lock model.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function filePath() {
  return path.join(app.getPath('userData'), 'security.json');
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch (_) {
    return {};
  }
}

function write(data) {
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2), 'utf8');
}

function hash(value, salt) {
  return crypto.scryptSync(String(value), salt, 64).toString('hex');
}

// Timing-safe compare of two hex strings.
function safeEqual(a, b) {
  const ba = Buffer.from(a || '', 'hex');
  const bb = Buffer.from(b || '', 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// PSB-XXXX-XXXX-XXXX — unambiguous uppercase alphabet.
function makeRecoveryCode() {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = () =>
    Array.from({ length: 4 }, () => alpha[crypto.randomInt(alpha.length)]).join('');
  return `PSB-${group()}-${group()}-${group()}`;
}

function status() {
  const d = read();
  return { pinSet: !!d.pinHash, autoLockMinutes: d.autoLockMinutes ?? 0 };
}

// Set (or replace) the PIN. Issues a fresh recovery code, returned once.
function setPin(pin) {
  const clean = String(pin || '').trim();
  if (clean.length < 4) return { ok: false, error: 'PIN must be at least 4 characters.' };

  const d = read();
  const pinSalt = crypto.randomBytes(16).toString('hex');
  const recoveryCode = makeRecoveryCode();
  const recSalt = crypto.randomBytes(16).toString('hex');

  d.pinSalt = pinSalt;
  d.pinHash = hash(clean, pinSalt);
  d.recoverySalt = recSalt;
  d.recoveryHash = hash(recoveryCode, recSalt);
  if (d.autoLockMinutes == null) d.autoLockMinutes = 0;
  write(d);
  return { ok: true, recoveryCode };
}

function verifyPin(pin) {
  const d = read();
  if (!d.pinHash) return false;
  return safeEqual(hash(String(pin || '').trim(), d.pinSalt), d.pinHash);
}

function changePin(currentPin, newPin) {
  if (!verifyPin(currentPin)) return { ok: false, error: 'Current PIN is incorrect.' };
  return setPin(newPin);
}

// Reset the PIN using the recovery code. Rotates the recovery code on success.
function resetPinWithRecovery(recoveryCode, newPin) {
  const d = read();
  if (!d.recoveryHash) return { ok: false, error: 'No recovery code on file.' };
  const given = String(recoveryCode || '').trim().toUpperCase();
  if (!safeEqual(hash(given, d.recoverySalt), d.recoveryHash)) {
    return { ok: false, error: 'Recovery code is incorrect.' };
  }
  return setPin(newPin); // issues a fresh recovery code
}

function disablePin(currentPin) {
  const d = read();
  if (!d.pinHash) return { ok: true };
  if (!verifyPin(currentPin)) return { ok: false, error: 'Current PIN is incorrect.' };
  delete d.pinHash;
  delete d.pinSalt;
  delete d.recoveryHash;
  delete d.recoverySalt;
  write(d);
  return { ok: true };
}

function setAutoLock(minutes) {
  const d = read();
  d.autoLockMinutes = Math.max(0, Number(minutes) || 0);
  write(d);
  return { ok: true, autoLockMinutes: d.autoLockMinutes };
}

// Wipe all security data (PIN + recovery + auto-lock).
function reset() {
  try { fs.unlinkSync(filePath()); } catch (_) {}
}

module.exports = {
  status,
  setPin,
  verifyPin,
  changePin,
  resetPinWithRecovery,
  disablePin,
  setAutoLock,
  reset,
};
