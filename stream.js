// stream.js — RTSP → MPEG-TS(MPEG1) → WebSocket bridge for JSMpeg.
//
// Supports MANY concurrent streams (for the grid view). Each stream is keyed
// by a caller-supplied id and gets its own ffmpeg process plus a dedicated
// WebSocket server on its own port. Modern `JSMpeg.Player(ws://...)` reads the
// raw MPEG-TS we broadcast.

const { spawn } = require('child_process');
const WebSocket = require('ws');
const ffmpegPath = require('ffmpeg-static');

const BASE_PORT = 9100;
const MAX_STREAMS = 64;

const streams = new Map(); // id -> { ffmpeg, wss, port }

function allocPort() {
  const used = new Set([...streams.values()].map((s) => s.port));
  for (let i = 0; i < MAX_STREAMS; i++) {
    const p = BASE_PORT + i;
    if (!used.has(p)) return p;
  }
  throw new Error('No free stream port available');
}

function stop(id) {
  const s = streams.get(id);
  if (!s) return;
  try { s.ffmpeg.kill('SIGKILL'); } catch (_) {}
  try { s.wss.close(); } catch (_) {}
  streams.delete(id);
}

function stopAll() {
  for (const id of [...streams.keys()]) stop(id);
}

// A line is ffmpeg progress (frame=.. fps=..), not an error. Benign HEVC/H.264
// decoder warnings emitted when joining mid-GOP are also ignored.
function looksLikeError(line) {
  if (/frame=|fps=|bitrate=|speed=|size=/.test(line)) return false;
  if (/\[(hevc|h264|mpeg|swscaler) @|POC|non-existing|decode_slice|co located|find ref/i.test(line)) return false;
  return /401 Unauthorized|Server returned \d|Connection refused|Could not open|Could not connect|Could not resolve|Invalid data found in stream|No route to host|Connection timed out|Connection to .* timed out|Name or service not known|method (DESCRIBE|OPTIONS|SETUP) failed|Immediate exit|403 Forbidden|404 Not Found|Protocol not found|Operation not permitted/i.test(line);
}

function start(id, rtspUrl, { onError } = {}) {
  stop(id);
  const port = allocPort();

  const wss = new WebSocket.Server({ port });
  wss.broadcast = (data) => {
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  };

  const ffmpeg = spawn(ffmpegPath, [
    '-rtsp_transport', 'tcp',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-i', rtspUrl,
    '-f', 'mpegts',
    '-codec:v', 'mpeg1video',
    '-b:v', '1500k',
    '-bf', '0',
    '-r', '25',
    '-an',
    '-',
  ]);

  let firstData = false;
  ffmpeg.stdout.on('data', (chunk) => {
    firstData = true;
    wss.broadcast(chunk);
  });

  ffmpeg.stderr.on('data', (buf) => {
    const line = buf.toString();
    if (looksLikeError(line) && onError) onError(line.trim());
  });

  ffmpeg.on('close', (code) => {
    if (code && code !== 255 && !firstData && onError) {
      onError(`ffmpeg exited (code ${code}) before any video — check IP, credentials and that RTSP is enabled on the camera.`);
    }
  });

  ffmpeg.on('error', (err) => {
    if (onError) onError('Failed to launch ffmpeg: ' + err.message);
  });

  streams.set(id, { ffmpeg, wss, port });
  return port;
}

module.exports = { start, stop, stopAll };
