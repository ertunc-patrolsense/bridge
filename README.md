# IP Camera Scanner (Electron)

Desktop app that scans your local network for IP cameras (Hikvision / ONVIF)
and plays their RTSP stream in a window.

## How it works

- **Discovery** — two techniques merged by IP:
  - TCP port scan of your `/24` subnet for camera ports (`554` RTSP, `80`,
    `8000` Hikvision SDK, `443`, `2020`).
  - ONVIF **WS-Discovery** (UDP multicast) — most cameras, including
    Hikvision, answer with their device address and model.
- **Streaming** — RTSP can't play directly in a browser/Chromium. The app
  spawns a bundled **ffmpeg** (`ffmpeg-static`) that transcodes the RTSP feed
  to MPEG1 over a local WebSocket, which **JSMpeg** renders onto a `<canvas>`.

## Run

```bash
cd ipcam-scanner
npm install      # downloads electron + ffmpeg binary
npm start
```

## Using it

1. Click **Scan network**. Found cameras appear on the left with badges
   (RTSP / ONVIF / Hikvision).
2. Click a camera — its IP fills the form. Enter the **username** and
   **password** (Hikvision default user is `admin`; password is whatever you
   set when activating the camera).
3. Click **Connect & play**.

### Saving cameras & grid view

- Fill the form (optionally set a **Name**) and click **Save**. The camera is
  stored under **Saved cameras** on the left. Passwords are encrypted at rest
  with the OS keychain (Electron `safeStorage`) and are never written in
  plaintext.
- Each saved camera has **▶** (play in single view) and **✕** (delete).
- Switch to the **Grid** tab (top right) and click **Play all** to view every
  saved camera at once — each tile is an independent RTSP→ffmpeg→WebSocket
  stream. **Stop all** tears them down.

### Hikvision RTSP URLs

The app builds these for you, but for reference:

```
Main stream:  rtsp://user:pass@IP:554/Streaming/Channels/101
Sub  stream:  rtsp://user:pass@IP:554/Streaming/Channels/102
```

Channel `N` → `N01` (main) / `N02` (sub). For an NVR, use the channel number
of the camera. Use **Advanced → Override RTSP URL** for non-standard paths.

## Notes / troubleshooting

- **401 / Unauthorized** → wrong username or password.
- **Connection refused / timed out** → camera not reachable, wrong IP, or RTSP
  disabled on the camera (enable it in the camera's web UI under
  *Network → Advanced → Integration Protocol / RTSP*).
- The scan only covers your own subnet. Scanning networks you don't own or
  have permission to test may be against the law — use responsibly.
- ONVIF discovery uses UDP multicast; some Wi-Fi networks block it. The port
  scan still finds cameras in that case.
