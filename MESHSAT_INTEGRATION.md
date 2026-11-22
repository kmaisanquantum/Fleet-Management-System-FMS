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

### 2.1 Rich FMB125 ingest authentication (`Bearer` token)

The richer Teltonika FMB125 JSON path (`POST /api/telemetry/ingest`, see section 8) uses a **separate** bearer token:

* **Header**: `Authorization: Bearer <TELEMETRY_INGEST_TOKEN>`
* **Config**: Set `TELEMETRY_INGEST_TOKEN` in the deployment environment. In Coolify this is set on the `api` service (Environment Variables). The API compares the header to this value with a timing-safe comparison and returns `401` if it is missing or wrong.
* **Generate a strong token**:

  ```bash
  openssl rand -hex 32
  ```

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

> **Production devices.** The two Teltonika FMB125 trackers in this deployment are registered in the seed (`apps/api/src/seed/seed.ts`, `TELTONIKA_TRACKERS`) as `gps_devices` rows with `device_type = 'teltonika'`:
>
> | IMEI | Bound to |
> |---|---|
> | `354018115690145` | V-101 |
> | `354018115694907` | V-102 |
>
> To (re)register them on a live database without re-seeding, use the `POST /api/v1/gps/devices` call above with each IMEI as `deviceIdentifier` and `"deviceType": "teltonika"`.

---

## 4. MeshSat Webhook Relay Service Setup

The `services/meshsat-relay` microservice runs alongside the FMS stack, receives raw Meshtastic/MeshSat webhook payloads, normalizes fields, and forwards telemetry to FMS. It is part of the root `docker-compose.yml` as the `meshsat-relay` service (defined in `services/meshsat-relay`).

### Deployment Steps

1. **Configure the deployment `.env`** (root of the repo):
   ```env
   # Shared with the api service (x-api-key) and the relay (FMS_API_KEY)
   TELEMETRY_API_KEY=<openssl rand -hex 32 output>

   # Preferred rich ingest (relay → POST /api/telemetry/ingest as Bearer).
   # Must match on api + relay.
   TELEMETRY_INGEST_TOKEN=<openssl rand -hex 32 output>

   # Remote command auth (api → POST https://meshsat.dspng.space/api/cmd as Bearer).
   # Set this in Coolify; do not commit the real value.
   MESHSAT_CMD_TOKEN=<set in Coolify environment>
   MESHSAT_CMD_URL=https://meshsat.dspng.space
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
       TELEMETRY_INGEST_TOKEN: ${TELEMETRY_INGEST_TOKEN}
     depends_on:
       - api
   ```
   `FMS_URL` points at the internal `api` service, so telemetry never leaves the Docker network on the way to ingest. (Remote command queuing is handled by the meshsat.dspng.space VPS, so the relay needs no command token.)

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

The relay accepts webhooks on `POST /webhook` (aliases: `/webhook/meshsat`, `/api/v1/telemetry`) and auto-detects the payload shape, so a single webhook target can serve both Meshtastic/MeshSat nodes and Teltonika FMB125 trackers. It normalizes each payload and forwards it to FMS using the **preferred Bearer ingest** `POST {FMS_URL}/api/telemetry/ingest` (`Authorization: Bearer $TELEMETRY_INGEST_TOKEN`) when that token is configured, **falling back** to the legacy `POST {FMS_URL}/api/v1/gps/positions` (`x-api-key: $FMS_API_KEY`) if the rich ingest endpoint returns `404`/`401` — so older deployments keep working unchanged.

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

## 7. Live Fleet Map — MeshSat Map Integration (server-injected token)

The Live Fleet Map page (`apps/web/src/pages/LiveFleetMap.tsx`) embeds the MeshSat map UI as a single full-size `<iframe>`; the native FMS Leaflet/telematics map and its search/filter/refresh controls have been removed. The MeshSat endpoint is **password-protected**, so embedding it directly would only show the login wall. Instead the shared secret is injected server-side:

**Trust flow**

1. The browser (a logged-in FMS user) calls `GET /api/meshsat/map-url` with its FMS JWT (`Authorization: Bearer`). The endpoint is **behind FMS auth** and returns `{ "url": "<map origin>/map?key=<MESHSAT_MAP_TOKEN>" }`.
2. The page sets the iframe `src` to that URL. The shared secret (`MESHSAT_MAP_TOKEN`) is injected **server-side** and is never baked into the frontend env or bundle.
3. MeshSat validates the `key` token on `/map` **and** on the data endpoint the map polls, skipping the interactive password for valid requests.
4. If the endpoint is unreachable (network error, expired JWT), the page falls back to the plain map URL (`VITE_MESHSAT_MAP_URL` or `https://meshsat.dspng.space/map`) and shows a notice — that path may hit the password wall. When `MESHSAT_MAP_TOKEN` is **not** configured, the endpoint simply returns the plain `<map origin>/map` URL (without `?key=`).

### 7.1 VPS-side requirement (outside this repository)

> **The token is only as trustworthy as the MeshSat side validating it.** The MeshSat VPS (`meshsat.dspng.space`) must be updated to:
> * accept the shared-secret token as the `key` query parameter on `GET /map`;
> * accept the same token on the map's data endpoint (the one the embedded page polls) and keep it authorized across the map's own polling requests;
> * reject requests with a missing or invalid `key` (unless authenticated interactively).
>
> This validation lives on the VPS and is **not part of this repository**.

A stronger alternative (if the VPS prefers not to place the raw secret in the URL) is an HMAC-signed token: the FMS would send `?exp=<unix>&sig=<hmac-sha256(exp, MESHSAT_MAP_TOKEN)>` and the VPS would verify `sig` and the expiry instead of comparing a static `key`.

**Framing.** For the iframe to render, MeshSat must be served over **HTTPS** and must permit framing by the dashboard origin: it must **not** send `X-Frame-Options: DENY`/`SAMEORIGIN`, and its `Content-Security-Policy` `frame-ancestors` must include `https://fleet.dspng.tech`.

### 7.2 Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `MESHSAT_MAP_ORIGIN` | api | MeshSat map origin (default `https://meshsat.dspng.space`). |
| `MESHSAT_MAP_TOKEN` | api | Shared secret appended to the map URL as `?key=`. Set in **Coolify**; do not commit. |

`VITE_MESHSAT_MAP_URL` (web, see `apps/web/.env.example`) is only a fallback used when `/api/meshsat/map-url` is unavailable.

MeshSat GPS packets posted by the gateway to the telemetry relay in `services/meshsat-relay` are still ingested into the FMS (`POST /api/telemetry/ingest`, sections 8–9) and surface as live markers inside the embedded MeshSat map.

### Default Map Center & Zoom Configuration

The map centre/zoom is controlled by the embedded MeshSat map itself (the FMS no longer sets Leaflet defaults). The FMS fleet operates in Papua New Guinea (PNG / National Capital District / Port Moresby, approx `lat: -9.4438`, `lon: 147.1803`) — configure the MeshSat map's default view there if required.

---

## 8. Rich FMB125 Ingest API — `POST /api/telemetry/ingest`

For FMB125 trackers that forward JSON telemetry directly (e.g. the gateway at `meshsat.dspng.space` posting to `fleet.dspng.tech`), the FMS exposes a dedicated ingest endpoint with full AVL IO element support and idempotent writes.

* **URL**: `POST https://fleet.dspng.tech/api/telemetry/ingest`
* **Auth**: `Authorization: Bearer <TELEMETRY_INGEST_TOKEN>` (see section 2.1)
* **Route source**: `apps/api/src/routes/telemetry.ts` (mounted in `apps/api/src/index.ts`)

### 8.1 Request body

```json
{
  "imei": "354018115690145",
  "timestamp": "2026-03-28T11:00:00Z",
  "lat": -9.4438,
  "lon": 147.1803,
  "sats": 9,
  "speed_kmh": 45,
  "ignition": true,
  "fuel_liters": 62.5,
  "io": { "239": 1, "16": 123456, "21": 4, "255": 1, "12": 8450 }
}
```

| Field | Type | Notes |
|---|---|---|
| `imei` | string | Device IMEI; resolved to a vehicle via `gps_devices.device_identifier`. |
| `timestamp` | string | ISO-8601 date-time. Normalized to `YYYY-MM-DD HH:MM:SS`. |
| `lat` / `lon` | number | WGS-84 coordinates. |
| `sats` | number \| null | Satellites in fix. |
| `speed_kmh` | number \| null | Speed in km/h. |
| `ignition` | bool \| number \| null | Ignition state (IO 239 takes precedence when present). |
| `fuel_liters` | number \| null | Absolute fuel level in litres. Optional — when absent it is derived from the fuel counter (see 8.3). Drives refuel/drain detection and the fuel %. |
| `io` | object | Raw Teltonika IO element map (`"<ioId>": value`). |

### 8.2 Responses

| Status | Meaning |
|---|---|
| `201` | Record stored; `{ data, alerts }` where `alerts` is the number of `fleet_exceptions` rows raised. |
| `200` | Duplicate `(imei, recorded_at)` ignored — `{ duplicate: true }` (idempotent). |
| `400` | Invalid payload, or the device is registered but not bound to a vehicle. |
| `401` | Missing/invalid bearer token. |
| `404` | Unknown IMEI (no matching `gps_devices` row). |

### 8.3 IO element → alert mapping

Truthy event-style IO elements are interpreted into `fleet_exceptions` rows; scalar telemetry IO (ignition, odometer, GSM, fuel counter) is stored on the position/live-state instead. Each telemetry-derived row carries a `type` (the alert type) and `source = 'telemetry'`.

| IO id | Meaning | `type` | Result |
|---|---|---|---|
| 255 | Overspeed | `overspeed` | `RULE_OVERSPEED` (warning, telemetry) + driver `speeding` event |
| 251 | Excessive idling | `idling` | `RULE_EXCESSIVE_IDLING` (warning, telemetry) |
| 252 | Device unplug / tamper | `power_unplug` | `RULE_DEVICE_UNPLUG` (critical, security) |
| 246 | Towing detected | `towing` | `RULE_TOWING_DETECTED` (critical, security) |
| 247 | Crash detection | `crash` | `RULE_CRASH_DETECTED` (critical, driver) + driver `crash` event |
| 175 | Geofence event | `geofence_entry` | `RULE_GEOFENCE_IO` (warning, geofence) |
| 155–174 | Geofence zone N | `geofence_entry` | `RULE_GEOFENCE_ZONE` (warning, geofence) |
| 179 | Digital output / immobilizer (DOUT) | `immobilizer` | `RULE_IMMOBILIZER` (warning, security) |
| 253 | Eco driving — harsh acceleration | `eco_driving` | `RULE_ECO_DRIVING` (info, driver) |
| 254 | Eco driving — harsh braking | `eco_driving` | `RULE_ECO_DRIVING` (info, driver) |
| 239 | Ignition | — | Position/live-state `ignition` |
| 16 | Total odometer | — | Position/live-state `odometer` |
| 21 | GSM signal | — | Position/live-state `gsm_signal` |
| 12 / 13 | Fuel counter (`feature_key='fuel_counter'`) | — | Raw value kept in `io_json` (also returned as `fuelCounter` on ingest); **scaled by the row's `scale_factor` to populate `fuel_liters`** when the fix has no explicit `fuel_liters` |

**Fuel fallback.** When `fuel_liters` is null/absent, the ingest looks up the `io_feature_map` rows with `feature_key = 'fuel_counter'` (IO 12/13), reads the first present value from `io`, multiplies it by that row's configured `scale_factor` (seeded `0.001`, i.e. millilitres → litres) and stores the result as `fuel_liters`. This guarantees `fuel_liters` always holds litres — the raw counter is never written there. Operators can adjust or add fuel-counter rows (with their `scale_factor`) via `GET/POST/PUT/DELETE /api/v1/settings/io-features` if the device reports in a different unit.

**Refuel / drain.** A change in absolute `fuel_liters` of at least **5 L** since the previous fix raises `RULE_REFUEL_DETECTED` (`type = refuel`, info, fuel) or `RULE_FUEL_DRAIN` (`type = fuel_drain`, warning, fuel).

### 8.4 Client-facing read & reporting endpoints

These are JWT-authenticated and scoped so that client-portal users (`client_user` role, mapped to a client through the `user_clients` table) only see their own vehicles (filtered by `vehicles.client_id`). Fleet-wide roles see everything.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/telemetry/latest` | Latest position, ignition, speed, satellites and fuel per vehicle. |
| GET | `/api/telemetry/features/:imei` | Decoded IO feature grid (via `io_feature_map`, each feature including `scale_factor` and the scaled `scaled_value`) + live state + recent telemetry events for one device. 403 outside the caller's client scope. |
| GET | `/api/telemetry/summary?from&to` | Fuel refuelled/consumed, distance, efficiency and the alert log over a range. |
| GET | `/api/telemetry/export?format=csv&from&to` | CSV export of position history (max 20 000 rows). |

In the web app these power **Vehicle Live Status** (`/telemetry`), the **Device panel** (`/telemetry/device/:imei` — live status, IO feature grid, fuel refuel/drain events with CSV/print, recent events, and the command section), and the **Fuel & Alerts Report** (`/telemetry-report`), which includes the CSV export button and a printable view.

### 8.5 Verification

```bash
curl -X POST https://fleet.dspng.tech/api/telemetry/ingest \
  -H "Authorization: Bearer <TELEMETRY_INGEST_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "imei": "354018115690145",
    "timestamp": "2026-03-28T11:00:00Z",
    "lat": -9.4438,
    "lon": 147.1803,
    "sats": 9,
    "speed_kmh": 45,
    "ignition": true,
    "fuel_liters": 62.5,
    "io": { "239": 1, "16": 123456, "21": 4, "255": 1 }
  }'
```

A `201` with `alerts >= 1` confirms the record was stored and the overspeed IO element raised an exception; re-sending the identical body returns `200 { "duplicate": true }`.

---

## 9. Remote Configuration & Control (Teltonika Codec 12)

FMS users with the `admin` or `fleet_manager` role can push remote config/control commands (`setparam`, `setdigout`, `raw`) to a tracker. The `client_user` role is read-only (403). Commands are **queued** in `device_commands` and POSTed to the **meshsat.dspng.space VPS command endpoint**, which queues them and delivers them to the tracker over its **next TCP session (5027)** using Codec 12. Because delivery waits for the tracker to sync, the UI shows **"Queued / Pending Next Tracker Sync"** until the tracker acknowledges.

> The command queue lives on the **meshsat.dspng.space VPS** (its `/api/cmd` on `127.0.0.1:6051` → Codec 12 over TCP 5027). This repository's `services/meshsat-relay` only forwards telemetry; it does **not** host `/api/cmd`.

### 9.1 Command flow

```
   Web UI (device panel)
        │  POST /api/telemetry/commands  {imei, type, params}
        │  JWT: admin | fleet_manager        (client_user = 403)
        ▼
   FMS api  ──► device_commands row (status = 'queued')  +  audit_logs
        │  POST https://meshsat.dspng.space/api/cmd   {"imei":"<15-digit>","command":"<teltonika-cmd>"}
        │  Authorization: Bearer ${MESHSAT_CMD_TOKEN}
        ▼
   meshsat.dspng.space VPS (local /api/cmd on 127.0.0.1:6051)
        │  enqueue per-IMEI; deliver on the tracker's next TCP session
        ▼
   FMB125 tracker  ──(Codec 12 over TCP 5027)──►  applies setparam / setdigout
        │
        ▼  (VPS accepts 2xx → FMS api marks the row 'sent'; later 'acked')
```

Status transitions: `queued` → `sent` → `acked`, or `failed`. A 2xx from the VPS sets `sent` + `sent_at`; a non-2xx response or an unreachable endpoint sets `failed` with the error in `response_text`.

### 9.2 Endpoints

The **VPS** exposes the command endpoint (contract confirmed with the operator):

| Method | Path | Notes |
|---|---|---|
| POST | `https://meshsat.dspng.space/api/cmd` | Body `{ "imei": "<15-digit>", "command": "<teltonika-cmd>" }` (`cmd` is accepted as a fallback key — FMS always sends `command`). Auth: `Authorization: Bearer <MESHSAT_CMD_TOKEN>`. Returns 2xx when queued for the tracker's next TCP session. |

The FMS API side (`apps/api/src/routes/deviceCommands.ts`, mounted at `/api/telemetry/commands`):

| Method | Path | Notes |
|---|---|---|
| POST | `/` | Queue a command (see `API.md`). POSTed to `${MESHSAT_CMD_URL}/api/cmd` with `Authorization: Bearer`. |
| GET | `/?imei=` | Tenant-scoped queue + delivery history. |
| POST | `/:id/cancel` | Cancel a still-`queued` row. |

### 9.3 Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `MESHSAT_CMD_URL` | api | VPS base URL (`https://meshsat.dspng.space`). |
| `MESHSAT_CMD_TOKEN` | api | Secret sent as `Authorization: Bearer`. Set in **Coolify**; do not commit. |
| `MESHSAT_MAP_ORIGIN` | api | MeshSat map origin for the Live Fleet Map URL (section 7); default `https://meshsat.dspng.space`. |
| `MESHSAT_MAP_TOKEN` | api | Shared secret injected into the map URL as `?key=`. Set in **Coolify**; do not commit. |
| `TELEMETRY_INGEST_TOKEN` | api + relay | Bearer token for the rich telemetry ingest (also used by the relay forward). |

### 9.4 Verification

```bash
# Queue an immobilizer DOUT engagement (replace <JWT> with a fleet_manager token)
curl -X POST https://fleet.dspng.tech/api/telemetry/commands \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{ "imei": "354018115690145", "type": "setdigout", "params": { "dout": 1 } }'

# Inspect the queue + status history
curl "https://fleet.dspng.tech/api/telemetry/commands?imei=354018115690145" \
  -H "Authorization: Bearer <JWT>"
```

A `201` with `message: "Queued / Pending Next Tracker Sync"` and a `status` of `sent` (VPS accepted for delivery) or `failed` (endpoint rejected/unreachable) confirms the command was persisted and dispatched.
