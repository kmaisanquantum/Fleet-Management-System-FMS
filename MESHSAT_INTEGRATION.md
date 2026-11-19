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

### Why a same-origin proxy is the supported approach

MeshSat requires authentication before it serves anything. **In the current
deployment the whole MeshSat host is gated by HTTP Basic auth at the Caddy
layer**: every path (`/`, `/map`, `/assets/*`, …) returns

```
HTTP/2 401
www-authenticate: Basic realm="restricted"
server: Caddy
```

with no `Set-Cookie` and no framing headers. A direct cross-site iframe
(`https://fleet.dspng.tech` framing `https://meshsat.dspng.space/map`) therefore
cannot carry the login state:

* **Third-party cookie blocking** — sessions that rely on a `meshsat.dspng.space`
  cookie are dropped inside a cross-site frame (Safari ITP, Firefox Total Cookie
  Protection, Chrome's phase-out; `SameSite=Lax/Strict` cookies are never sent in
  cross-site sub-requests).
* **Basic-auth credential scope** — the browser caches entered Basic credentials
  **per origin**. Credentials typed for `meshsat.dspng.space` are not replayed for
  a frame requested from `fleet.dspng.tech`, so the frame re-triggers the 401
  challenge.

The fix is to serve MeshSat from the **same origin** as FMS via a reverse proxy:

```
https://<fms-host>/meshsat/   ->   https://meshsat.dspng.space/
```

The iframe then loads same-origin, so the browser replays the Basic credentials
(and any cookie) it holds for the FMS origin inside the frame, and — because the
frame is same-origin — the FMS page can even inspect it to detect a login screen
(see "Iframe diagnostics" below).

A second, related blocker is framing headers: if MeshSat ever sends
`X-Frame-Options: DENY` or a `Content-Security-Policy` without a `frame-ancestors`
that allows the FMS origin, browsers refuse to render the frame at all. The proxy
strips those and re-adds an allow-listing CSP.

### Alternative: configure MeshSat to accept cross-site embedding

If MeshSat's own server can be reconfigured instead of proxying, it must:

1. Send `SameSite=None; Secure` on its session cookie so it survives in a
   cross-site frame, and
2. Allow framing from the FMS origin — drop `X-Frame-Options` and set
   `Content-Security-Policy: frame-ancestors https://<fms-host>`.

Limitations (why the proxy is preferred):

* **Incognito / Safari / Firefox** block third-party cookies outright, so a
  `SameSite=None` cookie is still not sent inside a cross-site iframe — the
  embedded view will show the login page there regardless.
* It requires control of the MeshSat server (Caddy `header` / `basicauth`
  config), whereas the proxy is entirely on the FMS side.
* The Basic-auth credential-scope problem is **not** solved by `SameSite` at all;
  the proxy (same origin) is the only way to have the browser replay credentials
  inside the frame.

### If MeshSat cannot run under a subpath

If MeshSat's frontend emits **absolute** asset/API paths (`/assets/…`, `/api/…`)
or absolute origin URLs, it will break under `/meshsat/`. Options, in order of
preference:

1. Add response rewriting in the proxy (see the commented `sub_filter` block in
   `infra.nginx.conf`; requires `ngx_http_sub_module`, present in the official
   nginx image) to map those paths under `/meshsat/`.
2. Serve MeshSat at the **root of a dedicated subdomain on the same parent
   domain** (e.g. `meshsat-fms.dspng.tech`) and iframe that — it is still
   same-*site* as `fleet.dspng.tech` for cookie purposes, but assets load from a
   root path.

> Note: the real asset paths could not be verified during setup because every
> MeshSat path sits behind the 401 Basic-auth wall. Inspect them (after
> authenticating) before enabling `sub_filter` rules.

### Nginx reverse proxy (web container)

The web container's nginx config (`apps/web/infra.nginx.conf`) contains a
`location /meshsat/` block that proxies MeshSat, forwards the `Authorization`
header, rewrites `Set-Cookie` onto the FMS host/path, rewrites redirects back
under `/meshsat/`, and strips/rewrites the framing headers:

```nginx
location /meshsat/ {
  proxy_pass https://meshsat.dspng.space/;   # trailing slash strips the /meshsat/ prefix
  proxy_set_header Host meshsat.dspng.space;
  proxy_ssl_server_name on;
  proxy_ssl_name meshsat.dspng.space;
  # (client Authorization / Basic header is forwarded by default)

  # Rewrite redirects back under /meshsat/.
  proxy_redirect / /meshsat/;
  proxy_redirect https://meshsat.dspng.space/ /meshsat/;

  # First-party cookie: move MeshSat's cookie onto the FMS host, scoped to /meshsat/.
  proxy_cookie_domain meshsat.dspng.space $host;
  proxy_cookie_path / /meshsat/;

  # Allow framing from the FMS origin.
  proxy_hide_header X-Frame-Options;
  proxy_hide_header Content-Security-Policy;
  add_header Content-Security-Policy "frame-ancestors 'self'" always;
}
```

Notes:
- TLS for `fleet.dspng.tech` is terminated upstream (Coolify/Traefik); this nginx
  block listens on the container's port 80 and is reached through that proxy. The
  proxied leg to MeshSat is HTTPS end-to-end.
- `frame-ancestors 'self'` is sufficient because the frame is served from the FMS
  origin itself.
- Stock nginx cannot edit a single CSP directive in place, so the upstream
  `Content-Security-Policy` is **replaced** rather than merged. If MeshSat later
  depends on a strict CSP, use the `headers-more` module to remove only the
  `frame-ancestors` directive instead.
- `proxy_cookie_domain`/`proxy_cookie_path` only rewrite cookies that carry a
  `Domain`/`Path` attribute; they are a no-op while MeshSat uses Basic auth only.

### Build environment

Set the iframe URL to the **same-origin proxied path** — never the raw MeshSat
host. A relative URL resolves against whatever origin the app is served from:

```env
VITE_MESHSAT_MAP_URL=/meshsat/map
```

This value is set in `apps/web/.env.example` and `apps/web/.env.production`, and
is also the code fallback default in `LiveFleetMap.tsx`. The direct
`https://meshsat.dspng.space/map` URL only works if MeshSat allows framing **and**
the browser allows third-party cookies (i.e. not Safari/Firefox/Incognito).

### Iframe diagnostics (fallback instead of a blank box)

The MeshSat tab shows an **"Open MeshSat in new tab"** link next to the frame at
all times. Because the proxied frame is same-origin, `LiveFleetMap.tsx` also
inspects it on `onLoad`: if it detects a MeshSat login form (a password field /
"sign in" text) or an empty document (a 401 challenge), or if the frame never
loads within 10 seconds, it shows a fallback message — "MeshSat map is not
responding — it may require login or be unreachable" — with the open-in-new-tab
link and a **Retry** button, rather than a silent blank iframe.

### Verification

1. Deploy the web container with the updated `infra.nginx.conf` and rebuild the
   frontend so `VITE_MESHSAT_MAP_URL` is baked in.
2. In a normal browser, open `https://fleet.dspng.tech/meshsat/map` directly —
   confirm MeshSat loads and (if required) authenticate **through this path** so
   the credentials are cached for the FMS origin.
3. Open the FMS **Live Fleet Map → MeshSat Mesh Map** tab and confirm the map
   renders inside the iframe (not the login page or a blank box). DevTools →
   Network should show `200` (not `401`) for `/meshsat/map` and its sub-resources,
   with **no** `X-Frame-Options` / `frame-ancestors` console errors.

### Default Map Center & Zoom Configuration

Note: MeshSat's frontend map interface (`/map`) does not accept URL parameters (`lat`, `lon`, `zoom`, `center`) to override the initial map view position. By default, MeshSat serves a map view centered over Europe.

Because the FMS fleet operates in Papua New Guinea (PNG / National Capital District / Port Moresby, approx `lat: -9.4438`, `lon: 147.1803`), the default map coordinates and zoom level must be configured directly on the MeshSat gateway instance / VPS UI/settings itself so that embedded iframe views serve Papua New Guinea upon loading.
