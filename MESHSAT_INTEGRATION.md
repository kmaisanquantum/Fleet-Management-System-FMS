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
│  Normalizes Node ID / MAC / IMEI +   │
│      Lat/Lon + AVL IO elements       │
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

Before telemetry for a device is mapped to a vehicle, its **device identifier must be registered** and linked to a `vehicle_id`. The identifier used depends on the payload source:

* **MeshSat / Meshtastic node** — the node's Node ID or MAC address (e.g. `!12345678` or `00:11:22:33:44:55`).
* **Teltonika FMB125** — the device **IMEI** (e.g. `860123456789012`), exactly as it appears in the `imei` field of the FMB125 payload.

Telemetry for an unregistered identifier is rejected by the ingest API (`Unknown device or missing vehicle binding`) and will never appear on the Live Fleet Map.

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

For a **Teltonika FMB125**, register the device using its IMEI as the `deviceIdentifier`:

```bash
curl -X POST https://fleet.dspng.tech/api/v1/gps/devices \
  -H "Authorization: Bearer <ADMIN_JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceIdentifier": "860123456789012",
    "vehicleId": "v-101-uuid-here",
    "status": "active"
  }'
```

Replace `860123456789012` with the IMEI reported by the FMB125 (also visible in the raw `imei` field of its webhook payload), and `v-101-uuid-here` with the target vehicle's `vehicle_id`.

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

## 5. Supported Device Payload Formats

The relay accepts webhooks on `POST /webhook` (aliases: `/webhook/meshsat`, `/api/v1/telemetry`) and auto-detects the payload shape, so a single webhook target can serve both Meshtastic/MeshSat nodes and Teltonika FMB125 trackers. It normalizes each payload into the standard FMS GPS position body and forwards it to `POST {FMS_URL}/api/v1/gps/positions`.

### 5.1 Meshtastic / MeshSat

Identifier read from `fromId` / `sender` / `nodeId` / `node_id` / `mac` / `deviceIdentifier`; telemetry read from `payload` (or top-level): `latitude`/`longitude`, `altitude`, `batteryLevel`, `speed`, `heading`, `time`.

```json
{
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
}
```

### 5.2 Teltonika FMB125 (AVL)

The relay understands the FMB125 JSON/AVL structure:

* **Identifier**: `imei` / `IMEI` / `device_id` / `deviceId` (checked on `body`, on each record, on `payload`, and at `body.device.imei`).
* **Records**: accepts a bare JSON array of records, or records nested under `data[]` / `records[]`. When multiple records are present, the **most recent (last) record** is used.
* **GNSS**: `gps.latitude` / `gps.longitude` (or `lat` / `lng`), `gps.speed`, `gps.altitude`, `gps.angle` (mapped to heading), `gps.satellites`.
* **AVL IO elements** (nested `io` object or flat `io_####` keys):
  * Ignition — `io.ignition` (or the flat `io_239` / `239`).
  * Odometer — `io.totalOdometer` (or `io_16`).
  * Fuel level — `io.fuelLevel` / `io.fuelLevelPct` (or `io_30` / `io_81`).
  * GSM signal — `io.gsmSignal` (or `io_21`).

When an ignition IO element is present it is **passed through unchanged** (so a parked vehicle with ignition on still reports `ignition: 1`); when it is absent, ignition is derived from speed (`speed > 0 → 1`).

Sample FMB125 record:

```json
{
  "imei": "860123456789012",
  "records": [
    {
      "gps": {
        "latitude": -9.4438,
        "longitude": 147.1803,
        "altitude": 52,
        "speed": 45,
        "angle": 271,
        "satellites": 9
      },
      "io": {
        "ignition": 1,
        "totalOdometer": 123456789,
        "fuelLevel": 62.5,
        "gsmSignal": 4
      },
      "timestamp": "2026-03-28T11:00:00Z"
    }
  ]
}
```

---

## 6. Verification Commands

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

### Test 3: FMB125 Payload to MeshSat Relay Service

```bash
# Via the nginx HTTPS route (production)
curl -X POST https://fleet.dspng.tech/meshsat-relay/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "imei": "860123456789012",
    "records": [
      {
        "gps": { "latitude": -9.4438, "longitude": 147.1803, "speed": 45, "angle": 271, "altitude": 52, "satellites": 9 },
        "io": { "ignition": 1, "totalOdometer": 123456789, "fuelLevel": 62.5, "gsmSignal": 4 }
      }
    ]
  }'
```

The relay resolves the `imei` to a registered `vehicle_id`, so the device must first be registered per section 3.

### Test 4: Confirm Ingest + Live Map

Upon sending test packets, verify that a `gps_positions` row is created and the corresponding vehicle moves live on the **Live Fleet Map** (`https://fleet.dspng.tech/live-map`).

---

## 7. Live Fleet Map MeshSat Integration

The Live Fleet Map page (`apps/web/src/pages/LiveFleetMap.tsx`) now renders only the native FMS Telematics map (Leaflet), showing vehicles at their live GPS positions. The previous view switcher tab ("FMS Telematics Map" / "MeshSat Mesh Map") and its embedded `VITE_MESHSAT_MAP_URL` iframe have been **removed** — the cross-origin MeshSat map could not be embedded reliably due to browser auth/framing restrictions.

MeshSat data still flows into the FMS map: GPS packets posted by the MeshSat gateway to the telemetry relay in `services/meshsat-relay` are ingested and surfaced as live vehicle markers on this page. Embedding the MeshSat `/map` UI directly in the dashboard is no longer required, so the reverse-proxy / iframe-framing setup described in earlier revisions of this document is obsolete.

### Default Map Center & Zoom Configuration

Because the FMS fleet operates in Papua New Guinea (PNG / National Capital District / Port Moresby, approx `lat: -9.4438`, `lon: 147.1803`), the Live Fleet Map defaults to those coordinates whenever no vehicle currently has a GPS fix.
