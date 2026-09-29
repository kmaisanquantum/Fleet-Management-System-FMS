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

## 6. Live Fleet Map Embedded MeshSat View

The Live Fleet Map page (`apps/web/src/pages/LiveFleetMap.tsx`) includes a view switcher tab ("FMS Telematics Map" / "MeshSat Mesh Map") allowing users to view the live MeshSat node map iframe directly in the FMS dashboard.

### HTTPS Reverse Proxy Requirement (Mixed Content)

Because `fleet.dspng.tech` is served over **HTTPS**, direct iframe embedding of an HTTP URL (`http://45.76.122.53:6050`) will be blocked by browsers due to mixed-content security rules.

To expose MeshSat securely for embedded viewing:
1. Setup a reverse proxy on the MeshSat VPS (e.g. Caddy or Nginx) with a TLS certificate for `https://mesh.dspng.tech` pointing to `localhost:6050`.
2. Ensure MeshSat response headers do not restrict framing (`X-Frame-Options: ALLOW-FROM https://fleet.dspng.tech` or omitting `X-Frame-Options: DENY`, and relaxing `Content-Security-Policy frame-ancestors`).
3. Set the Vite build environment variable during deployment:
   ```env
   VITE_MESHSAT_MAP_URL=https://mesh.dspng.tech/map
   ```
