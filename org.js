// org.js — persists the organization / workspace profile captured during
// onboarding to userData/organization.json.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function filePath() {
  return path.join(app.getPath('userData'), 'organization.json');
}

function get() {
  try {
    return JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch (_) {
    return null;
  }
}

function save(profile) {
  const data = { ...(profile || {}) };
  if (!data.onboardingCompletedAt) data.onboardingCompletedAt = new Date().toISOString();
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function clear() {
  try { fs.unlinkSync(filePath()); } catch (_) {}
}

module.exports = { get, save, clear };
