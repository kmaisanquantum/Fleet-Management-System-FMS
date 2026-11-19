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
                   │ Webhook HTTP POST →
                   │ https://fleet.dspng.tech/meshsat-relay/webhook
                   │ (nginx → meshsat-relay:6055)
                   ▼
┌──────────────────────────────────────┐
│        MeshSat Relay Service         │
│     (services/meshsat-relay:6055)    │
│  Normalizes Node ID / MAC / Lat / Lon│
└──────────────────┬───────────────────┘
                   │ HTTP POST (x-api-key: TELEMETRY_API_KEY)
                   │ → http://api:4000/api/v1/gps/positions
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

To support machine-to-machine telemetry ingest without requiring user JWT logins, FMS accepts the `x-api-key` header for `POST /api/v1/gps/positions` (`apiKeyOrAuth` in `apps/api/src/middleware/auth.ts`).

* **Header**: `x-api-key: <TELEMETRY_API_KEY>`
* **Config**: `TELEMETRY_API_KEY` must be set to the **same value** on both the `api` service (which validates it) and the `meshsat-relay` service (which sends it) — see the root `.env` / `.env.example`. Generate a strong key with `openssl rand -hex 32`.

---

## 3. Device Registration & Binding (required)

Telemetry is **dropped unless the MeshSat node is bound to a vehicle first.** The ingest endpoint resolves `deviceIdentifier` → `vehicle_id` through the `gps_devices` table; if no matching row exists it returns `400 Unknown device or missing vehicle binding` and nothing appears on the map. Register each MeshSat Node ID or MAC address (e.g. `!12345678` or `00:11:22:33:44:55`) and link it to a `vehicle_id` **before** expecting positions to show. This endpoint requires an authenticated user with an `admin` / `fleet_admin` / `fleet_manager` role, and every change is written to `audit_logs`.

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

## 4. MeshSat Webhook Relay Service

The `services/meshsat-relay` microservice receives raw Meshtastic/MeshSat webhook payloads, normalises them (node ID / MAC + lat / lon / battery / speed / heading), and forwards them to the FMS ingest API. It is deployed as part of the **root** `docker-compose.yml` (service `meshsat-relay`, container `nac-meshsat-relay`).

### Compose service

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
    FMS_URL: http://api:4000            # internal service DNS (no TLS hairpin)
    FMS_API_KEY: ${TELEMETRY_API_KEY}   # same key the API validates
  depends_on:
    - api
```

The relay reaches the API over the compose network at `http://api:4000`, sending the shared `TELEMETRY_API_KEY` as the `x-api-key` header. The `api` service receives the same value via its `TELEMETRY_API_KEY` environment variable.

> The `web` (nginx) service lists `meshsat-relay` in `depends_on`. nginx resolves `proxy_pass` upstream hostnames at startup, so without it nginx fails with *"host not found in upstream 'meshsat-relay'"*.

### Webhook target (via nginx, TLS)

The web container's nginx (`apps/web/infra.nginx.conf`) exposes the relay under the FMS domain so the MeshSat gateway has a stable HTTPS target:

```nginx
location /meshsat-relay/ {
  proxy_pass http://meshsat-relay:6055/;   # trailing slash strips the prefix
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
}
```

The MeshSat gateway webhook URL therefore becomes:

```
https://fleet.dspng.tech/meshsat-relay/webhook
```

Exposing host port `6055` directly also works (e.g. `http://<host>:6055/webhook`), but the nginx route is preferred because it provides TLS. The relay serves `GET /` (service info) and `GET /health` for checks.

### Deployment steps

1. Set the telemetry key in the root `.env`:
   ```env
   TELEMETRY_API_KEY=<strong-random-key>
   ```
2. Build and start the stack (brings up `api`, `web` and `meshsat-relay`):
   ```bash
   docker compose up -d --build
   ```
3. In the MeshSat gateway settings (`meshsat.dspng.space`), set the Webhook URL to
   `https://fleet.dspng.tech/meshsat-relay/webhook`.
4. Register each node's device binding (§3) before expecting positions on the map.

---

## 5. Verification Commands

### Test 1: Direct telemetry ingest to the FMS API

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

Returns `201` only after the device is registered (§3); otherwise `400 Unknown device or missing vehicle binding`.

### Test 2: Relay webhook (end-to-end, as the gateway sends it)

```bash
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
```

Use a current timestamp for `time` in real tests so the position is the newest for the vehicle. On success the relay returns the FMS ingest response. Afterward, confirm a `gps_positions` row exists for the bound vehicle (`GET /api/v1/gps/positions?vehicleId=<id>`, JWT required) and that its marker has moved on the **Live Fleet Map** (`https://fleet.dspng.tech/live-map`).

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
