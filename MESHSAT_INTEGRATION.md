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

## 7. Live Fleet Map — MeshSat Map Integration (server-side Basic-auth proxy)

The Live Fleet Map page (`apps/web/src/pages/LiveFleetMap.tsx`) renders the native FMS Leaflet map (`FleetLiveMap.tsx`) by default, with the MeshSat map available as an optional embedded view. `meshsat.dspng.space` is protected by **HTTP Basic auth** (username `admin` + password), and **a browser cannot send a Basic `Authorization` header from inside an iframe** — embedding the map directly would only show the login wall. Instead the FMS backend proxies the map and injects the credential server-side.

When `MESHSAT_MAP_AUTH` is missing or the upstream rejects it, `GET /api/meshsat-map/health` reports the proxy unavailable and the page keeps the native map usable, with a banner explaining that MeshSat is not configured. The "Open MeshSat map" button re-probes health before mounting the iframe. If the FMS telemetry feed has no vehicle with a GPS fix (for example, a fresh deployment before the first ingest), the page probes MeshSat once and switches to the embedded map automatically instead of leaving the native map empty; the "FMS map" button switches back.

**Trust flow**

1. The page calls `GET /api/meshsat-map/session` with `Authorization: Bearer <fms-jwt>`; the proxy validates the JWT and sets a short-lived, HttpOnly `fms_map_token` cookie scoped to `/api/meshsat-map`. The iframe is then loaded at `/api/meshsat-map/map` with no token in its URL, so JWTs do not appear in iframe URLs or proxy access logs.
2. `/api/meshsat-map/*` is **behind FMS auth**. The proxy accepts the FMS JWT as a `Bearer` header, as the short-lived `fms_map_token` cookie, or as a `?fms_token=` query parameter (kept for backward compatibility). If a stale `?fms_token=` is present alongside a fresh cookie, the proxy falls back to the cookie instead of rejecting the iframe.
3. The proxy fetches `${MESHSAT_MAP_ORIGIN || "https://meshsat.dspng.space"}/<path>` — e.g. `/api/meshsat-map/map` → `/map`, `/api/meshsat-map/api/positions` → `/api/positions` — injecting `Authorization: Basic <base64(MESHSAT_MAP_AUTH)>` **server-side**. The password never reaches the browser.
4. In `text/html` responses the proxy rewrites absolute `https://meshsat.dspng.space` URLs and root-relative `src="/"`, `href="/"`, `fetch("/"`, `url(/` references to the `/api/meshsat-map` prefix, so the map's assets and data calls flow back through the proxy. It also strips `X-Frame-Options`, the CSP `frame-ancestors` directive, and any upstream `Set-Cookie` (so MeshSat cannot clobber `fms_map_token`), and forces `Referrer-Policy: no-referrer`. The upstream page's Leaflet CSS/JS and marker images are served through `/api/meshsat-map/vendor/leaflet/*` (fetched server-side from unpkg with a jsDelivr fallback), so a browser or network that blocks `unpkg.com` can still render the map. Other absolute third-party URLs — non-Leaflet `unpkg.com` assets and any non-MeshSat host — are left untouched. HTML responses are also marked `Cache-Control: no-store`, so a basemap or asset fix reaches browsers without a hard refresh. The basemap tile template is the one exception: `applyTileSource` swaps OSM for a CDN provider (see **Tiles**).
5. MeshSat validates the Basic credential on `/map` **and** on the data endpoint the map polls, because the proxy attaches it to every upstream request.

**Session lifetime.** FMS access tokens last **15 minutes**, which is also the lifetime of the `fms_map_token` cookie. The web client refreshes the access token automatically (proactively before expiry and once on a `401`), and `LiveFleetMap.tsx` rolls the map cookie forward by calling `GET /api/meshsat-map/session` with the fresh Bearer token after each refresh. That endpoint only re-issues the cookie (it does not contact MeshSat), so a live-map tab left open keeps updating instead of rendering `{"error":"Invalid or expired token"}` or silently freezing on stale data.

**Idle sessions.** The SPA signs a user out after `VITE_IDLE_TIMEOUT_MINUTES` (default **30**) without mouse, keyboard, touch, or scroll activity. The last-activity timestamp is shared through `localStorage`, so one active tab keeps the others alive; when the window expires, the tokens are cleared and the router returns to `/login` with a "signed out after inactivity" notice, where the user can sign in again. A reload after the window has passed also signs the user out instead of silently restoring the session. A failed token refresh clears the session with a "session expired" notice.

**Tiles.** The upstream map has used keyless basemaps: `tile.openstreetmap.org` (OSM answers this deployment with `403 Access blocked`) and `{s}.basemaps.cartocdn.com/rastertiles/voyager/...` (CARTO renders "API KEY REQUIRED" watermarks without a key). The proxy therefore rewrites both tile templates to `MESHSAT_MAP_TILE_URL` and the Leaflet `attribution` to `MESHSAT_MAP_TILE_ATTRIBUTION`. The default is Esri World Street Map (`https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}`) with Esri's required source attribution; it is keyless and renders correctly from the FMS. Tiles are fetched **browser → CDN**, never through the proxy. The injected client shim retries a failed tile once, then falls back from Street to Topo and finally OSM, and only reports a warning after several tiles fail. For production/commercial use, point the variable at a licensed provider (CARTO with a `?key=`, MapTiler, Thunderforest, …) and keep its attribution visible. This rewrite lives in the FMS proxy, so **no change is needed on the MeshSat VPS**.

**Known limitation — WebSockets / SSE.** An HTTP proxy can only rewrite request URLs the page issues through the document (fetch/XHR/assets). If the map's inline script opens a **WebSocket** or **EventSource** against an *absolute* URL (`wss://meshsat.dspng.space/...` / `https://meshsat.dspng.space/...`), that connection bypasses the proxy and will fail the Basic-auth challenge. If live telemetry on the map depends on such a channel, use the token-param alternative in §7.1 instead.

**Framing.** The proxy strips the framing headers itself, so MeshSat does **not** need to change its `X-Frame-Options`/CSP for the iframe to render (it must still be served over HTTPS).

### 7.1 Alternative — MeshSat accepts a token param

If the map's inline script uses absolute-URL API calls or WebSockets that cannot be rewritten (see the known limitation above), the VPS can instead accept a bearer-style token parameter:

* The MeshSat VPS accepts `?key=<token>` on `GET /map` **and** on the data endpoint the map polls, skipping the interactive password for a valid token.
* The FMS then hands the browser a ready-to-embed tokenized URL — implemented as `GET /api/meshsat/map-url` (behind FMS auth), backed by `MESHSAT_MAP_TOKEN`.
* A stronger variant is an HMAC-signed token: the FMS sends `?exp=<unix>&sig=<hmac-sha256(exp, MESHSAT_MAP_TOKEN)>` and the VPS verifies `sig` and the expiry instead of comparing a static key.

> **The credential/token is only as trustworthy as the MeshSat side validating it.** Either way the MeshSat VPS must reject `/map` (and its data endpoint) when the credential is missing or wrong. That validation lives on the VPS and is **not part of this repository**.

### 7.2 Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `MESHSAT_MAP_ORIGIN` | api | MeshSat map origin (default `https://meshsat.dspng.space`). |
| `MESHSAT_MAP_AUTH` | api | HTTP Basic credential (`username:password`, e.g. `admin:<password>`) the proxy injects upstream on every request. Set in **Coolify**; do not commit. |
| `MESHSAT_MAP_TOKEN` | api | Shared secret for the §7.1 token-param **alternative** only (used by `GET /api/meshsat/map-url`). Optional. |

On the web side, `VITE_MESHSAT_MAP_URL` (`apps/web/.env.example`) is the override for **unauthenticated** MeshSat deployments: when set, the page embeds it directly instead of routing through `/api/meshsat-map`. When unset, the page uses the proxy if `MESHSAT_MAP_AUTH` is configured and healthy, and otherwise keeps the native FMS map.

MeshSat GPS packets posted by the gateway to the telemetry relay in `services/meshsat-relay` are still ingested into the FMS (`POST /api/telemetry/ingest`, sections 8–9) and surface as live markers in both map views.

### Default Map Center & Zoom Configuration

The native FMS map defaults to Papua New Guinea (Port Moresby, approx `lat: -9.4438`, `lon: 147.1803`) and fits the bounds of the located fleet on load. The embedded MeshSat view keeps its own centre/zoom configuration on the MeshSat VPS.

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
| 239 | Ignition | — | Position/live-state `ignition`; feature grid `ignition` (boolean) |
| 16 | Total odometer | — | Position/live-state `odometer`; feature grid `odometer`, scaled m→km (factor 0.001) |
| 21 | GSM signal | — | Position/live-state `gsm_signal` |
| 66 | External (main) power voltage | `power_unplug` | Feature grid `external_voltage`, scaled mV→V (factor 0.001). When present and below 1000 mV the tracker is running on internal battery → `RULE_MAIN_POWER_CUT` (critical, security, `type = power_unplug`) |
| 67 | Internal battery voltage | — | Feature grid `internal_battery`, scaled mV→V (factor 0.001) |
| 240 | Movement | — | Feature grid `movement` (boolean) |
| 12 / 13 | Fuel counter (`feature_key='fuel_counter'`) | — | Raw value kept in `io_json` (also returned as `fuelCounter` on ingest); **scaled by the row's `scale_factor` to populate `fuel_liters`** when the fix has no explicit `fuel_liters` |

**Fuel fallback.** When `fuel_liters` is null/absent, the ingest looks up the `io_feature_map` rows with `feature_key = 'fuel_counter'` (IO 12/13), reads the first present value from `io`, multiplies it by that row's configured `scale_factor` (seeded `0.001`, i.e. millilitres → litres) and stores the result as `fuel_liters`. This guarantees `fuel_liters` always holds litres — the raw counter is never written there. Operators can adjust or add fuel-counter rows (with their `scale_factor`) via `GET/POST/PUT/DELETE /api/v1/settings/io-features` if the device reports in a different unit.

**Refuel / drain.** A change in absolute `fuel_liters` since the previous fix raises `RULE_REFUEL_DETECTED` (`type = refuel`, info, fuel) or `RULE_FUEL_DRAIN` (`type = fuel_drain`, warning, fuel). To filter sensor noise on rough roads the change must be at least the configured threshold: `FUEL_REFUEL_MIN_L` (default 5) for a rise, `FUEL_DRAIN_MIN_L` (default 5) for a fall; smaller swings are ignored. Both are read from the environment on each evaluation, so they can be tuned per deployment without a rebuild.

**Offline watchdog.** Every successful ingest stamps `vehicles.last_seen_at`. `GET /api/telemetry/latest` and `GET /api/telemetry/features/:imei` return that timestamp plus a computed `online` boolean — `true` when the last ingest is within `DEVICE_OFFLINE_MINUTES` (default 15) — and the Vehicle Live Status / device panel pages show an "Offline" badge with the last-seen time when `online` is `false`.

### 8.4 Client-facing read & reporting endpoints

These are JWT-authenticated and scoped so that client-portal users (`client_user` role, mapped to a client through the `user_clients` table) only see their own vehicles (filtered by `vehicles.client_id`). Fleet-wide roles see everything.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/telemetry/latest` | Latest position, ignition, speed, satellites and fuel per vehicle, plus `last_seen_at` and the computed `online` boolean. |
| GET | `/api/telemetry/features/:imei` | Decoded IO feature grid (via `io_feature_map`, each feature including `scale_factor` and the scaled `scaled_value`) + live state + `last_seen_at`/`online` + recent telemetry events for one device. 403 outside the caller's client scope. |
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

FMS users with the `admin` or `fleet_manager` role can push remote config/control commands (`setparam`, `setdigout`, `diagnostic`, `camreq`, `raw`) to a tracker. The `client_user` role is read-only (403). Commands are **queued** in `device_commands` and POSTed to the **meshsat.dspng.space VPS command endpoint**, which queues them and delivers them to the tracker over its **next TCP session (5027)** using Codec 12. Because delivery waits for the tracker to sync, the UI shows **"Queued / Pending Next Tracker Sync"** until the tracker acknowledges.

### 9.0 Command types

| `type` | `params` | Emitted command |
|---|---|---|
| `setparam` | `{ param_id \| feature_key, value }` | `setparam <paramId>:<value>` |
| `setdigout` | `{ dout: 0\|1, dout_index?, timeout? }` | `setdigout <dout> <index>` or `setdigout <dout> <index> <timeout>` |
| `diagnostic` | `{ command }` ∈ `getinfo`, `getgps`, `getver`, `getstatus`, `readio` | the whitelisted string as-is |
| `camreq` | `{ channel? }` | `camreq` or `camreq <channel>` |
| `raw` | `{ command }` | the raw string as-is |

* **Diagnostic** commands are read-only status requests (`getinfo`, `getgps`, `getver`, `getstatus`, `readio`). Only those exact strings are accepted — arbitrary strings are **rejected** by the `diagnostic` type; use `raw` for anything outside the whitelist. The tracker replies on its next TCP sync and the result is visible in the command history.
* **`setdigout` DOUT index** is optional and defaults to **1** (DOUT1 — the immobilizer relay). Supply `dout_index` to target another DOUT relay; the command is always emitted in the full `setdigout <dout> <index>` form.
* **`setdigout` timeout** is optional and, when supplied, must be a non-negative integer (the DOUT pulse duration); it is appended as `setdigout <dout> <index> <timeout>`.
* **`camreq`** requests a camera snapshot; an optional positive integer `channel` selects the camera (emitted `camreq` or `camreq <channel>`).
* **Top-level `reason` / `force`.** The request body also accepts `reason` (string) and `force` (boolean) alongside `type`/`params`. `reason` is required for an ignition cut (`setdigout dout=1`) and is stored on the command + audit. `force: true` lets an **admin** override the moving-vehicle speed guard (see 9.0.1); it is ignored for non-admins.

### 9.0.1 Immobilizer flow (remote ignition cut / restore)

* **Cut / immobilize:** `setdigout` with `dout=1` (`setdigout 1 1`) — drives DOUT1 to immobilize the vehicle.
* **Restore:** `setdigout` with `dout=0` (`setdigout 0 1`) — releases DOUT1 so the vehicle can start again.
* Both are routed through the dedicated **Remote Ignition Shutdown / Restore** panel in the device page, which displays the current **ignition state (IO 239)** and **DOUT/immobilizer state (IO 179)** decoded via `GET /api/telemetry/features/:imei`, and requires an explicit **confirmation modal** — showing the vehicle/IMEI, the exact command string to be sent, an immobilization warning, and a required **reason** field — before the command is queued. The confirmation checkbox must be ticked and a reason entered before the **Issue** button enables.
* **Server-side speed guard (API-enforced).** An ignition cut (`dout=1`) is rejected with `400` when no non-empty `reason` is supplied. The API then reads the vehicle's latest reported speed (`telemetry_records.speed_kmh`, falling back to `gps_positions.speed`) and, when it exceeds **10 km/h**, refuses the cut with `409 { error: "Vehicle moving — ignition cut blocked", speed_kmh }`. The only bypass is an `admin` caller passing `force: true` (a `fleet_manager` cannot force); a forced cut is logged distinctly (see audit below). Restores (`dout=0`) are never speed-guarded.
* **Audit:** ignition actions are recorded in `audit_logs` with distinct actions — `IGNITION_CUT_QUEUED` (`dout=1`), `IGNITION_RESTORE_QUEUED` (`dout=0`) — while every other command keeps `DEVICE_COMMAND_QUEUED`. A forced override additionally writes `IGNITION_CUT_FORCED` carrying `speed_kmh`, `reason` and `forced: true`. Each audit `newValue` carries `imei`, `vehicle_id`, the serialized `command`, and the `reason`.

> The command queue lives on the **meshsat.dspng.space VPS** (its `/api/cmd` on `127.0.0.1:6051` → Codec 12 over TCP 5027). This repository's `services/meshsat-relay` only forwards telemetry; it does **not** host `/api/cmd`.

### 9.1 Command flow

```
   Web UI (device panel)
        │  POST /api/telemetry/commands  {imei, type, params, reason?, force?}
        │  JWT: admin | fleet_manager        (client_user = 403)
        │  dout=1 → reason required; speed > 10 km/h → 409 (admin force:true to override)
        ▼
   FMS api  ──► device_commands row (status = 'queued')  +  audit_logs
        │  POST https://meshsat.dspng.space/api/cmd   {"imei":"<15-digit>","command":"<teltonika-cmd>"}
        │  Authorization: Bearer ${MESHSAT_CMD_TOKEN}
        ▼
   meshsat.dspng.space VPS (local /api/cmd on 127.0.0.1:6051)
        │  enqueue per-IMEI; deliver on the tracker's next TCP session
        ▼
   FMB125 tracker  ──(Codec 12 over TCP 5027)──►  applies setparam / setdigout
        │  replies over Codec 12
        ▼
   meshsat.dspng.space VPS
        │  POST /api/telemetry/commands/ack   {"imei":"<15-digit>","cmd":"<echoed-cmd>","reply":"<tracker-reply>"}
        │  Authorization: Bearer ${TELEMETRY_INGEST_TOKEN}
        ▼
   FMS api  ──► device_commands row (status = 'acknowledged', response_text, acked_at)
```

Status transitions: `queued` → `sent` → `acknowledged`, or `failed`. A 2xx from the VPS sets `sent` + `sent_at`; a non-2xx response or an unreachable endpoint sets `failed` with the error in `response_text`. The tracker's Codec 12 reply is reported back by the VPS to `POST /api/telemetry/commands/ack` (section 9.2), which flips the matching `sent` row to `acknowledged` and stores the reply in `response_text` with `acked_at` set. (`acked` remains a valid legacy status value; the current lifecycle uses `acknowledged`.)

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
| POST | `/ack` | **Tracker-reply callback (VPS → FMS).** Auth: `Authorization: Bearer ${TELEMETRY_INGEST_TOKEN}` (the ingest token, **not** a user JWT). Body `{ imei, command \| cmd, response \| reply }`. Matches the most recent `status='sent'` row for that IMEI whose serialized command equals `command`/`cmd`, then sets `status='acknowledged'`, `response_text=<reply>`, `acked_at=now`. Returns `200 { data, message }`; `404` when no sent command matches. |
| POST | `/:id/cancel` | Cancel a still-`queued` row. |

The **ack contract** the VPS must implement: when the FMB125 responds to a queued command over its Codec 12 TCP session, the VPS POSTs the echoed command string and the tracker's reply to `POST https://fleet.dspng.tech/api/telemetry/commands/ack` with the `TELEMETRY_INGEST_TOKEN` bearer. The echoed `command`/`cmd` must match the exact serialized command string the FMS sent (`setparam <id>:<value>`, `setdigout <dout> <index>`, `camreq [<channel>]`, etc.) so the row can be correlated. A successful ack surfaces in the device panel as the **Acknowledged** badge with the tracker's reply.

### 9.3 Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `MESHSAT_CMD_URL` | api | VPS base URL (`https://meshsat.dspng.space`). |
| `MESHSAT_CMD_TOKEN` | api | Secret sent as `Authorization: Bearer`. Set in **Coolify**; do not commit. |
| `MESHSAT_MAP_ORIGIN` | api | MeshSat map origin for the Live Fleet Map URL (section 7); default `https://meshsat.dspng.space`. |
| `MESHSAT_MAP_TOKEN` | api | Shared secret injected into the map URL as `?key=`. Set in **Coolify**; do not commit. |
| `TELEMETRY_INGEST_TOKEN` | api + relay | Bearer token for the rich telemetry ingest (also used by the relay forward **and** the `/commands/ack` tracker-reply callback). |
| `FUEL_REFUEL_MIN_L` | api | Minimum refuel rise (litres) before `RULE_REFUEL_DETECTED` fires; default `5`. Jitter filter. |
| `FUEL_DRAIN_MIN_L` | api | Minimum fuel fall (litres) before `RULE_FUEL_DRAIN` fires; default `5`. Jitter filter. |
| `DEVICE_OFFLINE_MINUTES` | api | Window (minutes) since `last_seen_at` before `online` flips to `false`; default `15`. |

### 9.4 Verification

```bash
# Cut the ignition (immobilize) — replace <JWT> with a fleet_manager token.
# `reason` is REQUIRED for dout=1; the cut is refused (409) while the vehicle
# moves faster than 10 km/h unless an admin passes force:true.
curl -X POST https://fleet.dspng.tech/api/telemetry/commands \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{ "imei": "354018115690145", "type": "setdigout", "params": { "dout": 1 }, "reason": "Stolen vehicle recovery" }'
# → relayed as "setdigout 1 1", audited IGNITION_CUT_QUEUED
# → 409 {"error":"Vehicle moving — ignition cut blocked","speed_kmh":45} if moving

# Admin force-override of the moving-vehicle guard (audited IGNITION_CUT_FORCED)
curl -X POST https://fleet.dspng.tech/api/telemetry/commands \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{ "imei": "354018115690145", "type": "setdigout", "params": { "dout": 1 }, "reason": "Immediate immobilize — pursuit", "force": true }'

# Restore the ignition
curl -X POST https://fleet.dspng.tech/api/telemetry/commands \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{ "imei": "354018115690145", "type": "setdigout", "params": { "dout": 0 } }'
# → relayed as "setdigout 0 1", audited IGNITION_RESTORE_QUEUED

# Optional DOUT pulse timeout (emits "setdigout 1 1 30")
curl -X POST https://fleet.dspng.tech/api/telemetry/commands \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{ "imei": "354018115690145", "type": "setdigout", "params": { "dout": 1, "timeout": 30 }, "reason": "Pulse test" }'

# Read-only diagnostic (getinfo | getgps | getver | getstatus)
curl -X POST https://fleet.dspng.tech/api/telemetry/commands \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{ "imei": "354018115690145", "type": "diagnostic", "params": { "command": "getgps" } }'

# Inspect the queue + status history
curl "https://fleet.dspng.tech/api/telemetry/commands?imei=354018115690145" \
  -H "Authorization: Bearer <JWT>"

# Tracker-reply callback (VPS → FMS): marks the matching sent row 'acknowledged'
curl -X POST https://fleet.dspng.tech/api/telemetry/commands/ack \
  -H "Authorization: Bearer $TELEMETRY_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "imei": "354018115690145", "cmd": "setdigout 1 1", "reply": "OK" }'
# → 200 {"data": {...}, "message": "Command acknowledged"}   (404 if no sent row matches)
```

A `201` with `message: "Queued / Pending Next Tracker Sync"` and a `status` of `sent` (VPS accepted for delivery) or `failed` (endpoint rejected/unreachable) confirms the command was persisted and dispatched. Once the VPS reports the tracker's Codec 12 reply to `/commands/ack`, the row moves to `acknowledged` and the device panel shows the **Acknowledged** badge with the reply text.

---

## 10. Deployment Runbook

End-to-end checklist for standing up the Teltonika telemetry ingest + MeshSat map on the Coolify deployment. Run it top to bottom for a first-time deploy, and re-run the smoke test after any credential rotation.

### 10.1 Coolify environment checklist

Set these on the **api** service (Coolify → api → Environment Variables). Generate the secrets with `openssl rand -hex 32`; never commit the real values.

| Variable | Value | Notes |
|---|---|---|
| `TELEMETRY_INGEST_TOKEN` | `<secret>` | Bearer token for `POST /api/telemetry/ingest` (section 2.1) **and** the `POST /api/telemetry/commands/ack` tracker-reply callback (section 9.2). |
| `MESHSAT_CMD_URL` | `https://meshsat.dspng.space` | VPS base URL for remote commands (section 9). |
| `MESHSAT_CMD_TOKEN` | `<rotated>` | `Authorization: Bearer` for the VPS `/api/cmd`. |
| `MESHSAT_MAP_ORIGIN` | `https://meshsat.dspng.space` | MeshSat map origin (section 7). |
| `MESHSAT_MAP_AUTH` | `admin:<password>` | Basic credential the proxy injects server-side. |
| `FUEL_REFUEL_MIN_L` | `5` | Minimum refuel rise (litres) before a refuel alert fires; jitter filter. Optional — defaults to `5`. |
| `FUEL_DRAIN_MIN_L` | `5` | Minimum fuel fall (litres) before a drain alert fires; jitter filter. Optional — defaults to `5`. |
| `DEVICE_OFFLINE_MINUTES` | `15` | Minutes without an ingest before a device is flagged **Offline**; optional — defaults to `15`. |

**Web** build-time (Coolify → web → Environment Variables):

| Variable | Value | Notes |
|---|---|---|
| `VITE_MESHSAT_MAP_URL` | *(unset)* | Optional override; normally unset so the page routes through the `/api/meshsat-map` proxy. |

> Also ensure `TELEMETRY_API_KEY`, `JWT_SECRET` and `CORS_ORIGIN` are set (root `.env.example`).

### 10.2 Schema & seed

* The SQLite schema (`apps/api/src/db/schema.sql`) **auto-migrates on api start** — no manual step needed for the demo/embedded deployment. The consolidated Postgres DDL is `database/migrations/003_telemetry.sql` for non-SQLite deployments.
* The seed binds both Teltonika FMB125 trackers (`354018115690145` → V-101, `354018115694907` → V-102) so telemetry resolves to a vehicle.

### 10.3 Smoke test

Post one fix and confirm the idempotent response:

```bash
curl -X POST https://fleet.dspng.tech/api/telemetry/ingest \
  -H "Authorization: Bearer $TELEMETRY_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"imei":"354018115690145","timestamp":"<ISO>","lat":-6.8,"lon":39.28,"sats":9,"speed_kmh":42,"ignition":true,"fuel_liters":51.3,"io":{"255":0,"12":51300}}'
```

* **First call → `201`** (record stored; `fuel_liters` taken from the explicit value).
* **Re-send the identical body → `200 { "duplicate": true }`** (idempotent on `UNIQUE(imei, recorded_at)`).
* With `"fuel_liters"` omitted instead, the ingest falls back to the IO 12 counter scaled by `io_feature_map.scale_factor` (`51300 × 0.001 = 51.3 L`).

### 10.4 Post-deploy hardening

* **Ack endpoint (VPS side).** The `acknowledged` status only lights up once the **VPS** calls `POST /api/telemetry/commands/ack` with the tracker's Codec 12 reply (see section 9.2) using the `TELEMETRY_INGEST_TOKEN` bearer. Until the VPS implements that callback, commands will rest at `sent` (delivered) — they will still send/deliver correctly, they just won't show the **Acknowledged** badge with the tracker's response. Confirm the callback works end-to-end (issue a `diagnostic getgps`, watch the row reach `acknowledged`).
* After the **first successful end-to-end test**, rotate `MESHSAT_CMD_TOKEN` **and** the MeshSat map password (`MESHSAT_MAP_AUTH`) — both were shared in plaintext during setup — and update the Coolify variables, then re-run the smoke test.

