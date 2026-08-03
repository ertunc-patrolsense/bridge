// passfinder.js — recover access to YOUR OWN Hikvision camera by testing a
// list of candidate passwords against its ISAPI endpoint (HTTP digest auth).
//
// This is a dictionary / known-candidate check, NOT an unbounded brute-forcer:
// Hikvision locks the account after a handful of wrong attempts, so the only
// thing that actually works is a short, ordered list of your likely passwords.
// We throttle between attempts and warn as the lockout threshold approaches.

const http = require('http');
const crypto = require('crypto');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const CHECK_PATH = '/ISAPI/Security/userCheck';

// Common Hikvision / generic default passwords, tried after the user's own
// candidates. Most-likely first.
const COMMON = [
  'Admin123', 'admin123', 'Admin@123', 'admin12345', 'Admin12345', '12345',
  '123456', '1234567890', 'admin', 'Admin1234', 'Admin@1234', 'password',
  'Password1', 'P@ssw0rd', 'hikvision', 'Hik12345', 'Admin@12345', 'abcd1234',
  'Admin123456', 'admin@123', 'Aa123456', 'Aa12345678', '88888888', '12345678',
];

let cancelled = false;
function cancel() { cancelled = true; }

function request(ip, port, path, headers, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: ip, port, path, method: 'GET', headers, timeout }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function parseDigest(header) {
  const out = {};
  const s = header.replace(/^Digest\s+/i, '');
  const re = /(\w+)=(?:"([^"]*)"|([^,]+))/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

function buildAuthHeader({ username, password, realm, nonce, qop, opaque, uri, nc, cnonce }) {
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`GET:${uri}`);
  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", algorithm=MD5`;
  if (qop) {
    const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
  } else {
    const response = md5(`${ha1}:${nonce}:${ha2}`);
    header += `, response="${response}"`;
  }
  if (opaque) header += `, opaque="${opaque}"`;
  return header;
}

// Returns the digest challenge params, or throws if the host doesn't speak it.
async function getChallenge(ip, port) {
  const res = await request(ip, port, CHECK_PATH, {});
  if (res.status === 200) return { open: true }; // no auth required
  const wa = res.headers['www-authenticate'];
  if (!wa || !/digest/i.test(wa)) throw new Error('Camera did not present HTTP digest auth on ISAPI.');
  return parseDigest(wa);
}

// Test a single password against an existing challenge.
async function testPassword(ip, port, username, password, ch, nc) {
  const cnonce = crypto.randomBytes(8).toString('hex');
  const auth = buildAuthHeader({
    username, password,
    realm: ch.realm, nonce: ch.nonce, qop: ch.qop, opaque: ch.opaque,
    uri: CHECK_PATH, nc, cnonce,
  });
  const res = await request(ip, port, CHECK_PATH, { Authorization: auth });
  return res; // 200 = success, 401 = wrong (or stale), other = inspect
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Main entry. onProgress({ index, total, password, status }) for each attempt.
async function find(ip, port, username, candidates, { onProgress, delayMs = 1500, maxAttempts = 8 } = {}) {
  cancelled = false;
  const seen = new Set();
  const list = [];
  for (const p of [...candidates, ...COMMON]) {
    if (p == null) continue;
    const v = String(p);
    if (!seen.has(v)) { seen.add(v); list.push(v); }
  }
  const total = Math.min(list.length, maxAttempts);

  let ch;
  try {
    ch = await getChallenge(ip, port);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (ch.open) return { ok: true, password: '', note: 'Camera ISAPI requires no password.' };

  let nc = 0;
  for (let i = 0; i < total; i++) {
    if (cancelled) return { ok: false, cancelled: true, attempts: i };
    const password = list[i];
    nc++;
    const ncHex = nc.toString(16).padStart(8, '0');

    let res;
    try {
      res = await testPassword(ip, port, username, password, ch, ncHex);
    } catch (err) {
      if (onProgress) onProgress({ index: i + 1, total, password, status: 'neterr' });
      await delay(delayMs);
      continue;
    }

    // If the server says the nonce is stale, refresh the challenge and retry.
    if (res.status === 401 && /stale\s*=\s*"?true/i.test(res.headers['www-authenticate'] || '')) {
      try { ch = await getChallenge(ip, port); nc = 0; } catch (_) {}
    }

    if (res.status === 200) {
      if (onProgress) onProgress({ index: i + 1, total, password, status: 'success' });
      return { ok: true, password };
    }

    // Hikvision's userCheck returns an XML body. Read it to tell a genuine
    // lockout from an ordinary wrong password, and how many tries remain.
    const body = res.body || '';
    const remaining = (() => {
      const m = body.match(/<retryLoginTime>\s*(\d+)\s*</i);
      return m ? Number(m[1]) : null;
    })();
    const locked =
      res.status === 403 ||
      /<lockStatus>\s*lock\s*<\/lockStatus>/i.test(body) ||
      /<unlockTime>\s*[1-9]\d*\s*</i.test(body) ||
      /maximum.*(attempts|login).*exceed|exceeded the (max|limit)|too many/i.test(body);

    if (onProgress) {
      onProgress({ index: i + 1, total, password, status: locked ? 'locked' : 'fail', remaining });
    }
    if (locked) {
      return { ok: false, locked: true, attempts: i + 1, error: 'Camera locked the account after repeated failures. Wait ~30 min, then try fewer, more-likely passwords.' };
    }

    await delay(delayMs);
  }

  return { ok: false, attempts: total, error: 'No candidate password matched.' };
}

module.exports = { find, cancel, COMMON };
