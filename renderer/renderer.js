// renderer.js — PatrolSense Bridge UI.
// A screen-router over: boot → onboarding → lock → app (dashboard / add-camera
// wizard / live view + frame capture / frames gallery). Talks to the main
// process through window.api.
//
// Wrapped in an IIFE: contextBridge exposes `api` as a non-configurable global
// property, so a top-level `const api` would collide. Function scope avoids it.
(() => {
const api = window.api;
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── Global state ───────────────────────────────────────────────────────────
const state = {
  org: null,
  cameras: [],
  wizardStep: 'dashboard', // dashboard | addMethod | manualForm | autoScan
  scan: { running: false, done: false, seen: new Map(), selected: new Set(), progress: { scanned: 0, total: 0 } },
  manualBackStep: 'addMethod', // where the manual form's ← Back returns to
  autoLockMinutes: 0,
  liveAll: false, // when on, every card thumbnail plays its live feed
};
const players = new Map(); // key -> JSMpeg.Player

// ── Boot gate ──────────────────────────────────────────────────────────────
async function boot() {
  try {
    state.org = await api.getOrganization();
    if (!state.org || !state.org.onboardingCompletedAt) {
      showOnboarding();
      return;
    }
    const sec = await api.securityStatus();
    state.autoLockMinutes = sec.autoLockMinutes || 0;
    if (sec.pinSet) showLock();
    else await enterApp();
  } catch (err) {
    console.error('Boot failed:', err);
    await enterApp(); // fail open
  }
}

function only(id) {
  for (const s of ['boot', 'onboarding', 'lock', 'app']) {
    const node = $(s);
    if (node) node.hidden = s !== id;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ONBOARDING WIZARD
// ═══════════════════════════════════════════════════════════════════════════

const USE_CASES = [
  { type: 'home', label: 'Home', desc: 'House, apartment, family property', icon: '🏠' },
  { type: 'office', label: 'Office', desc: 'Workplace, co-working space', icon: '🏢' },
  { type: 'real-estate', label: 'Real Estate', desc: 'Listed or managed properties', icon: '🏘️' },
  { type: 'building', label: 'Building', desc: 'Apartment block, complex', icon: '🏬' },
  { type: 'company', label: 'Company', desc: 'Business with multiple areas', icon: '💼' },
  { type: 'industrial', label: 'Industrial', desc: 'Factory, plant, site', icon: '🏭' },
  { type: 'retail', label: 'Retail', desc: 'Shop, store, showroom', icon: '🛍️' },
  { type: 'warehouse', label: 'Warehouse', desc: 'Storage, logistics, depot', icon: '📦' },
  { type: 'other', label: 'Other', desc: 'Something else', icon: '📌' },
];
// Sensible capture defaults per use-case (applied to new cameras). `sensitivity`
// is the 0–100 motion dial (higher = more sensitive); 50 is the recommended
// baseline, nudged per scene — quieter scenes a touch higher (catch people),
// busy/industrial scenes a touch lower (fewer false trips).
const TEMPLATES = {
  home: { intervalSec: 15, sensitivity: 55 },
  office: { intervalSec: 12, sensitivity: 50 },
  'real-estate': { intervalSec: 15, sensitivity: 50 },
  building: { intervalSec: 8, sensitivity: 45 },
  company: { intervalSec: 8, sensitivity: 50 },
  industrial: { intervalSec: 5, sensitivity: 40 },
  retail: { intervalSec: 8, sensitivity: 55 },
  warehouse: { intervalSec: 8, sensitivity: 45 },
  other: { intervalSec: 15, sensitivity: 50 },
};

const onb = {
  step: 'useCase',
  orgType: null,
  orgName: '', adminName: '', email: '', phone: '', logo: '',
  siteName: '', zoneName: '', addressLine: '', city: '', stateRegion: '', country: '', postalCode: '',
  pin: '', pinConfirm: '', pinError: '', recoveryCode: '', savedAck: false,
  error: '',
};
const ONB_ORDER = ['useCase', 'details', 'location', 'security', 'review'];

function showOnboarding() {
  only('onboarding');
  renderOnboarding();
}

function renderOnboarding() {
  const idx = Math.max(0, ONB_ORDER.indexOf(onb.step === 'recovery' ? 'security' : onb.step));
  const dots = ONB_ORDER.map((s, i) => `<span class="onb-dot ${i <= idx ? 'done' : ''}"></span>`).join('');
  $('onboarding').className = 'onb-root';
  $('onboarding').innerHTML = `
    <div class="onb-card">
      <div class="onb-head">
        <img class="onb-applogo" src="patrol-LOGO.png" alt="Patrol Sense" />
        <div>
          <h1 class="onb-title">Welcome to Patrol Sense</h1>
          <p class="onb-sub">Let's set up your workspace. This takes a minute.</p>
        </div>
      </div>
      <div class="onb-progress">${dots}</div>
      ${onb.error ? `<div class="onb-error">${esc(onb.error)}</div>` : ''}
      <div class="onb-body">${onbStep()}</div>
    </div>`;
  wireOnboarding();
}

function onbStep() {
  switch (onb.step) {
    case 'useCase':
      return `
        <h2 class="onb-step-title">What are you using this for?</h2>
        <p class="onb-step-desc">We'll tailor sensible capture defaults to your setup.</p>
        <div class="onb-usecases">
          ${USE_CASES.map((u) => `
            <button type="button" class="onb-usecase ${onb.orgType === u.type ? 'selected' : ''}" data-type="${u.type}">
              <span class="onb-usecase-icon">${u.icon}</span>
              <span class="onb-usecase-label">${u.label}</span>
              <span class="onb-usecase-desc">${esc(u.desc)}</span>
            </button>`).join('')}
        </div>
        <div class="onb-actions">
          <span></span>
          <button class="onb-btn primary" data-next="details" ${onb.orgType ? '' : 'disabled'}>Continue</button>
        </div>`;
    case 'details':
      return `
        <h2 class="onb-step-title">Your organization</h2>
        <p class="onb-step-desc">Shown alongside the app — never replaces its branding.</p>
        <div class="onb-grid">
          <label class="onb-field onb-wide"><span class="onb-label">Organization / Place name *</span>
            <input id="o-orgName" value="${esc(onb.orgName)}" placeholder="e.g. Acme Corp, Smith Residence" /></label>
          <label class="onb-field"><span class="onb-label">Your name</span>
            <input id="o-adminName" value="${esc(onb.adminName)}" placeholder="Admin / owner name" /></label>
          <label class="onb-field"><span class="onb-label">Email</span>
            <input id="o-email" value="${esc(onb.email)}" placeholder="you@example.com" /></label>
          <label class="onb-field"><span class="onb-label">Phone</span>
            <input id="o-phone" value="${esc(onb.phone)}" placeholder="+1 555 0100" /></label>
          <div class="onb-field"><span class="onb-label">Company logo (optional)</span>
            <div class="onb-logo-row">
              ${onb.logo ? `<img class="onb-logo-preview" src="${onb.logo}" alt="logo" />`
                         : `<div class="onb-logo-placeholder">No logo</div>`}
              <label class="onb-btn ghost onb-file">${onb.logo ? 'Change' : 'Upload'}
                <input id="o-logo" type="file" accept="image/*" hidden /></label>
              ${onb.logo ? `<button class="onb-btn ghost" id="o-logo-remove" type="button">Remove</button>` : ''}
            </div>
          </div>
        </div>
        <div class="onb-actions">
          <button class="onb-btn ghost" data-back="useCase">Back</button>
          <button class="onb-btn primary" data-next="location" ${onb.orgName.trim() ? '' : 'disabled'}>Continue</button>
        </div>`;
    case 'location':
      return `
        <h2 class="onb-step-title">Location</h2>
        <p class="onb-step-desc">Create your first <strong>Site</strong> and a <strong>Zone</strong> inside it.
          You can add more later — cameras organize as Site → Zone → Camera.</p>
        <div class="onb-grid">
          <label class="onb-field"><span class="onb-label">First site name</span>
            <input id="o-siteName" value="${esc(onb.siteName)}" placeholder="e.g. Building A, Home" /></label>
          <label class="onb-field"><span class="onb-label">First zone (optional)</span>
            <input id="o-zoneName" value="${esc(onb.zoneName)}" placeholder="e.g. Lobby, Garage" /></label>
          <label class="onb-field onb-wide"><span class="onb-label">Address</span>
            <input id="o-addressLine" value="${esc(onb.addressLine)}" placeholder="Street address" /></label>
          <label class="onb-field"><span class="onb-label">City</span>
            <input id="o-city" value="${esc(onb.city)}" /></label>
          <label class="onb-field"><span class="onb-label">State / Region</span>
            <input id="o-stateRegion" value="${esc(onb.stateRegion)}" /></label>
          <label class="onb-field"><span class="onb-label">Country</span>
            <input id="o-country" value="${esc(onb.country)}" /></label>
          <label class="onb-field"><span class="onb-label">Postal code</span>
            <input id="o-postalCode" value="${esc(onb.postalCode)}" /></label>
        </div>
        <div class="onb-actions">
          <button class="onb-btn ghost" data-back="details">Back</button>
          <button class="onb-btn primary" data-next="security">Continue</button>
        </div>`;
    case 'security':
      return `
        <h2 class="onb-step-title">Protect your cameras with a PIN</h2>
        <p class="onb-step-desc">The app asks for this PIN each time it opens. It's stored securely on this
          computer — never as plain text. You can skip and add one later.</p>
        <div class="onb-grid">
          <label class="onb-field"><span class="onb-label">Create PIN (min 4 characters)</span>
            <input id="o-pin" type="password" value="${esc(onb.pin)}" placeholder="••••" autocomplete="new-password" /></label>
          <label class="onb-field"><span class="onb-label">Confirm PIN</span>
            <input id="o-pinConfirm" type="password" value="${esc(onb.pinConfirm)}" placeholder="••••" autocomplete="new-password" /></label>
        </div>
        ${onb.pinError ? `<div class="onb-error">${esc(onb.pinError)}</div>` : ''}
        <div class="onb-actions">
          <button class="onb-btn ghost" data-back="location">Back</button>
          <div class="onb-actions-right">
            <button class="onb-btn ghost" data-next="review">Skip for now</button>
            <button class="onb-btn primary" id="o-setpin" ${onb.pin && onb.pinConfirm ? '' : 'disabled'}>Set PIN</button>
          </div>
        </div>`;
    case 'recovery':
      return `
        <h2 class="onb-step-title">Save your recovery code</h2>
        <p class="onb-step-desc">If you ever forget your PIN, this code is the <strong>only</strong> way back in.
          Store it somewhere safe — it won't be shown again.</p>
        <div class="onb-recovery">
          <code class="onb-recovery-code">${esc(onb.recoveryCode)}</code>
          <button class="onb-btn primary onb-copy" id="o-copy">Copy</button>
        </div>
        <div class="onb-recovery-hint">Tip: paste it into your password manager or a note you trust.</div>
        <label class="onb-check"><input id="o-ack" type="checkbox" ${onb.savedAck ? 'checked' : ''} />
          <span>I've saved my recovery code somewhere safe.</span></label>
        <div class="onb-actions">
          <span></span>
          <button class="onb-btn primary" data-next="review" ${onb.savedAck ? '' : 'disabled'}>Continue</button>
        </div>`;
    case 'review':
      return `
        <h2 class="onb-step-title">All set</h2>
        <p class="onb-step-desc">Review your details and finish setup.</p>
        <div class="onb-review">
          <div class="onb-review-row"><span>Use case</span><b>${esc(USE_CASES.find((u) => u.type === onb.orgType)?.label || '—')}</b></div>
          <div class="onb-review-row"><span>Organization</span><b>${esc(onb.orgName || '—')}</b></div>
          ${onb.adminName ? `<div class="onb-review-row"><span>Admin</span><b>${esc(onb.adminName)}</b></div>` : ''}
          ${onb.siteName ? `<div class="onb-review-row"><span>First site</span><b>${esc(onb.siteName)}${onb.zoneName ? ' → ' + esc(onb.zoneName) : ''}</b></div>` : ''}
          <div class="onb-review-row"><span>App lock</span><b>${onb.recoveryCode ? 'PIN enabled' : 'No PIN (add one later)'}</b></div>
        </div>
        <div class="onb-actions">
          <button class="onb-btn ghost" data-back="security">Back</button>
          <button class="onb-btn primary" id="o-finish">Finish &amp; open dashboard</button>
        </div>`;
  }
  return '';
}

function wireOnboarding() {
  const root = $('onboarding');
  root.querySelectorAll('[data-next]').forEach((b) =>
    b.addEventListener('click', () => { captureOnbInputs(); onb.error = ''; onb.step = b.dataset.next; renderOnboarding(); }));
  root.querySelectorAll('[data-back]').forEach((b) =>
    b.addEventListener('click', () => { captureOnbInputs(); onb.error = ''; onb.step = b.dataset.back; renderOnboarding(); }));
  root.querySelectorAll('.onb-usecase').forEach((b) =>
    b.addEventListener('click', () => { onb.orgType = b.dataset.type; renderOnboarding(); }));

  const logo = $('o-logo');
  if (logo) logo.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) { onb.error = 'Logo must be under 1 MB.'; renderOnboarding(); return; }
    const reader = new FileReader();
    reader.onload = () => { onb.logo = String(reader.result || ''); renderOnboarding(); };
    reader.readAsDataURL(file);
  });
  $('o-logo-remove')?.addEventListener('click', () => { onb.logo = ''; renderOnboarding(); });

  $('o-setpin')?.addEventListener('click', async () => {
    captureOnbInputs();
    onb.pinError = '';
    if (onb.pin.trim().length < 4) { onb.pinError = 'PIN must be at least 4 characters.'; renderOnboarding(); return; }
    if (onb.pin !== onb.pinConfirm) { onb.pinError = 'PINs do not match.'; renderOnboarding(); return; }
    const res = await api.setPin(onb.pin.trim());
    if (!res.ok) { onb.pinError = res.error || 'Could not set the PIN.'; renderOnboarding(); return; }
    onb.recoveryCode = res.recoveryCode || '';
    onb.step = 'recovery';
    renderOnboarding();
  });

  $('o-copy')?.addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(onb.recoveryCode); e.target.textContent = 'Copied ✓';
      setTimeout(() => (e.target.textContent = 'Copy'), 2000); } catch (_) {}
  });
  $('o-ack')?.addEventListener('change', (e) => { onb.savedAck = e.target.checked; renderOnboarding(); });

  $('o-finish')?.addEventListener('click', finishOnboarding);

  // Live-enable the step's primary button as required fields are filled
  // (render only happens on navigation, so toggle disabled state on input).
  const orgNameInput = $('o-orgName');
  if (orgNameInput) orgNameInput.addEventListener('input', () => {
    const b = root.querySelector('[data-next="location"]');
    if (b) b.disabled = !orgNameInput.value.trim();
  });
  const pinI = $('o-pin'), pinC = $('o-pinConfirm');
  const syncPinBtn = () => { const b = $('o-setpin'); if (b) b.disabled = !(pinI?.value && pinC?.value); };
  pinI?.addEventListener('input', syncPinBtn);
  pinC?.addEventListener('input', syncPinBtn);
}

function captureOnbInputs() {
  const map = {
    'o-orgName': 'orgName', 'o-adminName': 'adminName', 'o-email': 'email', 'o-phone': 'phone',
    'o-siteName': 'siteName', 'o-zoneName': 'zoneName', 'o-addressLine': 'addressLine',
    'o-city': 'city', 'o-stateRegion': 'stateRegion', 'o-country': 'country', 'o-postalCode': 'postalCode',
    'o-pin': 'pin', 'o-pinConfirm': 'pinConfirm',
  };
  for (const [id, key] of Object.entries(map)) { const n = $(id); if (n) onb[key] = n.value; }
}

async function finishOnboarding() {
  captureOnbInputs();
  if (!onb.orgType) return;
  const tpl = TEMPLATES[onb.orgType] || TEMPLATES.other;
  const profile = {
    organizationType: onb.orgType,
    organizationName: onb.orgName.trim(),
    adminName: onb.adminName.trim() || undefined,
    contactEmail: onb.email.trim() || undefined,
    contactPhone: onb.phone.trim() || undefined,
    companyLogo: onb.logo || undefined,
    addressLine: onb.addressLine.trim() || undefined,
    city: onb.city.trim() || undefined,
    state: onb.stateRegion.trim() || undefined,
    country: onb.country.trim() || undefined,
    postalCode: onb.postalCode.trim() || undefined,
    site: onb.siteName.trim() ? { name: onb.siteName.trim(), zone: onb.zoneName.trim() || '' } : undefined,
    captureDefaults: tpl,
    onboardingCompletedAt: new Date().toISOString(),
  };
  const res = await api.saveOrganization(profile);
  if (!res.ok) { onb.error = res.error || 'Could not save.'; renderOnboarding(); return; }
  state.org = res.profile;
  await enterApp();
}

// ═══════════════════════════════════════════════════════════════════════════
//  LOCK SCREEN
// ═══════════════════════════════════════════════════════════════════════════

const lockState = { mode: 'unlock', pin: '', error: '', checking: false, attempts: 0,
  recoveryCode: '', newPin: '', newPinConfirm: '', freshRecovery: '' };

function showLock() {
  only('lock');
  lockState.mode = 'unlock'; lockState.pin = ''; lockState.error = '';
  renderLock();
}

function renderLock() {
  const orgName = state.org?.organizationName;
  let body = '';
  if (lockState.mode === 'unlock') {
    body = `
      <p class="lock-prompt">Enter your PIN to unlock</p>
      <input id="lk-pin" type="password" class="lock-input" placeholder="••••" autocomplete="off" value="${esc(lockState.pin)}" />
      ${lockState.error ? `<div class="lock-error">${esc(lockState.error)}</div>` : ''}
      <button id="lk-unlock" class="lock-btn primary" ${lockState.pin && !lockState.checking ? '' : 'disabled'}>${lockState.checking ? 'Checking…' : 'Unlock'}</button>
      <button id="lk-forgot" class="lock-link">Forgot PIN?</button>`;
  } else if (lockState.mode === 'recover' && !lockState.freshRecovery) {
    body = `
      <p class="lock-prompt">Reset your PIN</p>
      <p class="lock-help">Enter the recovery code you saved during setup, then choose a new PIN.</p>
      <input id="lk-code" class="lock-input wide" placeholder="PSB-XXXX-XXXX-XXXX" value="${esc(lockState.recoveryCode)}" />
      <input id="lk-newpin" type="password" class="lock-input" placeholder="New PIN" value="${esc(lockState.newPin)}" />
      <input id="lk-newpin2" type="password" class="lock-input" placeholder="Confirm new PIN" value="${esc(lockState.newPinConfirm)}" />
      ${lockState.error ? `<div class="lock-error">${esc(lockState.error)}</div>` : ''}
      <button id="lk-reset" class="lock-btn primary" ${lockState.recoveryCode && lockState.newPin && lockState.newPinConfirm && !lockState.checking ? '' : 'disabled'}>${lockState.checking ? 'Resetting…' : 'Reset PIN'}</button>
      <button id="lk-back" class="lock-link">Back to unlock</button>`;
  } else {
    body = `
      <p class="lock-prompt">PIN reset ✓</p>
      <p class="lock-help">Here's your <strong>new</strong> recovery code — save it. The old one no longer works.</p>
      <div class="lock-recovery"><code>${esc(lockState.freshRecovery)}</code>
        <button id="lk-copy" class="lock-btn ghost">Copy</button></div>
      <button id="lk-continue" class="lock-btn primary">Continue to unlock</button>`;
  }
  $('lock').className = 'lock-root';
  $('lock').innerHTML = `
    <div class="lock-card">
      <img class="lock-logo" src="patrol-LOGO.png" alt="Patrol Sense" />
      <h1 class="lock-app">Patrol Sense</h1>
      ${orgName ? `<p class="lock-org">${esc(orgName)}</p>` : ''}
      ${body}
    </div>`;
  wireLock();
}

function wireLock() {
  const pin = $('lk-pin');
  if (pin) {
    pin.focus();
    pin.addEventListener('input', (e) => (lockState.pin = e.target.value));
    pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
    // Keep button enabled state in sync without full re-render on each keystroke.
    pin.addEventListener('input', () => { const b = $('lk-unlock'); if (b) b.disabled = !pin.value || lockState.checking; });
  }
  $('lk-unlock')?.addEventListener('click', doUnlock);
  $('lk-forgot')?.addEventListener('click', () => { lockState.mode = 'recover'; lockState.error = ''; renderLock(); });
  $('lk-back')?.addEventListener('click', () => { lockState.mode = 'unlock'; lockState.error = ''; renderLock(); });
  $('lk-code')?.addEventListener('input', (e) => (lockState.recoveryCode = e.target.value));
  $('lk-newpin')?.addEventListener('input', (e) => (lockState.newPin = e.target.value));
  $('lk-newpin2')?.addEventListener('input', (e) => (lockState.newPinConfirm = e.target.value));
  $('lk-reset')?.addEventListener('click', doReset);
  $('lk-copy')?.addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(lockState.freshRecovery); e.target.textContent = 'Copied ✓'; } catch (_) {}
  });
  $('lk-continue')?.addEventListener('click', () => { lockState.mode = 'unlock'; lockState.freshRecovery = ''; lockState.pin = ''; lockState.error = ''; renderLock(); });
}

async function doUnlock() {
  if (lockState.checking || !lockState.pin) return;
  lockState.checking = true; lockState.error = ''; renderLock();
  const ok = await api.verifyPin(lockState.pin.trim());
  lockState.checking = false;
  if (ok) { lockState.pin = ''; await enterApp(); return; }
  lockState.attempts++;
  lockState.pin = '';
  lockState.error = 'Incorrect PIN. Try again.';
  renderLock();
}

async function doReset() {
  lockState.error = '';
  if (lockState.newPin.trim().length < 4) { lockState.error = 'New PIN must be at least 4 characters.'; renderLock(); return; }
  if (lockState.newPin !== lockState.newPinConfirm) { lockState.error = 'New PINs do not match.'; renderLock(); return; }
  lockState.checking = true; renderLock();
  const res = await api.resetPinWithRecovery(lockState.recoveryCode.trim(), lockState.newPin.trim());
  lockState.checking = false;
  if (!res.ok) { lockState.error = res.error || 'Could not reset the PIN.'; renderLock(); return; }
  lockState.freshRecovery = res.recoveryCode || '';
  renderLock();
}

// ═══════════════════════════════════════════════════════════════════════════
//  APP SHELL + DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════

async function enterApp() {
  only('app');
  state.cameras = await api.listCameras();
  renderApp();
  setupAutoLock();
  reconcileCapture(); // resume background auto-capture for cameras that have it on
}

function renderApp() {
  const org = state.org;
  $('app').innerHTML = `
    <div class="titlebar">
      <div class="titlebar-brand">
        <span class="titlebar-logo"><img src="patrol-LOGO.png" alt="Patrol Sense" /></span>
        <span class="titlebar-name">Patrol Sense</span>
        ${org?.organizationName ? `
          <span class="titlebar-org" title="${esc(org.organizationName)}">
            ${org.companyLogo ? `<img class="titlebar-org-logo" src="${org.companyLogo}" alt="" />` : ''}
            <span class="titlebar-org-name">${esc(org.organizationName)}</span>
          </span>` : ''}
      </div>
      <button class="titlebar-gear" id="titlebarGear" title="Settings" aria-label="Settings">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
    <main class="cameras-page" id="camerasPage"></main>`;
  $('titlebarGear').addEventListener('click', (e) => { e.stopPropagation(); toggleSettingsMenu(); });
  renderWizard();
}

// ── Titlebar settings menu + factory reset ───────────────────────────────────
function toggleSettingsMenu() {
  if ($('settingsMenu')) { closeSettingsMenu(); return; }
  const gear = $('titlebarGear');
  const menu = document.createElement('div');
  menu.id = 'settingsMenu';
  menu.className = 'settings-menu';
  menu.innerHTML = `
    <button class="settings-menu-item danger" id="menuReset">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" />
      </svg>
      Reset Patrol Sense…
    </button>`;
  document.body.appendChild(menu);
  const r = gear.getBoundingClientRect();
  menu.style.top = (r.bottom + 6) + 'px';
  menu.style.right = (window.innerWidth - r.right) + 'px';
  $('menuReset').addEventListener('click', () => { closeSettingsMenu(); openResetDialog(); });
  setTimeout(() => document.addEventListener('click', closeSettingsMenu), 0);
}
function closeSettingsMenu() {
  $('settingsMenu')?.remove();
  document.removeEventListener('click', closeSettingsMenu);
}

async function openResetDialog() {
  const sec = await api.securityStatus();
  const pinSet = !!sec.pinSet;
  modal(`
    <div class="confirm-modal reset-modal">
      <div class="confirm-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <path d="M12 9v4" /><path d="M12 17h.01" />
        </svg>
      </div>
      <h2 class="confirm-title">Reset Patrol Sense?</h2>
      <p class="confirm-text">This permanently deletes all cameras, captured frames, your PIN, and organization setup, then returns to first-run onboarding. This can’t be undone.</p>
      ${pinSet ? `<div class="reset-pin"><input id="reset-pin" class="modern-input" type="password" placeholder="Enter your PIN to confirm" /></div>` : ''}
      <div class="reset-error" id="reset-error" hidden></div>
      <div class="confirm-actions">
        <button class="btn-secondary" id="reset-cancel">Cancel</button>
        <button class="btn-danger" id="reset-confirm">Reset everything</button>
      </div>
    </div>
  `);
  $('reset-cancel').addEventListener('click', () => closeModal());
  $('reset-confirm').addEventListener('click', () => doReset(pinSet));
  const pinInput = $('reset-pin');
  if (pinInput) { pinInput.focus(); pinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doReset(pinSet); }); }
}

async function doReset(pinSet) {
  const err = $('reset-error');
  const pin = pinSet ? ($('reset-pin')?.value || '') : '';
  if (pinSet && !pin) { if (err) { err.hidden = false; err.textContent = 'Enter your PIN.'; } return; }

  const res = await api.resetApp(pin);
  if (!res.ok) { if (err) { err.hidden = false; err.textContent = res.error || 'Reset failed.'; } return; }

  // Data is wiped — tear down all streams/capture and reload into onboarding.
  stopAllCapture();
  players.forEach((_, k) => stopPlayer(k));
  window.location.reload();
}

async function refreshCameras() {
  state.cameras = await api.listCameras();
  renderWizard();
  reconcileCapture();
}

function renderWizard() {
  const page = $('camerasPage');
  if (!page) return;
  if (state.wizardStep === 'dashboard') page.innerHTML = dashboardHTML();
  else if (state.wizardStep === 'addMethod') page.innerHTML = addMethodHTML();
  else if (state.wizardStep === 'manualForm') page.innerHTML = manualFormHTML();
  else if (state.wizardStep === 'autoScan') {
    page.innerHTML = autoScanHTML();
    // Returning to the scan after a completed run → show results, don't rescan.
    if (state.scan.done && !state.scan.running) $('autoScanContainer').innerHTML = scanResultsHTML();
  }
  wireWizard();
}

function goStep(step) {
  if (step !== 'dashboard') stopAllThumbs(); // free ffmpeg while off the grid; resumes on return
  state.wizardStep = step;
  renderWizard();
}

// ── Dashboard ──────────────────────────────────────────────────────────────
function dashboardHTML() {
  const cams = state.cameras;
  const header = `
    <div class="cameras-header">
      <div class="header-left">
        <h1>Cameras</h1>
        <p class="subtitle">Manage, monitor, and add new camera feeds.</p>
      </div>
      <div class="header-stats">
        <div class="stat-item"><span class="stat-label">Cameras</span><span class="stat-value">${cams.length}</span></div>
        <div class="stat-item"><span class="stat-label">Capturing</span><span class="stat-value">${cams.filter((c) => c.captureMode !== 'off').length}</span></div>
      </div>
    </div>`;

  if (!cams.length) {
    return header + `
      <div class="dashboard-step">
        <div class="empty-state"><div class="empty-state-content">
          <h3>No cameras added yet</h3>
          <p>Add your first camera feed — scan the network or enter it manually.</p>
          <button class="btn-primary add-camera-btn" id="addFirst"><span class="plus">+</span> Add Camera</button>
        </div></div>
      </div>`;
  }

  return header + `
    <div class="active-feeds-section">
      <div class="feeds-header">
        <div class="feeds-title">Active Feeds <span class="count-badge">${cams.length}</span></div>
        <div class="feeds-actions">
          <button class="live-all-toggle ${state.liveAll ? 'on' : ''}" id="liveAllToggle"
                  role="switch" aria-checked="${state.liveAll ? 'true' : 'false'}"
                  title="Play every camera feed at once">
            <span class="live-all-label">Live All</span>
            <span class="live-all-track"><span class="live-all-knob"></span></span>
          </button>
          <button class="btn-primary" id="addMore"><span class="plus">+</span> Add Camera</button>
        </div>
      </div>
      <div class="feeds-grid grid">
        ${cams.map(cameraCardHTML).join('')}
      </div>
    </div>`;
}

function cameraCardHTML(c) {
  const capturing = c.captureMode !== 'off';
  const modeLabel = c.captureMode === 'interval' ? 'Interval capture' : c.captureMode === 'motion' ? 'Motion capture' : 'Connected';
  return `
    <div class="camera-card" data-id="${c.id}">
      <div class="camera-thumb" data-thumb="${c.id}">
        <canvas class="camera-feed" hidden></canvas>
        <div class="thumb-placeholder"><span class="thumb-stream-label">Open live view</span></div>
        ${c.vendor ? `<span class="thumb-vendor-tag">${esc(c.vendor)}</span>` : ''}
      </div>
      <div class="camera-body">
        <div class="camera-header">
          <div class="camera-title">
            <span class="camera-name">${esc(c.name)}</span>
            <span class="camera-id">${esc(c.ip)}${c.port ? ':' + c.port : ''}</span>
          </div>
          <div class="camera-header-actions">
            <button class="icon-btn" data-settings="${c.id}" title="Auto-capture settings" aria-label="Auto-capture settings">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <button class="remove-btn" data-del="${c.id}" title="Remove camera" aria-label="Remove camera">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6" /><path d="M14 11v6" />
              </svg>
            </button>
          </div>
        </div>
        <div class="camera-meta">
          <div class="meta-row"><span class="meta-key">Status</span>
            <span class="status-pill ${capturing ? 'monitoring' : ''}"><span class="status-dot active"></span>${esc(modeLabel)}</span></div>
          <div class="meta-row"><span class="meta-key">Vendor</span><span class="meta-val">${esc(c.vendor || 'Unknown')}</span></div>
          ${c.location ? `<div class="meta-row"><span class="meta-key">Location</span><span class="meta-val">${esc(c.location)}</span></div>` : ''}
        </div>
        <div class="camera-card-actions">
          <button class="btn-primary" data-live="${c.id}">Live View</button>
          <button class="btn-secondary" data-frames="${c.id}">Frames</button>
        </div>
      </div>
    </div>`;
}

// ── Add-method chooser ─────────────────────────────────────────────────────
function addMethodHTML() {
  return `
    <div class="wizard-step">
      <button class="btn-ghost back-btn" data-step="dashboard">← Back to Cameras</button>
      <div class="method-selection">
        <h2>How do you want to add a camera?</h2>
        <p class="method-subtitle">Choose a method to connect a new camera feed.</p>
        <div class="method-cards">
          <button class="method-card" data-method="manual">
            <span class="method-icon">⌨️</span>
            <span class="method-text">
              <span class="method-title">Manual Entry</span>
              <span class="method-desc">Enter the camera IP / RTSP URL and login directly.</span>
            </span>
            <span class="method-arrow">→</span>
          </button>
          <button class="method-card" data-method="auto">
            <span class="method-icon">📡</span>
            <span class="method-text">
              <span class="method-title">Auto Scan</span>
              <span class="method-desc">Scan your local network for Hikvision / ONVIF IP cameras.</span>
            </span>
            <span class="method-arrow">→</span>
          </button>
        </div>
      </div>
    </div>`;
}

// ── Manual form ────────────────────────────────────────────────────────────
function manualFormHTML(prefill = {}) {
  const p = { name: '', ip: '', port: 554, username: 'admin', password: '', channel: 1, subStream: true, rtspUrl: '', ...prefill };
  return `
    <div class="wizard-step">
      <button class="btn-ghost back-btn" data-step="${esc(state.manualBackStep || 'addMethod')}">← Back</button>
      <div class="config-card">
        <h2 class="config-title">MANUAL CAMERA CONFIGURATION</h2>
        <div class="config-grid">
          <div class="input-group"><label class="required">Camera Name *</label>
            <div class="input-wrapper"><input id="m-name" class="modern-input" value="${esc(p.name)}" placeholder="Front door" /></div></div>
          <div class="input-group"><label>Location (Optional)</label>
            <div class="input-wrapper"><input id="m-location" class="modern-input" value="${esc(p.location || '')}" placeholder="e.g. Lobby" /></div></div>
          <div class="input-group"><label class="required">Camera IP *</label>
            <div class="input-wrapper"><input id="m-ip" class="modern-input" value="${esc(p.ip)}" placeholder="192.168.1.64" /></div></div>
          <div class="input-group"><label>RTSP Port</label>
            <div class="input-wrapper"><input id="m-port" class="modern-input" type="number" value="${esc(p.port)}" /></div></div>
          <div class="input-group"><label>Username</label>
            <div class="input-wrapper"><input id="m-username" class="modern-input" value="${esc(p.username)}" placeholder="admin" /></div></div>
          <div class="input-group"><label>Password</label>
            <div class="input-wrapper"><input id="m-password" class="modern-input" type="password" value="${esc(p.password)}" placeholder="••••••••" /></div></div>
          <div class="input-group"><label>Channel</label>
            <div class="input-wrapper"><input id="m-channel" class="modern-input" type="number" min="1" value="${esc(p.channel)}" /></div></div>
          <div class="input-group"><label class="checkline"><input id="m-sub" type="checkbox" ${p.subStream ? 'checked' : ''} /> Use sub-stream (smoother)</label></div>
          <div class="input-group input-wide"><label>Advanced — full RTSP URL (optional)</label>
            <div class="input-wrapper"><input id="m-rtsp" class="modern-input" value="${esc(p.rtspUrl)}" placeholder="rtsp://user:pass@ip:554/Streaming/Channels/101" /></div></div>
        </div>
        <div class="message-banner" id="m-msg" hidden></div>
        <div class="config-actions">
          <button class="btn-secondary" id="m-findpass">🔑 Find password</button>
          <button class="btn-primary" id="m-add">Add Camera</button>
        </div>
      </div>
    </div>`;
}

// ── Auto scan ──────────────────────────────────────────────────────────────
function autoScanHTML() {
  return `
    <div class="wizard-step">
      <button class="btn-ghost back-btn" data-step="addMethod">← Back</button>
      <div class="auto-scan-container" id="autoScanContainer">
        ${scanningAnimationHTML()}
      </div>
    </div>`;
}

function scanningAnimationHTML() {
  return `
    <div class="scanning-animation">
      <div class="radar">
        <span class="radar-ring"></span><span class="radar-ring"></span><span class="radar-ring"></span>
        <div class="radar-sweep"></div>
        <span class="radar-core"></span>
        <span class="radar-blip blip-1"></span><span class="radar-blip blip-2"></span>
      </div>
      <p class="scanning-text">Searching for cameras on your network</p>
      <span class="scanning-sub">Scanning local subnet for live streams
        <span class="scanning-dots"><i></i><i></i><i></i></span></span>
      <div class="scan-progress">
        <div class="scan-progress-bar"><div class="scan-progress-fill" id="scanProgressFill"></div></div>
        <div class="scan-progress-meta">
          <span id="scanProgressCount">Preparing scan…</span>
          <span id="scanProgressFound">0 cameras found</span>
        </div>
      </div>
    </div>`;
}

// Push the latest scan counters into the scanning-screen progress bar.
function updateScanProgressUI() {
  const { scanned = 0, total = 0 } = state.scan.progress || {};
  const fill = $('scanProgressFill');
  const count = $('scanProgressCount');
  const found = $('scanProgressFound');
  if (count) {
    if (total) {
      const pct = Math.min(100, Math.round((scanned / total) * 100));
      if (fill) fill.style.width = pct + '%';
      count.textContent = `${scanned} / ${total} addresses · ${pct}%`;
    } else {
      count.textContent = 'Preparing scan…';
    }
  }
  if (found) {
    const n = state.scan.seen.size;
    found.textContent = `${n} camera${n === 1 ? '' : 's'} found`;
  }
}

// A discovered device is "already added" if a saved camera shares its IP.
const savedCameraByIp = (ip) => state.cameras.find((c) => c.ip === ip);

function scanResultsHTML() {
  const items = [...state.scan.seen.values()];
  const rows = items.map((d) => {
    const added = savedCameraByIp(d.ip);
    const checked = state.scan.selected.has(d.ip) ? 'checked' : '';
    const badges = [];
    if (d.ports?.includes(554)) badges.push('<span class="discovery-badge">RTSP 554</span>');
    if (d.onvif) badges.push('<span class="discovery-badge">ONVIF</span>');
    if (/hik/i.test(d.vendor || '')) badges.push('<span class="discovery-badge">Hikvision</span>');
    if (added) badges.push('<span class="discovery-badge added-badge">✓ Added</span>');

    // Already-added devices can't be picked again — offer Live view instead.
    const checkboxCell = added
      ? `<span class="filter-check-box added-check" title="Already added"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l4.5 4.5L19 7"/></svg></span>`
      : `<input type="checkbox" data-pick="${esc(d.ip)}" ${checked} />
         <span class="filter-check-box"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l4.5 4.5L19 7"/></svg></span>`;

    const actions = added
      ? `<button class="btn-secondary" data-viewsaved="${esc(added.id)}">Live view</button>`
      : `<button class="btn-secondary" data-test="${esc(d.ip)}">Test stream</button>
         <button class="btn-secondary" data-configure="${esc(d.ip)}">Add &amp; configure</button>`;

    return `
      <div class="discover-row ${added ? 'is-added' : ''}">
        <label class="filter-check dr-check">
          ${checkboxCell}
          <span class="dr-text">
            <span class="dr-name">${esc(d.ip)} · ${esc(d.vendor || 'Unknown')}</span>
            <span class="dr-addr">${d.model ? esc(d.model) + ' · ' : ''}${(d.ports || []).join(', ') || 'no open ports'}</span>
          </span>
        </label>
        <div class="dr-methods">${badges.join('')}</div>
        <div class="dr-actions">${actions}</div>
      </div>`;
  }).join('');

  // Only not-yet-added devices count toward "select all" / bulk add.
  const selectable = items.filter((d) => !savedCameraByIp(d.ip));

  return `
    <div class="discover-results">
      <div class="discover-head">
        <h3>Cameras found on your network</h3>
        <div class="discover-head-actions">
          <label class="filter-check select-all-check">
            <input type="checkbox" id="selectAll" ${selectable.length && state.scan.selected.size === selectable.length ? 'checked' : ''} ${selectable.length ? '' : 'disabled'} />
            <span class="filter-check-box"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l4.5 4.5L19 7"/></svg></span>
            <span class="filter-check-label">Select all</span>
          </label>
          <button class="btn-secondary" id="scanAgain">⟳ Scan Again</button>
        </div>
      </div>
      ${items.length ? `<div class="discover-list">${rows}</div>`
                     : `<p class="no-results-msg">No cameras detected on this subnet. Try “Add &amp; configure” manually.</p>`}
      <div class="scan-actions">
        <button class="btn-primary" id="addSelected" ${state.scan.selected.size ? '' : 'disabled'}>Add Selected (${state.scan.selected.size})</button>
        <button class="btn-secondary" id="addManualInstead">Enter manually instead</button>
      </div>
    </div>`;
}

// ── Wizard wiring ──────────────────────────────────────────────────────────
function wireWizard() {
  const page = $('camerasPage');
  if (!page) return;

  page.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => goStep(b.dataset.step)));
  $('addFirst')?.addEventListener('click', () => goStep('addMethod'));
  $('addMore')?.addEventListener('click', () => goStep('addMethod'));
  $('liveAllToggle')?.addEventListener('click', () => setLiveAll(!state.liveAll));

  // Re-attach thumbnail players onto the freshly-rendered canvases.
  if (state.wizardStep === 'dashboard') applyLiveAll();

  // Dashboard card actions
  page.querySelectorAll('[data-live]').forEach((b) => b.addEventListener('click', () => openLiveView(b.dataset.live)));
  page.querySelectorAll('[data-frames]').forEach((b) => b.addEventListener('click', () => openFrames(b.dataset.frames)));
  page.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    const cam = state.cameras.find((c) => c.id === b.dataset.del);
    confirmRemoveCamera(cam);
  }));
  page.querySelectorAll('[data-settings]').forEach((b) => b.addEventListener('click', () => openCaptureSettings(b.dataset.settings)));

  // Method chooser
  page.querySelectorAll('[data-method]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.method === 'manual') { state.manualBackStep = 'addMethod'; goStep('manualForm'); }
    else { goStep('autoScan'); startAutoScan(); }
  }));

  // Manual form
  $('m-add')?.addEventListener('click', addManualCamera);
  $('m-findpass')?.addEventListener('click', openFindPassword);

  // Auto scan results (wired after render)
  wireScanResults();
}

function wireScanResults() {
  $('scanAgain')?.addEventListener('click', startAutoScan);
  $('addManualInstead')?.addEventListener('click', () => { state.manualBackStep = 'autoScan'; goStep('manualForm'); });
  $('selectAll')?.addEventListener('change', (e) => {
    const selectable = [...state.scan.seen.keys()].filter((ip) => !savedCameraByIp(ip));
    state.scan.selected = e.target.checked ? new Set(selectable) : new Set();
    renderScanResults();
  });
  document.querySelectorAll('[data-pick]').forEach((cb) => cb.addEventListener('change', (e) => {
    if (e.target.checked) state.scan.selected.add(e.target.dataset.pick);
    else state.scan.selected.delete(e.target.dataset.pick);
    renderScanResults();
  }));
  document.querySelectorAll('[data-configure]').forEach((b) => b.addEventListener('click', () => {
    const d = state.scan.seen.get(b.dataset.configure);
    openManualPrefilled({ name: d?.vendor ? `${d.vendor} ${d.ip}` : d.ip, ip: d.ip });
  }));
  document.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => openTestStream(b.dataset.test)));
  document.querySelectorAll('[data-viewsaved]').forEach((b) => b.addEventListener('click', () => openLiveView(b.dataset.viewsaved)));
  $('addSelected')?.addEventListener('click', addSelectedCameras);
}

function renderScanResults() {
  const c = $('autoScanContainer');
  if (c) { c.innerHTML = scanResultsHTML(); wireScanResults(); }
}

function openManualPrefilled(prefill) {
  state.manualBackStep = 'autoScan'; // came from the scan list → Back returns there
  state.wizardStep = 'manualForm';
  const page = $('camerasPage');
  page.innerHTML = manualFormHTML(prefill);
  wireWizard();
}

// ── Test stream (probe a discovered device before adding it) ─────────────────
const TEST_KEY = 'test';
function openTestStream(ip) {
  const d = state.scan.seen.get(ip) || { ip };
  const port = 554; // RTSP default; user can override before connecting
  modal(`
    <div class="lv-modal">
      <div class="lv-head">
        <div class="lv-title"><span class="lv-name">Test stream</span>
          <span class="lv-sub">${esc(ip)} · ${esc(d.vendor || 'Unknown')}</span></div>
        <button class="modal-close-btn" id="ts-close">✕ Close</button>
      </div>
      <div class="video-wrap"><canvas id="ts-video"></canvas>
        <div id="ts-overlay" class="video-overlay">Enter the login and press Connect</div></div>
      <div class="lv-error" id="ts-error" hidden></div>
      <div class="ts-form">
        <div class="input-group"><label>Username</label>
          <div class="input-wrapper"><input id="ts-user" class="modern-input" value="admin" /></div></div>
        <div class="input-group"><label>Password</label>
          <div class="input-wrapper"><input id="ts-pass" class="modern-input" type="password" placeholder="••••••••" /></div></div>
        <div class="input-group"><label>RTSP Port</label>
          <div class="input-wrapper"><input id="ts-port" class="modern-input" type="number" value="${esc(port)}" /></div></div>
        <label class="checkline"><input id="ts-sub" type="checkbox" checked /> Use sub-stream</label>
        <button class="btn-primary" id="ts-connect">Connect</button>
      </div>
    </div>
  `, () => stopPlayer(TEST_KEY));

  $('ts-close').addEventListener('click', () => closeModal());
  $('ts-connect').addEventListener('click', () => connectTestStream(ip));
  ['ts-user', 'ts-pass', 'ts-port'].forEach((id) =>
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') connectTestStream(ip); }));
}

async function connectTestStream(ip) {
  const canvas = $('ts-video');
  const overlay = $('ts-overlay');
  const err = $('ts-error');
  if (!canvas) return;
  err.hidden = true;
  overlay.style.display = '';
  overlay.textContent = 'Connecting…';
  stopPlayer(TEST_KEY);

  const res = await api.startStream({
    key: TEST_KEY,
    ip,
    port: Number($('ts-port').value) || 554,
    username: $('ts-user').value.trim(),
    password: $('ts-pass').value,
    channel: 1,
    subStream: $('ts-sub').checked,
  });
  if (!res.ok) {
    overlay.style.display = 'none';
    err.hidden = false;
    err.textContent = res.error + '\nTip: most cameras need the right username / password.';
    return;
  }
  startPlayer(TEST_KEY, res.wsPort, canvas, () => { overlay.style.display = 'none'; });
}

// ── Headless stream probe (auto-test a camera before adding it) ──────────────
// Resolves { ok, error }: ok=true on the first decoded video frame, false on a
// stream error or timeout. Renders into an off-screen canvas.
let probeSeq = 0;
const streamProbes = new Map(); // key -> { onError }

function probeStream(opts, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const key = 'probe:' + (++probeSeq);
    const canvas = document.createElement('canvas');
    captureHost().appendChild(canvas);
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      streamProbes.delete(key);
      stopPlayer(key);
      try { canvas.remove(); } catch (_) {}
      resolve({ ok, error: error || '' });
    };
    const timer = setTimeout(() => finish(false, 'No video received (timed out)'), timeoutMs);
    streamProbes.set(key, { onError: (msg) => finish(false, msg) });

    api.startStream({ ...opts, key }).then((res) => {
      if (done) return;
      if (!res.ok) { finish(false, res.error); return; }
      startPlayer(key, res.wsPort, canvas, () => finish(true));
    }).catch((e) => finish(false, e.message));
  });
}

// Turn a verbose ffmpeg line into a short human status.
function shortStreamError(msg) {
  const s = String(msg || '');
  if (/401|unauthor/i.test(s)) return 'Wrong username / password';
  if (/timed out|timeout/i.test(s)) return 'No response';
  if (/refused|no route|unreachable|resolve/i.test(s)) return 'Unreachable';
  if (/404|not found|could not open|invalid data/i.test(s)) return 'No RTSP stream';
  return 'Could not connect';
}

async function startAutoScan() {
  state.scan.running = true;
  state.scan.done = false;
  state.scan.seen = new Map();
  state.scan.selected = new Set();
  state.scan.progress = { scanned: 0, total: 0 };
  const c = $('autoScanContainer');
  if (c) c.innerHTML = scanningAnimationHTML();

  const res = await api.startScan();
  state.scan.running = false;
  state.scan.done = true;
  renderScanResults();
  if (!res || !res.ok) toast('Scan error: ' + (res?.error || 'unknown'), 'error');
}

// Live scan progress → collect discovered devices.
api.onScanProgress((payload) => {
  if (payload?.device) {
    const d = payload.device;
    const prev = state.scan.seen.get(d.ip) || {};
    state.scan.seen.set(d.ip, { ...prev, ...d, ports: d.ports?.length ? d.ports : prev.ports || [] });
  }
  if (typeof payload?.scanned === 'number' && typeof payload?.total === 'number') {
    state.scan.progress = { scanned: payload.scanned, total: payload.total };
  }
  if (state.scan.running) updateScanProgressUI();
});

async function addManualCamera() {
  const cam = {
    name: $('m-name').value.trim(),
    location: $('m-location').value.trim(),
    ip: $('m-ip').value.trim(),
    port: Number($('m-port').value) || 554,
    username: $('m-username').value.trim(),
    password: $('m-password').value,
    channel: Number($('m-channel').value) || 1,
    subStream: $('m-sub').checked,
    rtspUrl: $('m-rtsp').value.trim(),
    ...(state.org?.captureDefaults || {}),
  };
  if (!cam.ip && !cam.rtspUrl) { showMsg('Enter a camera IP (or full RTSP URL).', true); return; }
  if (!cam.name) cam.name = cam.ip || 'Camera';

  // Auto-test the stream before saving.
  const addBtn = $('m-add');
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Testing…'; }
  showMsg('Testing stream…', false);
  const probeOpts = cam.rtspUrl
    ? { rtspUrl: cam.rtspUrl }
    : { ip: cam.ip, port: cam.port, username: cam.username, password: cam.password, channel: cam.channel, subStream: cam.subStream };
  const probe = await probeStream(probeOpts, 9000);
  if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'Add Camera'; }

  if (!probe.ok) {
    confirmAddUntested(cam, probe.error);
    return;
  }
  await saveManualCamera(cam);
}

// Offer to add a camera whose stream test failed (e.g. missing password).
function confirmAddUntested(cam, error) {
  modal(`
    <div class="confirm-modal">
      <div class="confirm-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <path d="M12 9v4" /><path d="M12 17h.01" />
        </svg>
      </div>
      <h2 class="confirm-title">Stream test failed</h2>
      <p class="confirm-text">Couldn’t get video from <strong>${esc(cam.ip || cam.rtspUrl)}</strong> — ${esc(shortStreamError(error))}. You can add it anyway and fix the login later.</p>
      <div class="confirm-actions">
        <button class="btn-secondary" id="untested-cancel">Back</button>
        <button class="btn-primary" id="untested-add">Add anyway</button>
      </div>
    </div>
  `);
  $('untested-cancel').addEventListener('click', () => closeModal());
  $('untested-add').addEventListener('click', () => { closeModal(); saveManualCamera(cam); });
}

async function saveManualCamera(cam) {
  const res = await api.saveCamera(cam);
  if (!res.ok) { showMsg(res.error, true); return; }
  toast(`Added "${res.camera.name}"`, 'success');
  goStep('dashboard');
  await refreshCameras();
}

const bulkTest = { cancelled: false };

function addSelectedCameras() {
  const picks = [...state.scan.selected];
  if (!picks.length) return;
  const targets = picks.map((ip) => {
    const d = state.scan.seen.get(ip) || { ip };
    return { ip, d, cfg: { ip, port: 554, username: 'admin', password: '', channel: 1, subStream: true } };
  });
  openBulkTestModal(targets);
}

// Test every selected camera's stream, then add the ones that connect.
async function openBulkTestModal(targets) {
  bulkTest.cancelled = false;
  modal(`
    <div class="bulk-test-modal">
      <div class="modal-header">
        <h2 class="modal-title">Testing streams<span class="modal-subtitle">${targets.length} selected</span></h2>
        <button class="modal-close-btn" id="bt-close">✕ Close</button>
      </div>
      <div class="bulk-test-list" id="bt-list">
        ${targets.map((t, i) => `
          <div class="bt-row">
            <span class="bt-ip">${esc(t.ip)}<span class="bt-vendor">${esc(t.d.vendor || 'Unknown')}</span></span>
            <span class="bt-status testing" id="bt-status-${i}"><span class="bt-spinner"></span> Testing…</span>
          </div>`).join('')}
      </div>
      <div class="bulk-test-actions" id="bt-actions" hidden></div>
    </div>
  `, () => { bulkTest.cancelled = true; });
  $('bt-close').addEventListener('click', () => closeModal());

  const results = new Array(targets.length);
  await Promise.all(targets.map((t, i) =>
    probeStream(t.cfg, 9000).then((r) => {
      results[i] = { ...t, ...r };
      const el = $(`bt-status-${i}`);
      if (el) {
        el.className = 'bt-status ' + (r.ok ? 'ok' : 'fail');
        el.textContent = r.ok ? '✓ Connected' : '✗ ' + shortStreamError(r.error);
      }
    })
  ));
  if (bulkTest.cancelled) return;
  showBulkResults(results);
}

function showBulkResults(results) {
  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  if (!fail.length) { commitBulkAdd(ok); return; } // all good → just add them

  const actions = $('bt-actions');
  if (!actions) return;
  actions.hidden = false;
  actions.innerHTML = `
    <p class="bt-summary">${ok.length} connected · ${fail.length} failed. Failed cameras usually need a password — add them, then set it under ⚙ or “Test stream”.</p>
    <div class="bt-btns">
      ${ok.length ? `<button class="btn-primary" id="bt-add-ok">Add ${ok.length} working</button>` : ''}
      <button class="btn-secondary" id="bt-add-all">Add all ${results.length} anyway</button>
      <button class="btn-ghost" id="bt-cancel">Cancel</button>
    </div>`;
  $('bt-add-ok')?.addEventListener('click', () => commitBulkAdd(ok));
  $('bt-add-all')?.addEventListener('click', () => commitBulkAdd(results));
  $('bt-cancel')?.addEventListener('click', () => closeModal());
}

async function commitBulkAdd(list) {
  const actions = $('bt-actions');
  if (actions) { actions.hidden = false; actions.innerHTML = `<p class="bt-summary">Adding ${list.length} camera${list.length > 1 ? 's' : ''}…</p>`; }
  for (const t of list) {
    await api.saveCamera({
      name: t.d?.vendor ? `${t.d.vendor} ${t.ip}` : t.ip,
      ip: t.ip,
      username: 'admin',
      vendor: t.d?.vendor || '',
      ...(state.org?.captureDefaults || {}),
    });
  }
  closeModal();
  toast(`Added ${list.length} camera${list.length > 1 ? 's' : ''}`, 'success');
  goStep('dashboard');
  await refreshCameras();
}

function showMsg(text, isError) {
  const n = $('m-msg');
  if (!n) return;
  n.hidden = false;
  n.textContent = text;
  n.className = 'message-banner' + (isError ? ' error' : '');
}

// Styled "remove camera?" confirmation (replaces the native confirm dialog).
function confirmRemoveCamera(cam) {
  const name = cam?.name || 'this camera';
  modal(`
    <div class="confirm-modal">
      <div class="confirm-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6" /><path d="M14 11v6" />
        </svg>
      </div>
      <h2 class="confirm-title">Remove camera?</h2>
      <p class="confirm-text">“${esc(name)}” will be removed from Patrol Sense. Captured frames for this camera are also deleted. This can’t be undone.</p>
      <div class="confirm-actions">
        <button class="btn-secondary" id="confirm-cancel">Cancel</button>
        <button class="btn-danger" id="confirm-remove">Remove camera</button>
      </div>
    </div>
  `);
  $('confirm-cancel').addEventListener('click', () => closeModal());
  $('confirm-remove').addEventListener('click', async () => {
    closeModal();
    stopPlayer(thumbKey(cam.id)); // drop its Live-All thumbnail stream first
    await api.deleteCamera(cam.id);
    await refreshCameras();
    toast(`Removed “${name}”`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  LIVE VIEW + CANVAS FRAME CAPTURE
// ═══════════════════════════════════════════════════════════════════════════

const live = { cameraId: null, key: 'live', active: false, intervalTimer: null, motionTimer: null,
  detector: null, frameCount: 0 };

async function openLiveView(cameraId) {
  const cam = state.cameras.find((c) => c.id === cameraId);
  if (!cam) return;
  live.cameraId = cameraId;
  live.active = true;
  reconcileCapture(); // hand this camera's capture over to the modal (no double-capture)
  live.frameCount = await api.countFrames(cameraId);

  modal(`
    <div class="lv-modal">
      <div class="lv-head">
        <div class="lv-title"><span class="lv-name">${esc(cam.name)}</span>
          <span class="lv-sub">${esc(cam.ip)}${cam.port ? ':' + cam.port : ''}</span></div>
        <button class="modal-close-btn" id="lv-close">✕ Close</button>
      </div>
      <div class="video-wrap"><canvas id="lv-video"></canvas>
        <div id="lv-overlay" class="video-overlay">Connecting…</div>
        <span id="lv-motion-status" class="motion-status-chip" hidden></span>
        <div id="lv-motion-hl" class="motion-hl live-motion-hl" hidden></div></div>
      <div class="lv-error" id="lv-error" hidden></div>
      <div class="lv-controls">
        <div class="lv-capture">
          <span class="lv-capture-label">Capture</span>
          <div class="capture-mode-seg" id="lv-seg">
            <button class="seg-btn ${cam.captureMode === 'off' ? 'active' : ''}" data-mode="off">Off</button>
            <button class="seg-btn ${cam.captureMode === 'interval' ? 'active' : ''}" data-mode="interval">Interval</button>
            <button class="seg-btn ${cam.captureMode === 'motion' ? 'active' : ''}" data-mode="motion">Motion</button>
          </div>
        </div>
        <div class="lv-capture-opts" id="lv-opts">
          <label class="lv-opt" id="lv-interval-opt"><span>Every</span>
            <input id="lv-interval" type="number" min="1" value="${cam.intervalSec}" /><span>sec</span></label>
          <div class="lv-opt lv-opt-sens" id="lv-motion-opt"><span class="lv-opt-title">Sensitivity</span>
            ${sensitivityControlHTML('lv-sens', cam.sensitivity)}
            <span class="lv-opt-title">Object size</span>
            ${objectSizeControlHTML('lv-objsize', cam.objectSize)}</div>
        </div>
        <div class="lv-capture-status">
          <span class="lv-shots" id="lv-count">${live.frameCount} frames</span>
          <button class="btn-secondary" id="lv-shot">📸 Capture now</button>
          <button class="btn-secondary" id="lv-viewframes">View Frames</button>
        </div>
      </div>
    </div>
  `, closeLiveView);

  $('lv-close').addEventListener('click', () => { closeModal(); });
  $('lv-viewframes').addEventListener('click', () => { closeModal(); openFrames(cameraId); });
  $('lv-shot').addEventListener('click', () => captureFrame(false));
  $('lv-seg').querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => setCaptureMode(b.dataset.mode)));
  $('lv-interval').addEventListener('change', () => { if (getMode() === 'interval') restartCapture(); persistCaptureSettings(); });
  wireSensitivityControl('lv-sens', () => persistCaptureSettings());
  wireObjectSizeControl('lv-objsize', () => persistCaptureSettings());

  updateCaptureOptsVisibility(cam.captureMode);
  await startLivePlayer(cam);
  if (cam.captureMode !== 'off') startCaptureLoop(cam.captureMode);
}

async function startLivePlayer(cam) {
  const canvas = $('lv-video');
  const overlay = $('lv-overlay');
  stopPlayer(live.key);
  const opts = { key: live.key, cameraId: cam.id };
  const res = await api.startStream(opts);
  if (!res.ok) {
    overlay.style.display = 'none';
    const e = $('lv-error'); e.hidden = false;
    e.textContent = res.error + '\nTip: check the login under “Find password”, or edit the camera.';
    return;
  }
  startPlayer(live.key, res.wsPort, canvas, () => { overlay.style.display = 'none'; resetMotionDetector(live.detector); });
}

function getMode() {
  const active = $('lv-seg')?.querySelector('.seg-btn.active');
  return active?.dataset.mode || 'off';
}

function updateCaptureOptsVisibility(mode) {
  const iv = $('lv-interval-opt'), mo = $('lv-motion-opt');
  if (iv) iv.style.display = mode === 'interval' ? '' : 'none';
  if (mo) mo.style.display = mode === 'motion' ? '' : 'none';
  const wrap = $('lv-opts');
  if (wrap) wrap.style.display = mode === 'off' ? 'none' : '';
  if (mode !== 'motion') clearMotionOverlay($('lv-motion-hl'), $('lv-motion-status'));
}

function setCaptureMode(mode) {
  $('lv-seg').querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  updateCaptureOptsVisibility(mode);
  stopCaptureLoop();
  if (mode !== 'off') startCaptureLoop(mode);
  persistCaptureSettings();
}

function startCaptureLoop(mode) {
  stopCaptureLoop();
  if (mode === 'interval') {
    const sec = Math.max(1, Number($('lv-interval').value) || 10);
    live.intervalTimer = setInterval(() => captureFrame(false), sec * 1000);
  } else if (mode === 'motion') {
    live.detector = createMotionDetector();
    live.motionTimer = setInterval(checkMotion, MOTION_INTERVAL_MS);
  }
}
function restartCapture() { if (getMode() !== 'off') startCaptureLoop(getMode()); }
function stopCaptureLoop() {
  if (live.intervalTimer) clearInterval(live.intervalTimer);
  if (live.motionTimer) clearInterval(live.motionTimer);
  live.intervalTimer = live.motionTimer = null;
  clearMotionOverlay($('lv-motion-hl'), $('lv-motion-status'));
}

// ── MOTION DETECTION (renderer glue) ─────────────────────────────────────────
// The engine itself lives in motion.js (DOM-free, unit-tested): clampSensitivity,
// motionParams, frameIsBlank, largestBlob, analyzeFrame, updateBackground,
// createMotionDetector / resetMotionDetector, feedMotion, plus the SAMPLE_*,
// SENSITIVITY_* and RECOMMENDED_SENSITIVITY constants. Everything below is the
// renderer-only glue that turns a live canvas into samples and saves captures.

// Downsample any canvas to a grayscale Float32Array. The coarse grid is
// deliberate: averaging many real pixels per cell blurs out grain before we diff.
const _mo = document.createElement('canvas');
_mo.width = SAMPLE_W; _mo.height = SAMPLE_H;
const _moCtx = _mo.getContext('2d', { willReadFrequently: true });
function sampleCanvas(src) {
  if (!src || !src.width) return null;
  try {
    _moCtx.drawImage(src, 0, 0, SAMPLE_W, SAMPLE_H);
    const d = _moCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    const g = new Float32Array(SAMPLE_N);
    for (let i = 0; i < g.length; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    return g;
  } catch (_) { return null; }
}
// Draw the live detection box for calibration: Live View and the gear "Auto-
// capture" preview both call this every sample tick. `box` is normalised
// {x,y,w,h} (0–1) over the FULL video frame; `videoCanvas` holds the actual
// decoded resolution while `wrapEl` is its on-screen container, which may be
// letterboxed (the canvas is shown at object-fit:contain, not stretched) — so
// we reproduce that same contain-fit math here to place the box in real pixels
// rather than assuming the canvas fills the wrap. `state` drives both the box's
// styling and an optional status chip: 'idle' (nothing detected), 'candidate'
// (a blob passed the gates but hasn't persisted long enough to confirm), or
// 'active' (a confirmed, ongoing event).
function paintMotionOverlay(hlEl, wrapEl, videoCanvas, box, state, statusEl) {
  const s = state || 'idle';
  if (statusEl) {
    statusEl.hidden = false; // markup starts `hidden`; every real tick has a state to show
    statusEl.classList.remove('state-active', 'state-candidate', 'state-idle');
    statusEl.classList.add('state-' + s);
    statusEl.textContent = s === 'active' ? 'MOTION' : s === 'candidate' ? 'Detecting…' : 'No motion';
  }
  if (!hlEl) return;
  if (!box || !wrapEl || !videoCanvas || !videoCanvas.width) { hlEl.hidden = true; return; }
  const wrapW = wrapEl.clientWidth, wrapH = wrapEl.clientHeight;
  const vw = videoCanvas.width, vh = videoCanvas.height;
  if (!wrapW || !wrapH || !vw || !vh) { hlEl.hidden = true; return; }
  const scale = Math.min(wrapW / vw, wrapH / vh);
  const dispW = vw * scale, dispH = vh * scale;
  const offX = (wrapW - dispW) / 2, offY = (wrapH - dispH) / 2;
  hlEl.style.left = `${offX + box.x * dispW}px`;
  hlEl.style.top = `${offY + box.y * dispH}px`;
  hlEl.style.width = `${box.w * dispW}px`;
  hlEl.style.height = `${box.h * dispH}px`;
  hlEl.hidden = false;
  hlEl.classList.toggle('state-active', s === 'active');
  hlEl.classList.toggle('state-candidate', s === 'candidate');
}

// Current sensitivity from the Live View slider (falls back to the saved value).
function currentLiveSensitivity() {
  const el = $('lv-sens');
  if (el) return clampSensitivity(el.value);
  const cam = state.cameras.find((c) => c.id === live.cameraId);
  return clampSensitivity(cam?.sensitivity);
}
function currentLiveObjectSize() {
  const el = $('lv-objsize');
  if (el) return clampObjectSize(el.value);
  const cam = state.cameras.find((c) => c.id === live.cameraId);
  return clampObjectSize(cam?.objectSize);
}

function checkMotion() {
  const video = $('lv-video');
  const cur = sampleCanvas(video);
  if (!cur || !live.detector) return;
  // Blank/reconnect frames must not enter the detector — they poison the
  // background and can confirm a false event. Reset so the next real frame
  // re-seeds cleanly instead of diffing against a stale bg.
  if (frameIsBlank(cur)) {
    resetMotionDetector(live.detector);
    paintMotionOverlay($('lv-motion-hl'), video?.parentElement, video, null, 'idle', $('lv-motion-status'));
    return;
  }
  const r = feedMotion(live.detector, cur, currentLiveSensitivity(), Date.now(), currentLiveObjectSize());
  paintMotionOverlay($('lv-motion-hl'), video?.parentElement, video, r.box, r.state, $('lv-motion-status'));
  if (r.capture) captureFrame(true, r.box);
}

// Hide the live calibration box + status chip (mode switched away from motion,
// or capture stopped) so a stale box never lingers on screen.
function clearMotionOverlay(hlEl, statusEl) {
  if (hlEl) hlEl.hidden = true;
  if (statusEl) { statusEl.hidden = true; statusEl.classList.remove('state-active', 'state-candidate', 'state-idle'); }
}

// ── Sensitivity + object-size controls (Live View + the gear dialog) ─────────
// Two 0–100 dials. Sensitivity: higher = more captures from subtler change.
// Object size: higher = only larger moving regions count (ignore small/distant).
// 50 is recommended for both.
function sensitivityLabel(v) {
  v = clampSensitivity(v);
  if (v <= 19) return 'Very low';
  if (v <= 39) return 'Low';
  if (v <= 60) return 'Medium (recommended)';
  if (v <= 80) return 'High';
  return 'Very high';
}
function sensitivityControlHTML(idBase, value) {
  const v = clampSensitivity(value);
  return `
    <div class="sens-control" id="${idBase}-wrap">
      <div class="sens-head">
        <span class="sens-readout" id="${idBase}-out">${sensitivityLabel(v)} · ${v}</span>
        <button type="button" class="sens-reco" id="${idBase}-reco">Use recommended</button>
      </div>
      <input type="range" class="sens-range" id="${idBase}" min="${SENSITIVITY_MIN}" max="${SENSITIVITY_MAX}" step="5" value="${v}" />
      <div class="sens-scale"><span>Fewer captures</span><span>More captures</span></div>
    </div>`;
}
function wireSensitivityControl(idBase, onCommit) {
  const input = $(idBase), out = $(`${idBase}-out`), reco = $(`${idBase}-reco`);
  if (!input) return;
  const paint = () => { if (out) out.textContent = `${sensitivityLabel(input.value)} · ${clampSensitivity(input.value)}`; };
  input.addEventListener('input', paint);
  input.addEventListener('change', () => { paint(); onCommit && onCommit(clampSensitivity(input.value)); });
  if (reco) reco.addEventListener('click', () => {
    input.value = RECOMMENDED_SENSITIVITY; paint(); onCommit && onCommit(RECOMMENDED_SENSITIVITY);
  });
  paint();
}

function objectSizeLabel(v) {
  v = clampObjectSize(v);
  if (v <= 19) return 'Any size';
  if (v <= 39) return 'Small+';
  if (v <= 60) return 'Medium (recommended)';
  if (v <= 80) return 'Large+';
  return 'Large only';
}
function objectSizeControlHTML(idBase, value) {
  const v = clampObjectSize(value);
  return `
    <div class="sens-control" id="${idBase}-wrap">
      <div class="sens-head">
        <span class="sens-readout" id="${idBase}-out">${objectSizeLabel(v)} · ${v}</span>
        <button type="button" class="sens-reco" id="${idBase}-reco">Use recommended</button>
      </div>
      <input type="range" class="sens-range" id="${idBase}" min="${OBJECT_SIZE_MIN}" max="${OBJECT_SIZE_MAX}" step="5" value="${v}" />
      <div class="sens-scale"><span>Smaller objects</span><span>Larger only</span></div>
    </div>`;
}
function wireObjectSizeControl(idBase, onCommit) {
  const input = $(idBase), out = $(`${idBase}-out`), reco = $(`${idBase}-reco`);
  if (!input) return;
  const paint = () => { if (out) out.textContent = `${objectSizeLabel(input.value)} · ${clampObjectSize(input.value)}`; };
  input.addEventListener('input', paint);
  input.addEventListener('change', () => { paint(); onCommit && onCommit(clampObjectSize(input.value)); });
  if (reco) reco.addEventListener('click', () => {
    input.value = RECOMMENDED_OBJECT_SIZE; paint(); onCommit && onCommit(RECOMMENDED_OBJECT_SIZE);
  });
  paint();
}

async function captureFrame(motion, box) {
  const src = $('lv-video');
  if (!src || !src.width) return;
  if (frameIsBlank(sampleCanvas(src))) return; // never save an empty frame
  let dataUrl;
  try { dataUrl = src.toDataURL('image/jpeg', 0.7); } catch (_) { return; }
  const res = await api.saveFrame({ cameraId: live.cameraId, dataUrl, motion: !!motion, motionBox: box || null, width: src.width, height: src.height });
  if (res?.ok) {
    live.frameCount++;
    const n = $('lv-count'); if (n) n.textContent = `${live.frameCount} frames`;
    const shot = $('lv-shot');
    if (shot && !motion) { shot.textContent = '✓ Captured'; setTimeout(() => (shot.textContent = '📸 Capture now'), 900); }
  }
}

async function persistCaptureSettings() {
  const cam = state.cameras.find((c) => c.id === live.cameraId);
  if (!cam) return;
  const patch = {
    ...cam, // preserve ip/port/username/channel/subStream/rtspUrl/vendor/location
    captureMode: getMode(),
    intervalSec: Math.max(1, Number($('lv-interval')?.value) || cam.intervalSec),
    sensitivity: clampSensitivity($('lv-sens')?.value ?? cam.sensitivity),
    objectSize: clampObjectSize($('lv-objsize')?.value ?? cam.objectSize),
  };
  const res = await api.saveCamera(patch);
  if (res.ok) { const i = state.cameras.findIndex((c) => c.id === cam.id); if (i >= 0) state.cameras[i] = res.camera; }
}

function closeLiveView() {
  live.active = false;
  stopCaptureLoop();
  stopPlayer(live.key);
  live.detector = null;
  refreshCameras(); // triggers reconcileCapture → resumes this camera's background capture
}

// ═══════════════════════════════════════════════════════════════════════════
//  BACKGROUND AUTO-CAPTURE
//  Hidden streams + capture loops so cameras keep saving frames (interval or
//  motion) even when Live View is closed. One entry per capturing camera.
// ═══════════════════════════════════════════════════════════════════════════

const capture = { entries: new Map(), host: null };

function captureHost() {
  if (!capture.host || !document.body.contains(capture.host)) {
    const h = document.createElement('div');
    h.id = 'captureHost';
    // Positioned off-screen but NOT collapsed/transparent — a 0×0 or opacity:0
    // host makes Chromium skip compositing, so JSMpeg's canvas reads back blank.
    // Keeping real layout off-screen lets toDataURL/getImageData return real pixels.
    h.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none;';
    document.body.appendChild(h);
    capture.host = h;
  }
  return capture.host;
}

// The canvas currently painting this camera's video via the Live-All thumbnail,
// if one exists and has decoded a frame. Lets capture reuse a known-good visible
// stream instead of opening a second RTSP connection.
function liveThumbCanvas(id) {
  if (!players.has(THUMB_PREFIX + id)) return null;
  const card = document.querySelector(`.camera-card[data-id="${id}"]`);
  const cv = card?.querySelector('.camera-feed');
  return cv && cv.width ? cv : null;
}

// Whichever canvas is currently showing real video for this capture entry.
// Prefer the entry's own hidden stream once it has painted — pinning one
// source for the session avoids flipping thumb ↔ hidden mid-event (different
// ffmpeg/JSMpeg pipelines), which spikes the motion detector with large diffs.
// Fall back to the Live-All thumbnail only while the hidden canvas isn't ready.
function captureSourceCanvas(entry) {
  if (entry.ready && entry.canvas && entry.canvas.width) return entry.canvas;
  return liveThumbCanvas(entry.id);
}

// ═══════════════════════════════════════════════════════════════════════════
//  LIVE CALIBRATION PREVIEW (gear ▸ Auto-capture ▸ Sensitivity)
//  A small live feed + detection-box overlay inside the settings dialog, so
//  sensitivity can be dialed in by eye instead of guessing and checking the
//  Frames gallery afterward. Runs its own MotionDetector, purely for display —
//  it never saves a frame. Reuses an already-decoded canvas (background capture
//  entry or Live-All thumbnail) when this camera already has one running, to
//  avoid opening a second RTSP connection to the same camera; only falls back
//  to a dedicated stream when nothing else is already showing this camera.
// ═══════════════════════════════════════════════════════════════════════════

const calib = { cameraId: null, key: null, detector: null, timer: null, mirrorFrom: null, mirrorRaf: null };

function calibSourceCanvas(camId) {
  const entry = capture.entries.get(camId);
  if (entry) { const c = captureSourceCanvas(entry); if (c) return c; }
  return liveThumbCanvas(camId);
}

function calibMirrorTick() {
  if (!calib.mirrorFrom) return;
  const dst = $('cap-preview-video'), src = calib.mirrorFrom;
  if (dst && src && src.width) {
    if (dst.width !== src.width || dst.height !== src.height) { dst.width = src.width; dst.height = src.height; }
    try { dst.getContext('2d').drawImage(src, 0, 0); } catch (_) {}
  }
  calib.mirrorRaf = requestAnimationFrame(calibMirrorTick);
}

async function startCalibPreview(cam) {
  stopCalibPreview();
  calib.cameraId = cam.id;
  calib.detector = createMotionDetector();
  const previewCanvas = $('cap-preview-video'), overlay = $('cap-preview-overlay');
  if (!previewCanvas) return;

  const reuse = calibSourceCanvas(cam.id);
  if (reuse) {
    calib.mirrorFrom = reuse;
    if (overlay) overlay.style.display = 'none';
    calib.mirrorRaf = requestAnimationFrame(calibMirrorTick);
  } else {
    calib.key = 'calib:' + cam.id;
    const res = await api.startStream({ key: calib.key, cameraId: cam.id });
    if (calib.cameraId !== cam.id) { stopPlayer(calib.key); return; } // dialog moved on while we awaited
    if (!res.ok) { if (overlay) overlay.textContent = res.error || 'Preview unavailable'; return; }
    startPlayer(calib.key, res.wsPort, previewCanvas, () => { if (overlay) overlay.style.display = 'none'; });
  }
  calib.timer = setInterval(() => tickCalibPreview(cam), MOTION_INTERVAL_MS);
}

function tickCalibPreview(cam) {
  const src = calib.mirrorFrom || $('cap-preview-video');
  const cur = sampleCanvas(src);
  if (!cur || !calib.detector) return;
  if (frameIsBlank(cur)) {
    resetMotionDetector(calib.detector);
    const video = $('cap-preview-video');
    paintMotionOverlay($('cap-preview-hl'), video?.parentElement, video, null, 'idle', $('cap-preview-status'));
    return;
  }
  const sens = clampSensitivity($('cap-sens')?.value ?? cam.sensitivity);
  const objSize = clampObjectSize($('cap-objsize')?.value ?? cam.objectSize);
  const r = feedMotion(calib.detector, cur, sens, Date.now(), objSize);
  const video = $('cap-preview-video');
  paintMotionOverlay($('cap-preview-hl'), video?.parentElement, video, r.box, r.state, $('cap-preview-status'));
}

function stopCalibPreview() {
  if (calib.timer) clearInterval(calib.timer);
  if (calib.mirrorRaf) cancelAnimationFrame(calib.mirrorRaf);
  if (calib.key) stopPlayer(calib.key);
  calib.cameraId = null; calib.key = null; calib.detector = null; calib.timer = null;
  calib.mirrorFrom = null; calib.mirrorRaf = null;
}

// A camera should background-capture when its mode is set — unless it is the
// one open in Live View, which handles its own capture (avoids a duplicate
// ffmpeg process and double-saved frames).
function shouldCapture(cam) {
  if (cam.captureMode !== 'interval' && cam.captureMode !== 'motion') return false;
  if (live.active && live.cameraId === cam.id) return false;
  return true;
}

// Start/stop/refresh background capture to match the current camera settings.
function reconcileCapture() {
  const want = new Map();
  for (const cam of state.cameras) if (shouldCapture(cam)) want.set(cam.id, cam);

  for (const id of [...capture.entries.keys()]) if (!want.has(id)) stopCaptureEntry(id);
  for (const [id, cam] of want) {
    const e = capture.entries.get(id);
    if (!e) startCaptureEntry(cam);
    else updateCaptureEntry(e, cam);
  }
}

async function startCaptureEntry(cam) {
  const canvas = document.createElement('canvas');
  captureHost().appendChild(canvas);
  const key = 'cap:' + cam.id;
  const entry = { id: cam.id, key, canvas, cam, ready: false, intervalTimer: null, motionTimer: null, detector: null };
  capture.entries.set(cam.id, entry);

  stopPlayer(key);
  const res = await api.startStream({ key, cameraId: cam.id });
  // Reconcile may have replaced/removed this entry while we awaited.
  if (capture.entries.get(cam.id) !== entry) { stopPlayer(key); try { canvas.remove(); } catch (_) {} return; }
  if (!res.ok) { stopCaptureEntry(cam.id); return; } // e.g. bad credentials — don't spin

  // Gate capture on the first decoded frame so we never save a blank canvas.
  startPlayer(key, res.wsPort, canvas, () => { entry.ready = true; resetMotionDetector(entry.detector); });
  startEntryLoop(entry);
}

function updateCaptureEntry(entry, cam) {
  const changed = entry.cam.captureMode !== cam.captureMode
    || entry.cam.intervalSec !== cam.intervalSec
    || entry.cam.sensitivity !== cam.sensitivity
    || entry.cam.objectSize !== cam.objectSize;
  entry.cam = cam;
  if (changed) startEntryLoop(entry);
}

function startEntryLoop(entry) {
  stopEntryLoop(entry);
  entry.detector = null;
  if (entry.cam.captureMode === 'interval') {
    const sec = Math.max(1, Number(entry.cam.intervalSec) || 10);
    entry.intervalTimer = setInterval(() => grabEntryFrame(entry, false), sec * 1000);
  } else if (entry.cam.captureMode === 'motion') {
    entry.detector = createMotionDetector();
    entry.motionTimer = setInterval(() => checkEntryMotion(entry), MOTION_INTERVAL_MS);
  }
}

function stopEntryLoop(entry) {
  if (entry.intervalTimer) clearInterval(entry.intervalTimer);
  if (entry.motionTimer) clearInterval(entry.motionTimer);
  entry.intervalTimer = entry.motionTimer = null;
}

function stopCaptureEntry(id) {
  const e = capture.entries.get(id);
  if (!e) return;
  stopEntryLoop(e);
  stopPlayer(e.key);
  try { e.canvas.remove(); } catch (_) {}
  capture.entries.delete(id);
}

function stopAllCapture() {
  for (const id of [...capture.entries.keys()]) stopCaptureEntry(id);
}

async function grabEntryFrame(entry, motion, box) {
  const src = captureSourceCanvas(entry);
  if (!src || !src.width) return;
  if (frameIsBlank(sampleCanvas(src))) return; // never save an empty frame
  let dataUrl;
  try { dataUrl = src.toDataURL('image/jpeg', 0.7); } catch (_) { return; }
  await api.saveFrame({ cameraId: entry.id, dataUrl, motion: !!motion, motionBox: box || null, width: src.width, height: src.height });
}

function checkEntryMotion(entry) {
  const cur = sampleCanvas(captureSourceCanvas(entry));
  if (!cur || !entry.detector) return;
  if (frameIsBlank(cur)) {
    resetMotionDetector(entry.detector);
    return;
  }
  const r = feedMotion(entry.detector, cur, entry.cam.sensitivity, Date.now(), entry.cam.objectSize);
  if (r.capture) grabEntryFrame(entry, true, r.box);
}

// ── Per-camera capture settings dialog (the gear button) ─────────────────────
function openCaptureSettings(cameraId) {
  const cam = state.cameras.find((c) => c.id === cameraId);
  if (!cam) return;
  modal(`
    <div class="cap-modal">
      <div class="modal-header">
        <h2 class="modal-title">Auto-capture<span class="modal-subtitle">${esc(cam.name)}</span></h2>
        <button class="modal-close-btn" id="cap-close">✕ Close</button>
      </div>
      <div class="cap-body">
        <p class="cap-note">Automatically save frames from this camera in the background — even when Live View is closed.</p>
        <div class="cap-field">
          <span class="cap-label">Mode</span>
          <div class="capture-mode-seg" id="cap-seg">
            <button class="seg-btn ${cam.captureMode === 'off' ? 'active' : ''}" data-mode="off">Off</button>
            <button class="seg-btn ${cam.captureMode === 'interval' ? 'active' : ''}" data-mode="interval">Interval</button>
            <button class="seg-btn ${cam.captureMode === 'motion' ? 'active' : ''}" data-mode="motion">Motion</button>
          </div>
        </div>
        <div class="cap-field" id="cap-interval-opt">
          <span class="cap-label">Every</span>
          <span class="cap-inline"><input id="cap-interval" class="modern-input" type="number" min="1" value="${esc(cam.intervalSec)}" /><span class="cap-unit">seconds</span></span>
        </div>
        <div class="cap-field cap-field-col" id="cap-motion-opt">
          <span class="cap-label">Sensitivity</span>
          ${sensitivityControlHTML('cap-sens', cam.sensitivity)}
          <span class="cap-label">Object size</span>
          ${objectSizeControlHTML('cap-objsize', cam.objectSize)}
          <div class="cap-preview-wrap">
            <div class="video-wrap cap-preview-video-wrap">
              <canvas id="cap-preview-video"></canvas>
              <div id="cap-preview-overlay" class="video-overlay">Connecting preview…</div>
              <span id="cap-preview-status" class="motion-status-chip" hidden></span>
              <div id="cap-preview-hl" class="motion-hl live-motion-hl" hidden></div>
            </div>
            <p class="cap-preview-caption">Live calibration — detects movement against the learned background, not whether a person is present. A standing person already in the scene shows No motion until they move. Lower Object size to catch smaller/distant movers.</p>
          </div>
        </div>
      </div>
      <div class="cap-actions">
        <button class="btn-secondary" id="cap-cancel">Cancel</button>
        <button class="btn-primary" id="cap-save">Save</button>
      </div>
    </div>
  `, stopCalibPreview);

  const seg = $('cap-seg');
  const syncVis = () => {
    const m = seg.querySelector('.seg-btn.active')?.dataset.mode || 'off';
    $('cap-interval-opt').style.display = m === 'interval' ? '' : 'none';
    $('cap-motion-opt').style.display = m === 'motion' ? '' : 'none';
    if (m === 'motion') startCalibPreview(cam); else stopCalibPreview();
  };
  seg.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    seg.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    syncVis();
  }));
  syncVis();

  wireSensitivityControl('cap-sens'); // read live by the calibration preview; persisted on Save
  wireObjectSizeControl('cap-objsize');
  $('cap-close').addEventListener('click', () => closeModal());
  $('cap-cancel').addEventListener('click', () => closeModal());
  $('cap-save').addEventListener('click', () => saveCaptureSettings(cam));
}

async function saveCaptureSettings(cam) {
  const mode = $('cap-seg').querySelector('.seg-btn.active')?.dataset.mode || 'off';
  const patch = {
    ...cam, // preserve ip/port/username/channel/subStream/rtspUrl/vendor/location
    captureMode: mode,
    intervalSec: Math.max(1, Number($('cap-interval').value) || cam.intervalSec || 10),
    sensitivity: clampSensitivity($('cap-sens')?.value ?? cam.sensitivity),
    objectSize: clampObjectSize($('cap-objsize')?.value ?? cam.objectSize),
  };
  const res = await api.saveCamera(patch);
  if (!res.ok) { toast('Could not save: ' + (res.error || 'error'), 'error'); return; }
  const i = state.cameras.findIndex((c) => c.id === cam.id);
  if (i >= 0) state.cameras[i] = res.camera;
  closeModal();
  renderWizard();      // refresh the card's status pill
  reconcileCapture();  // start/stop background capture to match
  toast(mode === 'off' ? 'Auto-capture turned off' : `Auto-capture: ${mode === 'interval' ? 'every ' + patch.intervalSec + 's' : 'on motion'}`, mode === 'off' ? '' : 'success');
}

// ═══════════════════════════════════════════════════════════════════════════
//  FRAMES GALLERY + LIGHTBOX
// ═══════════════════════════════════════════════════════════════════════════

const gallery = { cameraId: null, frames: [], motionOnly: false, highlight: true, lightbox: -1 };

async function openFrames(cameraId) {
  const cam = state.cameras.find((c) => c.id === cameraId);
  gallery.cameraId = cameraId;
  gallery.motionOnly = false;
  const res = await api.listFrames(cameraId, { limit: 200, motionOnly: false });
  gallery.frames = res.frames || [];

  modal(`
    <div class="frames-modal">
      <div class="modal-header">
        <h2 class="modal-title">Frames — ${esc(cam?.name || cameraId)}
          <span class="modal-subtitle" id="fr-count">(${res.total} frames)</span></h2>
        <button class="modal-close-btn" id="fr-close">✕ Close</button>
      </div>
      <div class="modal-filters">
        <label class="filter-check"><input type="checkbox" id="fr-motion" />
          <span class="filter-check-box"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l4.5 4.5L19 7"/></svg></span>
          <span class="filter-check-label">Motion detected only</span></label>
        <label class="filter-check"><input type="checkbox" id="fr-highlight" ${gallery.highlight ? 'checked' : ''} />
          <span class="filter-check-box"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l4.5 4.5L19 7"/></svg></span>
          <span class="filter-check-label">Highlight motion</span></label>
        <div class="filter-spacer"></div>
        <button class="btn-secondary" id="fr-clear">🗑 Clear all</button>
      </div>
      <div class="modal-body frames-body" id="fr-body">${framesGridHTML()}</div>
    </div>
  `, () => {});

  $('fr-close').addEventListener('click', closeModal);
  $('fr-motion').addEventListener('change', async (e) => {
    gallery.motionOnly = e.target.checked;
    const r = await api.listFrames(cameraId, { limit: 200, motionOnly: gallery.motionOnly });
    gallery.frames = r.frames || [];
    $('fr-count').textContent = `(${r.total} frames)`;
    $('fr-body').innerHTML = framesGridHTML();
    wireFrameCards();
  });
  $('fr-highlight').addEventListener('change', (e) => {
    gallery.highlight = e.target.checked;
    $('fr-body').innerHTML = framesGridHTML();
    wireFrameCards();
    if ($('lightbox')) renderLightbox();
  });
  $('fr-clear').addEventListener('click', async () => {
    if (!confirm('Delete ALL captured frames for this camera?')) return;
    await api.clearFrames(cameraId);
    gallery.frames = [];
    $('fr-count').textContent = '(0 frames)';
    $('fr-body').innerHTML = framesGridHTML();
  });
  wireFrameCards();
}

// Absolutely-positioned outline over the moving region. `box` is normalised
// {x,y,w,h} (0–1) relative to the full frame, so it maps straight to CSS %.
function motionBoxHTML(f) {
  if (!gallery.highlight || !f.motion || !f.motionBox) return '';
  const b = f.motionBox;
  return `<div class="motion-hl" style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%"></div>`;
}

function framesGridHTML() {
  if (!gallery.frames.length) return `<div class="frames-empty">No frames captured yet. Open Live View and turn on Interval or Motion capture.</div>`;
  return `<div class="frames-grid">${gallery.frames.map((f, i) => `
    <div class="frame-card ${f.motion ? 'motion' : ''}" data-idx="${i}">
      ${f.motion ? `<span class="frame-motion-badge">MOTION</span>` : ''}
      <div class="frame-image-wrapper"><img src="${f.dataUrl}" alt="frame" loading="lazy" />${motionBoxHTML(f)}</div>
      <div class="frame-meta">
        <div>${new Date(f.timestamp).toLocaleString()}</div>
        <div>${(f.size / 1024).toFixed(0)} KB</div>
      </div>
    </div>`).join('')}</div>`;
}

function wireFrameCards() {
  document.querySelectorAll('.frame-card[data-idx]').forEach((c) =>
    c.addEventListener('click', () => openLightbox(Number(c.dataset.idx))));
}

function openLightbox(idx) {
  gallery.lightbox = idx;
  const host = document.createElement('div');
  host.className = 'lightbox-overlay';
  host.id = 'lightbox';
  document.body.appendChild(host);
  renderLightbox();
  host.addEventListener('click', (e) => { if (e.target === host) closeLightbox(); });
  document.addEventListener('keydown', lightboxKeys);
}
function renderLightbox() {
  const f = gallery.frames[gallery.lightbox];
  if (!f) return;
  $('lightbox').innerHTML = `
    <div class="lightbox-content">
      <div class="lightbox-bar">
        <span class="lightbox-pos">${gallery.lightbox + 1} / ${gallery.frames.length}</span>
        ${f.motion ? `<span class="lightbox-motion">MOTION</span>` : ''}
        <button class="modal-close-btn" id="lb-close">✕</button>
      </div>
      <div class="lightbox-stage">
        <button class="lightbox-nav" id="lb-prev">‹</button>
        <div class="lightbox-img-wrap">
          <img class="lightbox-img" src="${f.dataUrl}" alt="frame" />
          ${motionBoxHTML(f)}
        </div>
        <button class="lightbox-nav" id="lb-next">›</button>
      </div>
      <div class="lightbox-meta">${new Date(f.timestamp).toLocaleString()} · ${(f.size / 1024).toFixed(0)} KB</div>
    </div>`;
  $('lb-close').addEventListener('click', closeLightbox);
  $('lb-prev').addEventListener('click', () => step(-1));
  $('lb-next').addEventListener('click', () => step(1));
}
function step(n) {
  gallery.lightbox = (gallery.lightbox + n + gallery.frames.length) % gallery.frames.length;
  renderLightbox();
}
function lightboxKeys(e) {
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
}
function closeLightbox() {
  document.removeEventListener('keydown', lightboxKeys);
  $('lightbox')?.remove();
}

// ═══════════════════════════════════════════════════════════════════════════
//  FIND PASSWORD (own camera) — reused from the original scanner
// ═══════════════════════════════════════════════════════════════════════════

function openFindPassword() {
  const ip = $('m-ip')?.value.trim();
  if (!ip) { showMsg('Enter the camera IP first.', true); return; }
  const user = $('m-username')?.value.trim() || 'admin';
  modal(`
    <div class="fp-modal">
      <div class="modal-header"><h2 class="modal-title">🔑 Find password — ${esc(ip)}</h2>
        <button class="modal-close-btn" id="fp-close">✕ Close</button></div>
      <p class="fp-note">Tests candidate passwords against the camera's HTTP API — for recovering access to
        <strong>your own</strong> camera. <span class="fp-warn">⚠ Hikvision locks the account after a few wrong
        tries (~30 min). Put your most-likely passwords first.</span></p>
      <div class="fp-row">
        <label>Username<input id="fp-user" value="${esc(user)}" /></label>
        <label>Delay (ms)<input id="fp-delay" type="number" value="1500" min="300" step="100" /></label>
        <label>Max tries<input id="fp-max" type="number" value="8" min="1" max="100" /></label>
      </div>
      <label class="fp-list-label">Your likely passwords (one per line)
        <textarea id="fp-list" rows="6" placeholder="MyCamPass1&#10;Office2023"></textarea></label>
      <div class="find-progress"><div id="fp-bar" class="progress"></div></div>
      <div class="muted" id="fp-status">Idle</div>
      <div class="fp-result" id="fp-result" hidden></div>
      <div class="modal-actions">
        <button class="btn-primary" id="fp-start">Start</button>
        <button class="btn-secondary" id="fp-cancel" disabled>Cancel</button>
      </div>
    </div>
  `, () => api.cancelFindPassword());
  $('fp-close').addEventListener('click', closeModal);
  $('fp-start').addEventListener('click', () => runFindPassword(ip));
  $('fp-cancel').addEventListener('click', async () => { await api.cancelFindPassword(); $('fp-status').textContent = 'Cancelling…'; });
}

const offCred = api.onCredProgress((p) => {
  const bar = $('fp-bar'); const status = $('fp-status');
  if (!bar || !status) return;
  bar.style.width = Math.round((p.index / p.total) * 100) + '%';
  const label = p.status === 'success' ? '✓ match!' : p.status === 'locked' ? '⛔ locked' : p.status === 'neterr' ? 'network error' : 'no';
  status.textContent = `Trying ${p.index}/${p.total}: “${p.password}” — ${label}`;
});

async function runFindPassword(ip) {
  const candidates = $('fp-list').value.split('\n').map((s) => s.trim()).filter(Boolean);
  $('fp-start').disabled = true; $('fp-cancel').disabled = false;
  $('fp-result').hidden = true; $('fp-status').textContent = 'Starting…';
  const res = await api.findPassword({
    ip, port: 80, username: $('fp-user').value.trim() || 'admin', candidates,
    delayMs: Number($('fp-delay').value) || 1500, maxAttempts: Number($('fp-max').value) || 8,
  });
  $('fp-start').disabled = false; $('fp-cancel').disabled = true;
  const result = $('fp-result'); result.hidden = false;
  if (res.ok) {
    result.className = 'fp-result ok';
    result.textContent = `✓ Password found: “${res.password}”. Filled into the form.`;
    if ($('m-username')) $('m-username').value = $('fp-user').value.trim() || 'admin';
    if ($('m-password')) $('m-password').value = res.password;
    $('fp-bar').style.width = '100%';
  } else {
    result.className = 'fp-result fail';
    result.textContent = '✗ ' + (res.error || 'Not found.') + (res.cancelled ? '' : ' Add more likely passwords and retry.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  PLAYER MANAGEMENT (jsmpeg)
// ═══════════════════════════════════════════════════════════════════════════

function startPlayer(key, wsPort, canvas, onFirstFrame) {
  try {
    let fired = false;
    const player = new JSMpeg.Player(`ws://127.0.0.1:${wsPort}`, {
      canvas,
      audio: false,
      disableGl: true, // 2D canvas so toDataURL / getImageData work for capture
      pauseWhenHidden: false,
      videoBufferSize: 4 * 1024 * 1024,
      onVideoDecode: () => { if (!fired && onFirstFrame) { fired = true; onFirstFrame(); } },
    });
    players.set(key, player);
  } catch (e) {
    const err = $('lv-error'); if (err) { err.hidden = false; err.textContent = 'Player error: ' + e.message; }
  }
}
function stopPlayer(key) {
  const p = players.get(key);
  if (p) { try { p.destroy(); } catch (_) {} players.delete(key); }
  api.stopStream(key).catch(() => {});
}

// ── "Live All" grid preview ─────────────────────────────────────────────────
// Streams every camera's feed straight into its dashboard card thumbnail.
const THUMB_PREFIX = 'thumb:';
const thumbKey = (id) => THUMB_PREFIX + id;

function setLiveAll(on) {
  state.liveAll = on;
  const btn = $('liveAllToggle');
  if (btn) { btn.classList.toggle('on', on); btn.setAttribute('aria-checked', on ? 'true' : 'false'); }
  applyLiveAll();
}

// Re-sync running thumbnail players with the current toggle + card set.
// Called after every dashboard render because each render makes fresh canvases.
function applyLiveAll() {
  if (state.wizardStep !== 'dashboard') return;
  // Drop players whose camera was removed.
  const liveIds = new Set(state.cameras.map((c) => c.id));
  [...players.keys()]
    .filter((k) => k.startsWith(THUMB_PREFIX) && !liveIds.has(k.slice(THUMB_PREFIX.length)))
    .forEach(stopPlayer);

  if (state.liveAll) state.cameras.forEach((c) => startThumb(c));
  else stopAllThumbs();
}

function setThumbLabel(card, text) {
  const label = card.querySelector('.thumb-stream-label');
  if (label) label.textContent = text;
}

async function startThumb(cam) {
  const card = document.querySelector(`.camera-card[data-id="${cam.id}"]`);
  if (!card) return;
  const canvas = card.querySelector('.camera-feed');
  const placeholder = card.querySelector('.thumb-placeholder');
  if (!canvas) return;
  const key = thumbKey(cam.id);

  stopPlayer(key); // fresh canvas each render → tear down any old player first
  setThumbLabel(card, 'Connecting…');
  if (placeholder) placeholder.style.display = '';
  canvas.hidden = true;

  const res = await api.startStream({ key, cameraId: cam.id });
  // The user may have toggled off or navigated away while we awaited.
  if (!state.liveAll || state.wizardStep !== 'dashboard') { stopPlayer(key); return; }
  if (!res.ok) { setThumbLabel(card, 'Stream unavailable'); return; }

  canvas.hidden = false;
  startPlayer(key, res.wsPort, canvas, () => {
    if (placeholder) placeholder.style.display = 'none';
  });
}

function stopAllThumbs() {
  [...players.keys()].filter((k) => k.startsWith(THUMB_PREFIX)).forEach(stopPlayer);
  document.querySelectorAll('.camera-card').forEach((card) => {
    const canvas = card.querySelector('.camera-feed');
    const placeholder = card.querySelector('.thumb-placeholder');
    if (canvas) canvas.hidden = true;
    if (placeholder) placeholder.style.display = '';
    setThumbLabel(card, 'Open live view');
  });
}

api.onStreamError((payload) => {
  const { key, message } = payload || {};
  if (key === live.key) {
    const e = $('lv-error'); if (e) { e.hidden = false; e.textContent = message; }
    const o = $('lv-overlay'); if (o) o.style.display = 'none';
  } else if (key === TEST_KEY) {
    const e = $('ts-error'); if (e) { e.hidden = false; e.textContent = message; }
    const o = $('ts-overlay'); if (o) o.style.display = 'none';
  } else if (streamProbes.has(key)) {
    streamProbes.get(key).onError(message);
  } else if (key && key.startsWith(THUMB_PREFIX)) {
    const id = key.slice(THUMB_PREFIX.length);
    const card = document.querySelector(`.camera-card[data-id="${id}"]`);
    if (card) {
      const canvas = card.querySelector('.camera-feed');
      const placeholder = card.querySelector('.thumb-placeholder');
      if (canvas) canvas.hidden = true;
      if (placeholder) placeholder.style.display = '';
      setThumbLabel(card, 'Stream unavailable');
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  MODAL + TOAST + AUTO-LOCK
// ═══════════════════════════════════════════════════════════════════════════

let modalOnClose = null;
function modal(html, onClose) {
  modalOnClose = onClose || null;
  const root = $('modalRoot');
  root.innerHTML = `<div class="modal-overlay" id="modalOverlay"><div class="modal-content">${html}</div></div>`;
  $('modalOverlay').addEventListener('click', (e) => { if (e.target === $('modalOverlay')) closeModal(); });
}
function closeModal() {
  if (modalOnClose) { try { modalOnClose(); } catch (_) {} }
  modalOnClose = null;
  $('modalRoot').innerHTML = '';
}

function toast(text, tone = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + tone;
  t.innerHTML = `<span class="toast-dot"></span><span class="toast-text">${esc(text)}</span>`;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 2600);
}

let autoLockTimer = null;
function setupAutoLock() {
  if (autoLockTimer) clearTimeout(autoLockTimer);
  const mins = state.autoLockMinutes;
  if (!mins || mins <= 0) return;
  const reset = () => { clearTimeout(autoLockTimer); autoLockTimer = setTimeout(lockNow, mins * 60000); };
  ['mousemove', 'keydown', 'mousedown', 'wheel'].forEach((e) => window.addEventListener(e, reset, { passive: true }));
  reset();
}
function lockNow() {
  live.active = false;
  stopCaptureLoop();
  stopAllCapture();
  players.forEach((_, k) => stopPlayer(k));
  closeModal();
  showLock();
}

// ── Go ─────────────────────────────────────────────────────────────────────
boot();
})();
