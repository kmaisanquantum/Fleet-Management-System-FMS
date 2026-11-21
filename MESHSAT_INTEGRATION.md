# MeshSat Telemetry Integration Guide

This document outlines the architecture, configuration, and deployment procedures for connecting the **MeshSat** gateway (Meshtastic / satellite / cellular node gateway at `meshsat.dspng.space`) to the **Fleet Management System (FMS)** at `https://fleet.dspng.tech` for live vehicle tracking on the Live Fleet Map.

---

## 1. Architecture Overview

```
┌──────────────────────────────────────┐
│        MeshSat Gateway Node          │
│         (meshsat.dspng.space)        │
│  Meshtastic / Satellite / Cellular   │
└──────────────────┬───────────────────┘
                   │ Webhook HTTP POST (HTTPS)
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
* **Config**: Set `TELEMETRY_API_KEY` in the deployment `.env` (see root `.env.example`). The same value is passed to the `api` container and used by the relay as `FMS_API_KEY`.
* **Generate a strong key** (do not keep the development placeholder `dev-telemetry-key-12345`):

  ```bash
  openssl rand -hex 32
  ```

  Put the result in `.env` as `TELEMETRY_API_KEY=...` before running `docker compose up`.

---

## 3. Device Registration & Binding (required)

Before telemetry for a MeshSat node is mapped to a vehicle, the MeshSat Node ID or MAC address (e.g. `!12345678` or `00:11:22:33:44:55`) **must** be registered and linked to a `vehicle_id`. Telemetry for an unregistered node is rejected by the ingest API (`Unknown device or missing vehicle binding`) and will never appear on the Live Fleet Map.

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

The `services/meshsat-relay` microservice runs alongside the FMS stack, receives raw Meshtastic/MeshSat webhook payloads, normalizes fields, and forwards telemetry to FMS. It is part of the root `docker-compose.yml` as the `meshsat-relay` service (defined in `services/meshsat-relay`).

### Deployment Steps

1. **Configure the deployment `.env`** (root of the repo):
   ```env
   # Shared with the api service (x-api-key) and the relay (FMS_API_KEY)
   TELEMETRY_API_KEY=<openssl rand -hex 32 output>
   ```

2. **Run with Docker Compose** (from the repository root, so the relay joins the same network as `api`):
   ```bash
   docker compose up -d --build meshsat-relay
   ```
   The compose service is:
   ```yaml
   meshsat-relay:
     build:
       context: ./services/meshsat-relay
       dockerfile: Dockerfile
     container_name: nac-meshsat-relay
     restart: unless-stopped
     ports:
       - "6055:6055"
     environment:
       PORT: 6055
       FMS_URL: http://api:4000
       FMS_API_KEY: ${TELEMETRY_API_KEY}
     depends_on:
       - api
   ```
   `FMS_URL` points at the internal `api` service, so telemetry never leaves the Docker network on the way to ingest.

   > To run the relay standalone instead, copy `services/meshsat-relay/.env.example` to `.env`, set `FMS_URL` to the FMS base URL, and `docker compose up -d --build` from within `services/meshsat-relay`.

3. **Expose a stable HTTPS webhook target (recommended)**:
   The web front-end nginx config (`apps/web/infra.nginx.conf`) proxies a dedicated path to the relay, so the gateway posts over TLS to the FMS domain:
   ```nginx
   location /meshsat-relay/ {
     proxy_pass http://meshsat-relay:6055/;
     proxy_set_header Host $host;
     proxy_set_header X-Real-IP $remote_addr;
   }
   ```
   The MeshSat webhook URL therefore becomes:
   ```
   https://fleet.dspng.tech/meshsat-relay/webhook
   ```
   (Trailing-slash proxy strips the `/meshsat-relay` prefix, so `/meshsat-relay/webhook` → `http://meshsat-relay:6055/webhook`.)
   Alternatively you may expose port `6055` directly — the nginx route is preferred because it terminates TLS and keeps a single public entry point.

4. **Configure the MeshSat webhook target**:
   In the MeshSat gateway settings (`meshsat.dspng.space`), set the Webhook URL target to `https://fleet.dspng.tech/meshsat-relay/webhook`.

---

## 5. Verification Commands

### Test 1: Direct Telemetry Ingest to FMS API

```bash
curl -X POST https://fleet.dspng.tech/api/v1/gps/positions \
  -H "x-api-key: <TELEMETRY_API_KEY>" \
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
# Via the nginx HTTPS route (production)
curl -X POST https://fleet.dspng.tech/meshsat-relay/webhook \
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

# Or directly against the relay container/port (local)
curl -X POST http://localhost:6055/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "fromId": "!12345678",
    "payload": { "latitude": -9.4182, "longitude": 147.1872, "speed": 55.0, "heading": 90.0 }
  }'
```

### Test 3: Confirm Ingest + Live Map

Upon sending test packets, verify that a `gps_positions` row is created and the corresponding vehicle moves live on the **Live Fleet Map** (`https://fleet.dspng.tech/live-map`).

---

## 6. Live Fleet Map MeshSat Integration

The Live Fleet Map page (`apps/web/src/pages/LiveFleetMap.tsx`) now renders only the native FMS Telematics map (Leaflet), showing vehicles at their live GPS positions. The previous view switcher tab ("FMS Telematics Map" / "MeshSat Mesh Map") and its embedded `VITE_MESHSAT_MAP_URL` iframe have been **removed** — the cross-origin MeshSat map could not be embedded reliably due to browser auth/framing restrictions.

MeshSat data still flows into the FMS map: GPS packets posted by the MeshSat gateway to the telemetry relay in `services/meshsat-relay` are ingested and surfaced as live vehicle markers on this page. Embedding the MeshSat `/map` UI directly in the dashboard is no longer required, so the reverse-proxy / iframe-framing setup described in earlier revisions of this document is obsolete.

### Default Map Center & Zoom Configuration

Because the FMS fleet operates in Papua New Guinea (PNG / National Capital District / Port Moresby, approx `lat: -9.4438`, `lon: 147.1803`), the Live Fleet Map defaults to those coordinates whenever no vehicle currently has a GPS fix.
