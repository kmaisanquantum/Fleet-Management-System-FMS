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

### Why same-domain reverse proxying is required (third-party cookies)

MeshSat requires a logged-in session. Its session cookie is issued for the
`meshsat.dspng.space` domain. When the map is embedded **directly** in an iframe
on `https://fleet.dspng.tech`, that cookie is a **third-party cookie** (the
iframe's site differs from the top-level page's site). Modern browsers isolate
third-party cookies by default (Safari ITP, Firefox Total Cookie Protection,
Chrome's phase-out) and `SameSite=Lax/Strict` cookies are not sent in
cross-site sub-requests — so the cookie is **never sent inside the iframe**.
MeshSat then responds with its login page (or a blank frame) even though the
user is already signed in. This is a browser cookie-isolation rule, not an FMS
bug.

The fix is to serve MeshSat from the **same site** as FMS via a reverse proxy:
`https://fleet.dspng.tech/meshsat/` → `https://meshsat.dspng.space/`. The iframe
then loads from the same origin, the session cookie becomes **first-party** and
is sent normally, and — because the frame is same-origin — the FMS page can even
inspect it to detect a login screen (see "Iframe diagnostics" below).

A second, related blocker is framing headers: if MeshSat sends
`X-Frame-Options: DENY` or a `Content-Security-Policy` without
`frame-ancestors https://fleet.dspng.tech`, browsers refuse to render the frame
at all. The proxy strips those and re-adds an allow-listing CSP.

### Nginx reverse proxy (web container)

The web container's nginx config (`apps/web/infra.nginx.conf`) contains a
`location /meshsat/` block that proxies MeshSat, rewrites `Set-Cookie` onto the
FMS host/path, and strips/rewrites the framing headers:

```nginx
location /meshsat/ {
  proxy_pass https://meshsat.dspng.space/;   # trailing slash strips the /meshsat/ prefix
  proxy_set_header Host meshsat.dspng.space;
  proxy_ssl_server_name on;
  proxy_ssl_name meshsat.dspng.space;

  # First-party cookie: move MeshSat's session cookie onto fleet.dspng.tech
  # and scope it to /meshsat/.
  proxy_cookie_domain ~.* $host;
  proxy_cookie_path ~.* /meshsat/;

  # Allow framing from the FMS origin.
  proxy_hide_header X-Frame-Options;
  proxy_hide_header Content-Security-Policy;
  add_header Content-Security-Policy "frame-ancestors 'self' https://fleet.dspng.tech https://*.dspng.tech;" always;
}
```

Notes:
- TLS for `fleet.dspng.tech` is terminated upstream (Coolify/Traefik); this
  nginx block listens on the container's port 80 and is reached through that
  proxy. The proxied leg to MeshSat is HTTPS end-to-end.
- Stock nginx cannot edit a single CSP directive in place, so the upstream
  `Content-Security-Policy` is **replaced** rather than merged. If MeshSat later
  depends on a strict CSP, use the `headers-more` module to remove only the
  `frame-ancestors` directive instead.
- `proxy_cookie_domain`/`proxy_cookie_path` only rewrite cookies that carry a
  `Domain`/`Path` attribute; host-only cookies are already scoped to
  `fleet.dspng.tech` by the browser.

### Build environment

Set the iframe URL to the **proxied** path — never the raw MeshSat host:

```env
VITE_MESHSAT_MAP_URL=https://fleet.dspng.tech/meshsat/map
```

This value is set in `apps/web/.env.example` and `apps/web/.env.production`, and
is also the code fallback default in `LiveFleetMap.tsx`, so no environment needs
to ship the raw `https://meshsat.dspng.space/map` URL.

### Iframe diagnostics (fallback instead of a blank box)

Because the proxied frame is same-origin, `LiveFleetMap.tsx` inspects it on
`onLoad`. If it detects a MeshSat login form (a password field / "sign in"
text) or if the frame never loads within 12 seconds, the MeshSat tab shows a
fallback message with an **"Open MeshSat in new tab"** link (pointing at the
proxied URL) and a **Retry** button, rather than a silent blank iframe.

### Verification

1. Deploy the web container with the updated `infra.nginx.conf` and rebuild the
   frontend so `VITE_MESHSAT_MAP_URL` is baked in.
2. In a normal browser, open `https://fleet.dspng.tech/meshsat/map` directly —
   confirm MeshSat loads and (if required) log in **through this path** so the
   session cookie is stored on `fleet.dspng.tech`.
3. Open the FMS **Live Fleet Map → MeshSat Mesh Map** tab and confirm the map
   renders inside the iframe (not the login page or a blank box). DevTools →
   Application → Cookies should show the MeshSat session cookie with a
   `fleet.dspng.tech` / `/meshsat` scope.

### Default Map Center & Zoom Configuration

Note: MeshSat's frontend map interface (`/map`) does not accept URL parameters (`lat`, `lon`, `zoom`, `center`) to override the initial map view position. By default, MeshSat serves a map view centered over Europe.

Because the FMS fleet operates in Papua New Guinea (PNG / National Capital District / Port Moresby, approx `lat: -9.4438`, `lon: 147.1803`), the default map coordinates and zoom level must be configured directly on the MeshSat gateway instance / VPS UI/settings itself so that embedded iframe views serve Papua New Guinea upon loading.
