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

## How streaming works

RTSP can’t play directly in Chromium. The bridge spawns **ffmpeg**
(`ffmpeg-static`) to transcode each RTSP feed to MPEG1 over a local WebSocket,
which **JSMpeg** renders onto a `<canvas>`. Those same feeds feed the capture
pipeline that sends frames to the server.

## Run

```bash
cd ipcam-scanner
npm install      # downloads electron + ffmpeg binary
npm start
```

## Using it

1. Complete onboarding (organization, PIN).
2. Add cameras via **Auto Scan** or **Manual Entry**.
3. Open a feed, tune motion / auto-capture, and let the bridge keep streams
   alive and push frames to PatrolSense.

### Hikvision RTSP URLs

Built automatically; for reference:

```
Main stream:  rtsp://user:pass@IP:554/Streaming/Channels/101
Sub  stream:  rtsp://user:pass@IP:554/Streaming/Channels/102
```

Channel `N` → `N01` (main) / `N02` (sub). For an NVR, use the camera’s channel
number. Use an RTSP URL override for non-standard paths.

## Notes / troubleshooting

- **401 / Unauthorized** → wrong username or password.
- **Connection refused / timed out** → camera not reachable, wrong IP, or RTSP
  disabled on the camera (enable it under *Network → Advanced → Integration
  Protocol / RTSP*).
- The scan only covers your own subnet. Scanning networks you don’t own or
  have permission to test may be against the law — use responsibly.
- ONVIF discovery uses UDP multicast; some Wi-Fi networks block it. The port
  scan still finds cameras in that case.
