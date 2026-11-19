# MeshSat Telemetry Integration Guide

This document outlines the architecture, configuration, and deployment procedures for connecting the **MeshSat** gateway (Meshtastic / satellite / cellular node gateway at `meshsat.dspng.space`) to the **Fleet Management System (FMS)** at `https://fleet.dspng.tech` for live vehicle tracking on the Live Fleet Map.

---

## 1. Architecture Overview

```
┌──────────────────────────────────────┐
│        MeshSat Gateway Node          │
│        (meshsat.dspng.space)         │
│  Meshtastic / Satellite / Cellular   │
└──────────────────┬───────────────────┘
                   │ Webhook HTTP POST
                   │ (https://fleet.dspng.tech/meshsat-relay/webhook)
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

The `services/meshsat-relay` microservice receives raw Meshtastic/MeshSat webhook payloads, normalizes fields (node ID / MAC, lat / lon, battery, speed, heading), and forwards telemetry to FMS.

### Compose Service

The relay is declared as a service in the repository root `docker-compose.yml` and runs alongside the API and web containers on the same Docker network:

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

`FMS_URL` points at the internal `api` service, so the relay talks to FMS over the Docker network rather than the public domain. `FMS_API_KEY` is sourced from the shared `TELEMETRY_API_KEY` environment variable — the same value the `api` service uses to accept the relay's `x-api-key` header (see section 2).

### Deployment Steps

1. **Configure Environment (`.env` at the repo root)**:
   ```env
   TELEMETRY_API_KEY=<strong-random-key>   # e.g. openssl rand -hex 32
   ```
   This single variable is injected into both the `api` and `meshsat-relay` services. The relay's `FMS_API_KEY` and the API's `TELEMETRY_API_KEY` must match.

2. **Run with Docker Compose (repo root)**:
   ```bash
   docker compose up -d --build
   ```
   This starts `api`, `web`, and `meshsat-relay`. The relay listens on port `6055` and logs its configured target FMS URL on startup.

3. **Public Webhook Route (nginx)**:
   The `web` container's nginx config (`apps/web/infra.nginx.conf`) reverse-proxies the relay under the FMS domain so the MeshSat gateway has a stable HTTPS webhook target:
   ```nginx
   location /meshsat-relay/ {
     proxy_pass http://meshsat-relay:6055/;
     proxy_set_header Host $host;
     proxy_set_header X-Real-IP $remote_addr;
   }
   ```
   The MeshSat gateway can therefore reach the relay at `https://fleet.dspng.tech/meshsat-relay/webhook` (TLS terminated at the reverse proxy) — preferred over exposing port `6055` directly.

4. **Configure MeshSat Webhook Target**:
   In MeshSat gateway settings (`meshsat.dspng.space`), set the Webhook URL target to:
   ```
   https://fleet.dspng.tech/meshsat-relay/webhook
   ```
   (For local testing without the reverse proxy, the relay is also reachable directly at `http://localhost:6055/webhook`.)

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

## 6. Live Fleet Map MeshSat Integration

The Live Fleet Map page (`apps/web/src/pages/LiveFleetMap.tsx`) now renders only the native FMS Telematics map (Leaflet), showing vehicles at their live GPS positions. The previous view switcher tab ("FMS Telematics Map" / "MeshSat Mesh Map") and its embedded `VITE_MESHSAT_MAP_URL` iframe have been **removed** — the cross-origin MeshSat map could not be embedded reliably due to browser auth/framing restrictions.

MeshSat data still flows into the FMS map: GPS packets posted by the MeshSat gateway to the telemetry relay in `services/meshsat-relay` are ingested and surfaced as live vehicle markers on this page. Embedding the MeshSat `/map` UI directly in the dashboard is no longer required, so the reverse-proxy / iframe-framing setup described in earlier revisions of this document is obsolete.

### Default Map Center & Zoom Configuration

Because the FMS fleet operates in Papua New Guinea (PNG / National Capital District / Port Moresby, approx `lat: -9.4438`, `lon: 147.1803`), the Live Fleet Map defaults to those coordinates whenever no vehicle currently has a GPS fix.
