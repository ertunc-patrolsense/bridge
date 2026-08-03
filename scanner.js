// scanner.js — discover IP cameras on the local network.
//
// Two complementary techniques are used and merged by IP:
//   1. TCP port scan of the local /24 subnet for common camera ports
//      (554 RTSP, 80 HTTP, 8000 Hikvision SDK, 443 HTTPS, 2020).
//   2. ONVIF WS-Discovery (UDP multicast) which most modern IP cameras
//      — including Hikvision — answer with their device service address.
//
// For hosts that look like cameras we additionally fingerprint the HTTP
// service to guess the vendor (Hikvision returns "App-webs" / "DVRDVS"
// style Server headers).

const os = require('os');
const net = require('net');
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');

const CAMERA_PORTS = [554, 80, 8000, 443, 2020];

// ---------------------------------------------------------------------------
// Subnet helpers
// ---------------------------------------------------------------------------

function getLocalSubnet() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return { address: iface.address, netmask: iface.netmask, iface: name };
      }
    }
  }
  return null;
}

const ipToInt = (ip) => ip.split('.').reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0);
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

function hostsInSubnet(address, netmask) {
  const ip = ipToInt(address);
  const mask = ipToInt(netmask);
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const hosts = [];
  // Cap the scan to ~1022 hosts (a /22) so we never iterate a huge range.
  const maxHosts = 1022;
  for (let i = network + 1; i < broadcast && hosts.length < maxHosts; i++) {
    hosts.push(intToIp(i));
  }
  return hosts;
}

// ---------------------------------------------------------------------------
// TCP connect scan
// ---------------------------------------------------------------------------

function checkPort(ip, port, timeout = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, ip);
  });
}

function guessVendor(server, auth) {
  const s = `${server} ${auth}`.toLowerCase();
  if (/hikvision|app-webs|dvrdvs|webs|isapi/.test(s)) return 'Hikvision (likely)';
  if (/dahua/.test(s)) return 'Dahua';
  if (/axis/.test(s)) return 'Axis';
  if (/server: gsoap|onvif/.test(s)) return 'ONVIF device';
  return 'Unknown';
}

// Read the HTTP Server / WWW-Authenticate headers (camera usually answers 401).
function fingerprint(ip) {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port: 80, path: '/', timeout: 1500 }, (res) => {
      const server = res.headers['server'] || '';
      const auth = res.headers['www-authenticate'] || '';
      res.destroy();
      resolve({ server, vendor: guessVendor(server, auth) });
    });
    req.on('error', () => resolve({ server: '', vendor: 'Unknown' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ server: '', vendor: 'Unknown' });
    });
  });
}

async function portScan(onProgress) {
  const subnet = getLocalSubnet();
  if (!subnet) throw new Error('No active IPv4 network interface found.');
  const hosts = hostsInSubnet(subnet.address, subnet.netmask);
  const found = new Map();
  const queue = [...hosts];
  let scanned = 0;
  const concurrency = 48;

  async function worker() {
    while (queue.length) {
      const ip = queue.shift();
      const openPorts = [];
      for (const p of CAMERA_PORTS) {
        if (await checkPort(ip, p)) openPorts.push(p);
      }
      scanned++;
      if (onProgress) onProgress({ scanned, total: hosts.length });
      if (openPorts.includes(554) || openPorts.includes(8000)) {
        const fp = openPorts.includes(80)
          ? await fingerprint(ip)
          : { server: '', vendor: 'Unknown' };
        const device = { ip, ports: openPorts, ...fp, onvif: false };
        found.set(ip, device);
        if (onProgress) onProgress({ device });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { subnet, devices: found };
}

// ---------------------------------------------------------------------------
// ONVIF WS-Discovery
// ---------------------------------------------------------------------------

function wsDiscover(timeout = 4000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();
    const id = crypto.randomUUID();
    const probe =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" ' +
      'xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ' +
      'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" ' +
      'xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
      `<e:Header><w:MessageID>uuid:${id}</w:MessageID>` +
      '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>' +
      '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>' +
      '</e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe>' +
      '</e:Body></e:Envelope>';

    sock.on('message', (msg, rinfo) => {
      const text = msg.toString();
      const m = text.match(/XAddrs>\s*([^<]+)</i);
      const xaddr = m ? m[1].trim().split(/\s+/)[0] : '';
      const scopes = (text.match(/Scopes>([^<]*)</i) || [])[1] || '';
      let vendor = 'ONVIF device';
      const hw = scopes.match(/hardware\/([^\s]+)/i);
      const nameMatch = scopes.match(/name\/([^\s]+)/i);
      if (/hikvision/i.test(scopes)) vendor = 'Hikvision (ONVIF)';
      found.set(rinfo.address, {
        ip: rinfo.address,
        xaddr,
        onvif: true,
        vendor,
        model: hw ? decodeURIComponent(hw[1]) : nameMatch ? decodeURIComponent(nameMatch[1]) : '',
      });
    });

    sock.on('error', () => {
      try { sock.close(); } catch (_) {}
      resolve([...found.values()]);
    });

    sock.bind(() => {
      try {
        sock.setBroadcast(true);
        sock.setMulticastTTL(2);
      } catch (_) {}
      sock.send(probe, 3702, '239.255.255.250', () => {});
    });

    setTimeout(() => {
      try { sock.close(); } catch (_) {}
      resolve([...found.values()]);
    }, timeout);
  });
}

// ---------------------------------------------------------------------------
// Combined scan
// ---------------------------------------------------------------------------

async function scanNetwork(onProgress) {
  // Run ONVIF discovery and the port scan together.
  const onvifPromise = wsDiscover().catch(() => []);
  const { subnet, devices } = await portScan(onProgress);
  const onvifResults = await onvifPromise;

  // Merge ONVIF info into the port-scan results (or add new entries).
  for (const o of onvifResults) {
    const existing = devices.get(o.ip);
    if (existing) {
      existing.onvif = true;
      existing.xaddr = o.xaddr;
      existing.model = o.model || existing.model;
      if (o.vendor && o.vendor !== 'ONVIF device') existing.vendor = o.vendor;
    } else {
      devices.set(o.ip, { ip: o.ip, ports: [], server: '', ...o });
    }
    if (onProgress) onProgress({ device: devices.get(o.ip) });
  }

  return { subnet, devices: [...devices.values()] };
}

module.exports = { scanNetwork, getLocalSubnet, fingerprint };
