# MeshSat Telemetry Integration Guide

This document outlines the architecture, configuration, and deployment procedures for connecting the **MeshSat** gateway (Meshtastic / satellite / cellular node gateway at `http://45.76.122.53:6050`) to the **Fleet Management System (FMS)** at `https://fleet.dspng.tech` for live vehicle tracking on the Live Fleet Map.

---

## 1. Architecture Overview

```
┌──────────────────────────────────────┐
│        MeshSat Gateway Node          │
│     (http://45.76.122.53:6050)       │
│  Meshtastic / Satellite / Cellular   │
└──────────────────┬───────────────────┘
                   │ Webhook HTTP POST
                   ▼
┌──────────────────────────────────────┐
│        MeshSat Relay Service         │
│     (services/meshsat-relay:6055)    │
│  Normalizes Node ID / MAC / Lat / Lon│
└──────────────────┬───────────────────┘
                   │ HTTP POST (x-api-key: TELEMETRY_API_KEY)
                   ▼
┌──────────────────────────────────────┐
│         FMS Ingest API               │
│   (POST /api/v1/gps/positions)       │
│  Updates Vehicles Live-State Cache   │
└──────────────────┬───────────────────┘
                   │ WebSocket / REST Polling
                   ▼
┌──────────────────────────────────────┐
│           Live Fleet Map             │
│        (https://fleet.dspng.tech)    │
└──────────────────────────────────────┘
```

---

## 2. Ingest Authentication (`x-api-key`)

To support machine-to-machine telemetry ingest without requiring user JWT logins, FMS accepts the `x-api-key` header for `POST /api/v1/gps/positions`.

* **Header**: `x-api-key: <TELEMETRY_API_KEY>`
* **Config**: Set `TELEMETRY_API_KEY` in `apps/api/.env`.

---

## 3. Device Registration & Binding

Before telemetry for a MeshSat node is mapped to a vehicle, the MeshSat Node ID or MAC address (e.g. `!12345678` or `00:11:22:33:44:55`) must be registered and linked to a `vehicle_id`.

### Register/Link Device via FMS API

```bash
curl -X POST https://fleet.dspng.tech/api/v1/gps/devices \
  -H "Authorization: Bearer <ADMIN_JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceIdentifier": "!12345678",
    "vehicleId": "v-101-uuid-here",
    "status": "active"
  }'
```

---

## 4. MeshSat Webhook Relay Service Setup

The `services/meshsat-relay` microservice runs alongside the MeshSat node or VPS, receives raw Meshtastic/MeshSat webhook payloads, normalizes fields, and forwards telemetry to FMS.

### Deployment Steps

1. **Configure Environment (`.env`)**:
   ```env
   PORT=6055
   FMS_URL=https://fleet.dspng.tech
   FMS_API_KEY=dev-telemetry-key-12345
   ```

2. **Run with Docker Compose**:
   ```bash
   cd services/meshsat-relay
   docker compose up -d --build
   ```

3. **Configure MeshSat Webhook Target**:
   In MeshSat settings (`http://45.76.122.53:6050`), set the Webhook URL target to:
   ```
   http://localhost:6055/webhook
   ```

---

## 5. Verification Commands

### Test 1: Direct Telemetry Ingest to FMS API

```bash
curl -X POST https://fleet.dspng.tech/api/v1/gps/positions \
  -H "x-api-key: dev-telemetry-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceIdentifier": "!12345678",
    "lat": -9.4438,
    "lon": 147.1803,
    "speed": 45.0,
    "heading": 180,
    "ignition": 1,
    "altitude": 52.0,
    "battery": 92.0,
    "source": "meshsat"
  }'
```

### Test 2: Test Payload to MeshSat Relay Service

```bash
curl -X POST http://localhost:6055/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "fromId": "!12345678",
    "payload": {
      "latitude": -9.4182,
      "longitude": 147.1872,
      "altitude": 48.0,
      "batteryLevel": 85.0,
      "speed": 55.0,
      "heading": 90.0,
      "time": "2026-03-28T11:00:00Z"
    }
  }'
```

Upon sending test packets, verify that the corresponding vehicle moves live on the **Live Fleet Map** (`https://fleet.dspng.tech/live-map`).

---

## 6. Live Fleet Map Embedded MeshSat View — Removed

The Live Fleet Map page (`apps/web/src/pages/LiveFleetMap.tsx`, route `/live-map`)
previously offered a "MeshSat Mesh Map" tab that embedded the MeshSat web UI in an
`<iframe>` via `VITE_MESHSAT_MAP_URL`. **That tab has been removed**: `/live-map`
now renders only the FMS Telematics map (Leaflet) with no tab switcher, and
`VITE_MESHSAT_MAP_URL` is no longer defined.

Why it was removed: MeshSat requires authentication before it serves anything, so
a cross-site iframe cannot carry the login session:

* **Third-party cookie blocking** — any session cookie issued for
  `meshsat.dspng.space` is a **third-party cookie** inside a frame on
  `fleet.dspng.tech`, which browsers drop (Safari ITP, Firefox Total Cookie
  Protection, Chrome's phase-out; Incognito blocks them outright). `SameSite`
  cannot fix this in those browsers.
* **HTTP Basic auth** — the whole MeshSat host is currently gated by a Basic-auth
  challenge (`401` + `WWW-Authenticate: Basic realm="restricted"`). The browser
  caches those credentials **per origin**, so credentials entered for
  `meshsat.dspng.space` are not replayed for a frame requested from
  `fleet.dspng.tech`.

The net effect was a blank frame or a login prompt instead of the map, so the tab
was dropped rather than shipped broken.

> If the embedded view is ever reinstated, it must be served **same-origin** via a
> reverse proxy (`https://<fms-host>/meshsat/` → `https://meshsat.dspng.space/`)
> so the frame shares the FMS origin and the browser replays the cached
> credentials/cookies inside it, together with `proxy_hide_header X-Frame-Options`
> / `Content-Security-Policy` so framing is allowed. A direct
> `https://meshsat.dspng.space/map` iframe only works if MeshSat permits framing
> **and** the browser allows third-party cookies.

**Unaffected:** the MeshSat **telemetry** integration described in sections 1–5.
The `services/meshsat-relay` webhook relay still normalises Meshtastic/MeshSat
packets and forwards them to `POST /api/v1/gps/positions`, so MeshSat-tracked
vehicles continue to appear as live markers on the FMS Telematics map. Only the
embedded MeshSat *web view* was removed.
