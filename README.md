# PatrolSense Bridge

Desktop bridge for **PatrolSense**. Discovers CCTV / IP cameras on the local
network, pulls their live streams, and sends frames and footage onward to the
PatrolSense server.

## What it does

- **Discover cameras** — scans your local subnet for CCTV devices (Hikvision /
  ONVIF) via TCP port scan and ONVIF WS-Discovery.
- **Ingest streams** — connects to each camera’s RTSP feed, transcodes with
  bundled ffmpeg, and plays it locally for monitoring.
- **Bridge to server** — captures frames (interval or motion-triggered) and
  forwards them to the PatrolSense server so the cloud side can monitor and
  analyze the site.
- **Secure locally** — PIN lock, encrypted credentials (OS keychain), and an
  organization profile set up during onboarding.

## Prerequisites

- **Node.js** 18+ (LTS recommended)
- **npm** 9+
- macOS, Windows, or Linux (Electron)
- Cameras on the same LAN, with RTSP enabled
- Network permission to scan your own subnet

No system ffmpeg install is required — `ffmpeg-static` ships a binary with
`npm install`.

## Setup

```bash
# 1. Clone / enter the project
cd ipcam-scanner

# 2. Install dependencies (Electron + ffmpeg binary + ws)
npm install

# 3. Start the desktop app
npm start
```

That’s it. `npm start` runs `electron .`, which boots `main.js`.

### First-run flow

1. Complete onboarding (use case, organization, PIN + recovery code).
2. Add cameras via **Auto Scan** or **Manual Entry**.
3. Open a feed, tune motion / auto-capture settings.
4. Leave the bridge running so streams stay alive and frames go to PatrolSense.

### Scripts

| Command       | What it does                          |
|---------------|----------------------------------------|
| `npm install` | Install deps + download ffmpeg binary |
| `npm start`   | Launch the Electron app               |

## Project structure

```
ipcam-scanner/
├── main.js              # Electron main process — window + IPC handlers
├── preload.js           # contextBridge API exposed as window.api
├── scanner.js           # LAN discovery (TCP ports + ONVIF WS-Discovery)
├── stream.js            # RTSP → ffmpeg → WebSocket (MPEG1) bridge
├── store.js             # Saved cameras (passwords encrypted via safeStorage)
├── frames.js            # Captured frame storage under userData/captures
├── security.js          # PIN lock + recovery code (scrypt hashes)
├── org.js               # Organization / onboarding profile
├── passfinder.js        # Optional Hikvision password probe (own cameras)
├── package.json
└── renderer/
    ├── index.html       # App shell
    ├── styles.css       # UI styles
    ├── renderer.js      # UI, live view, capture loops, onboarding
    ├── motion.js        # Motion detection engine (canvas samples)
    ├── jsmpeg.min.js    # MPEG1 player over WebSocket
    └── patrol-LOGO.png
```

## How the code fits together

```
┌─────────────┐     IPC (preload)      ┌──────────────────┐
│  renderer/  │ ←──────────────────→   │     main.js      │
│  UI + canvas│    window.api.*        │  IPC orchestration│
└──────┬──────┘                        └────────┬─────────┘
       │                                        │
       │ JSMpeg ← ws://localhost:91xx           ├── scanner.js
       │                                        ├── stream.js ── ffmpeg
       │                                        ├── store.js
       │ motion.js → saveFrame                  ├── frames.js
       └────────────────────────────────────────├── security.js / org.js
                                                └── passfinder.js
```

1. **Main process** (`main.js`) owns privileged work: network scan, RTSP
   bridging, disk I/O, and encryption. It registers `ipcMain` handlers.
2. **Preload** (`preload.js`) exposes a narrow `window.api` surface to the
   renderer (no Node in the page — `contextIsolation` is on).
3. **Renderer** builds the UI, starts/stops streams by key, runs motion
   detection, and saves frames through `api.saveFrame(...)`.
4. **Stream path** — for each camera key, `stream.js` spawns ffmpeg, which
   reads RTSP and pushes MPEG1 over a local WebSocket (ports from `9100`).
   The renderer’s JSMpeg player consumes that socket and paints a canvas.

### Key modules

| File | Role |
|------|------|
| `scanner.js` | Probes ports `554`, `80`, `8000`, `443`, `2020` on the `/24` subnet and merges ONVIF multicast replies. |
| `stream.js` | Up to 64 concurrent keyed streams; each gets its own ffmpeg + WS port. |
| `store.js` | Persists cameras to `userData/cameras.json`; passwords stay encrypted and are never sent back to the renderer in plaintext. |
| `frames.js` | Writes JPEGs + `index.json` under `userData/captures/<cameraId>/`. |
| `security.js` | PIN / recovery hashes in `userData/security.json`. |
| `org.js` | Workspace profile in `userData/organization.json`. |
| `motion.js` | Adaptive background + blob gates for motion-triggered capture. |

### Data on disk

Electron `userData` (platform-specific) holds:

- `cameras.json` — saved camera configs
- `organization.json` — onboarding profile
- `security.json` — PIN / recovery hashes
- `captures/` — per-camera frame JPEGs and indexes

### Hikvision RTSP URLs

Built automatically in `main.js` (`buildHikvisionUrl`); for reference:

```
Main stream:  rtsp://user:pass@IP:554/Streaming/Channels/101
Sub  stream:  rtsp://user:pass@IP:554/Streaming/Channels/102
```

Channel `N` → `N01` (main) / `N02` (sub). For an NVR, use the camera’s channel
number. Pass a custom `rtspUrl` on the camera record for non-standard paths.

## Dependencies

| Package | Why |
|---------|-----|
| `electron` | Desktop shell (main + renderer) |
| `ffmpeg-static` | Bundled ffmpeg for RTSP → MPEG1 |
| `ws` | Local WebSocket servers for each live stream |

## Notes / troubleshooting

- **401 / Unauthorized** → wrong username or password.
- **Connection refused / timed out** → camera not reachable, wrong IP, or RTSP
  disabled on the camera (enable it under *Network → Advanced → Integration
  Protocol / RTSP*).
- The scan only covers your own subnet. Scanning networks you don’t own or
  have permission to test may be against the law — use responsibly.
- ONVIF discovery uses UDP multicast; some Wi-Fi networks block it. The port
  scan still finds cameras in that case.
- If streams fail to start, check that ports `9100+` are free locally and that
  `ffmpeg-static` installed for your platform (`node_modules/ffmpeg-static`).
