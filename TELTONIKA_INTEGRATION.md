# Teltonika FMB125 Telemetry Integration Guide

This document outlines the architecture, configuration, and deployment procedures for connecting **Teltonika FMB125** trackers (IMEI-keyed, AVL Codec 8 / Codec 8 Extended over TCP) to the **Fleet Management System (FMS)** at `https://fleet.dspng.tech` for live vehicle tracking on the Live Fleet Map. It runs alongside the existing [MeshSat pipeline](./MESHSAT_INTEGRATION.md).

---

## 1. Architecture Overview

```
┌──────────────────────────────────────┐
│        Teltonika FMB125 Device       │
│  GNSS + GSM/GPRS, OBD/CAN, IO, ACC   │
│  (IMEI e.g. 354018115690145)         │
└──────────────────┬───────────────────┘
                   │ Raw TCP, AVL Codec 8 / 8E
                   │ IMEI handshake → 0x01, AVL array → record-count ACK
                   ▼
┌──────────────────────────────────────┐
│      Teltonika Relay Service         │
│   (services/teltonika-relay:6056)    │
│   Decodes AVL, maps IO → FMS fields  │
│   HTTP health endpoint on :6057      │
└──────────────────┬───────────────────┘
                   │ HTTP POST (x-api-key: TELEMETRY_API_KEY)
                   │ {FMS_URL}/api/v1/gps/positions
                   ▼
┌──────────────────────────────────────┐
│         FMS Ingest API               │
│   (POST /api/v1/gps/positions)       │
│  Updates Vehicles Live-State Cache   │
│  Safety events + geofence exceptions │
└──────────────────┬───────────────────┘
                   │ WebSocket / REST Polling
                   ▼
┌──────────────────────────────────────┐
│           Live Fleet Map             │
│        (https://fleet.dspng.tech)    │
└──────────────────────────────────────┘
```

The relay is a thin, stateless translator: it never stores telemetry, it decodes each AVL record and immediately forwards it to the FMS ingest endpoint, which is the single source of truth for all telemetry sources (MeshSat and Teltonika).

---

## 2. Ingest Authentication (`x-api-key`)

To support machine-to-machine telemetry ingest without requiring user JWT logins, FMS accepts the `x-api-key` header for `POST /api/v1/gps/positions`.

* **Header**: `x-api-key: <TELEMETRY_API_KEY>`
* **Config**: Set `TELEMETRY_API_KEY` in `apps/api/.env`. The relay reads the same value from `FMS_API_KEY`, so both telemetry relays share one key.

---

## 3. Device Registration & Binding

Before telemetry for an FMB125 is mapped to a vehicle, its IMEI (e.g. `354018115690145`) must be registered and linked to a `vehicle_id`. No API change is required — the IMEI is used directly as the `deviceIdentifier`, exactly like a MeshSat node id. Set `deviceType` to `teltonika` (default is `meshsat`) so the device can be filtered in the UI and API.

### Register/Link the FMB125 via the FMS API

```bash
curl -X POST https://fleet.dspng.tech/api/v1/gps/devices \
  -H "Authorization: Bearer <ADMIN_JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceIdentifier": "354018115690145",
    "vehicleId": "v-101-uuid-here",
    "deviceType": "teltonika",
    "status": "active"
  }'
```

List only Teltonika devices:

```bash
curl "https://fleet.dspng.tech/api/v1/gps/devices?deviceType=teltonika" \
  -H "Authorization: Bearer <ADMIN_JWT_TOKEN>"
```

---

## 4. Teltonika Relay Service Setup

The `services/teltonika-relay` microservice listens for raw Teltonika AVL TCP connections, decodes Codec 8 / Codec 8 Extended packets, and forwards each record to FMS.

### Deployment Steps

1. **Configure Environment (`.env`)**:
   ```env
   PORT=6056
   HEALTH_PORT=6057
   FMS_URL=https://fleet.dspng.tech
   FMS_API_KEY=dev-telemetry-key-12345
   ```

2. **Run with Docker Compose**:
   ```bash
   cd services/teltonika-relay
   docker compose up -d --build
   ```

   Or, from the repository root, the service is also wired into the main `docker-compose.yml`:
   ```bash
   docker compose up -d teltonika-relay
   ```

3. **Expose the TCP port**: The FMB125 connects outbound to the relay host on port `6056`. Ensure this port is reachable from the device's GPRS network (open the firewall / security group on the relay host). Port `6057` serves an HTTP health check (`GET /health`) and does **not** need to be public.

---

## 5. FMB125 Configurator Settings

In the Teltonika **Configurator** desktop tool (or FOTA Web), configure the GPRS and Data Acquisition sections to match the relay. Key settings:

### GPRS (Network) Tab

| Setting | Value |
|---|---|
| APN (Operator) | Your SIM's carrier APN (e.g. the carrier-provided APN string) |
| APN Username / Password | Carrier credentials if required |
| Server Domain / IP | `fleet.dspng.tech` (or the relay host's public IP) |
| Server Port | `6056` |
| Protocol | `TCP` |
| Data Send / Codec | **Codec 8 Extended** |

### Data Acquisition Tab

| Setting | Value |
|---|---|
| Records without time sync | **After Time Sync** (device sends only once it has a valid GNSS time fix) |
| Data acquisition / sending period | Set a sensible live-tracking period (e.g. ignition ON: short periodic interval; ignition OFF: longer interval) |
| Ignition source | Match the vehicle wiring (DIN/ACC) — reported in IO 239 |
| Movement source | GNSS / accelerometer — reported in IO 240 |

> **Screenshot mapping**: the FMB125 configurator screenshots in the integration ticket show the GPRS APN block, the server `fleet.dspng.tech` / port `6056` entry, Codec 8 Extended selected, the acquisition periods under Data Acquisition, and "Records without time sync" set to **After Time Sync**. Reproduce those exact values so the device handshakes and streams to the relay.

### IO / Feature Activation

Enable the following so the relay can surface the matching FMS fields:

* **Ignition (239)** and **Movement (240)** sources.
* **Geofence zones (155/156)** — enable geofencing in the Configurator so IO 155/156 carry the current zone id (0 = outside all zones).
* **OBD/CAN data** — enable OBD II / CAN adapters for fuel level (30/81), engine RPM (36) and engine hours (1023).
* **Accelerometer / eco-driving** — enable harsh acceleration/braking/cornering (248/249/250) and crash detection (247).
* **BLE / 1-Wire** — pair a BLE beacon or iButton for driver identification (IO 385 / 78).

---

## 6. IO Element → FMS Field Mapping

The relay maps raw AVL IO elements onto FMS telemetry fields before forwarding. Odometer values are reported by the FMB125 in metres and converted to kilometres.

| IO id | Meaning | FMS field (`/api/v1/gps/positions`) |
|---|---|---|
| 239 | Ignition | `ignition`, `ignitionSource = "io_239"` |
| 240 | Movement | `movementSource = "io_240"` |
| 21 | GSM signal level | `gsmSignal` |
| 16 | Total odometer (metres) | `odometer` (km) |
| 389 | Trip odometer (metres) | `tripOdometer` (km) |
| 67 / 113 | Battery voltage / level | `battery` |
| 66 | External voltage (mV) | `externalVoltage` |
| 155 / 156 | Geofence zone id | `geofenceZoneId`, `geofenceStatus` (`0` → `exit`) |
| 247 | Crash event | `harshEvent = "crash"` |
| 248 | Harsh acceleration | `harshEvent = "harsh_acceleration"` |
| 249 | Harsh braking | `harshEvent = "harsh_braking"` |
| 250 | Harsh cornering | `harshEvent = "harsh_cornering"` |
| 30 / 81 | Fuel level (analog / CAN) | `fuelLevelPct` |
| 36 | Engine RPM | `engineRpm` |
| 1023 | Engine hours | `engineHours` |
| 78 / 385 | iButton / BLE driver id | `driverIdTag` |

All raw IO elements are also forwarded in the `io` object for downstream analysis and are persisted in `gps_positions.io_json`.

### Downstream Effects in FMS

* **`harshEvent`** inserts a row into `driver_events` (`harsh_accel` / `harsh_braking` / `harsh_cornering` / `crash`) so it counts toward driver safety scores.
* **`fuelLevelPct` / `engineHours`** update the vehicle live-state cache (`vehicles.current_fuel_level_pct`, `vehicles.current_engine_hours`) used by fuel reconciliation and maintenance scheduling.
* **`geofenceStatus` exit** creates a `fleet_exceptions` row (severity `warning`, category `geofence`, rule `RULE_GEOFENCE_EXIT`) plus an audit log entry.

---

## 7. Verification Commands

### Test 1: Direct Telemetry Ingest to FMS API

```bash
curl -X POST https://fleet.dspng.tech/api/v1/gps/positions \
  -H "x-api-key: dev-telemetry-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceIdentifier": "354018115690145",
    "lat": -9.4438,
    "lon": 147.1803,
    "speed": 45.0,
    "heading": 180,
    "ignition": 1,
    "odometer": 50400.0,
    "altitude": 52.0,
    "battery": 92.0,
    "source": "teltonika",
    "gsmSignal": 5,
    "externalVoltage": 24000,
    "tripOdometer": 123.4,
    "geofenceZoneId": "0",
    "geofenceStatus": "exit",
    "fuelLevelPct": 68.0,
    "engineRpm": 2100,
    "engineHours": 812.0,
    "driverIdTag": "458921",
    "harshEvent": "harsh_braking",
    "io": { "239": 1, "240": 1, "249": 9 }
  }'
```

### Test 2: Send a Raw AVL Packet to the Relay over TCP

Send a captured/known-good AVL payload with `nc` (or use the relay's Vitest suite: `npm test` in `services/teltonika-relay`). The relay must reply `0x01` to the IMEI handshake and a 4-byte record count after the data packet.

```bash
# IMEI handshake: 2-byte big-endian length + ASCII IMEI, then the AVL packet bytes.
printf '\x00\x0f354018115690145' | nc -N <relay-host> 6056
```

### Test 3: Relay Health Check

```bash
curl http://<relay-host>:6057/health
# → { "status": "ok", "service": "Teltonika FMS Telemetry Relay", ... }
```

Upon sending test packets, verify the corresponding vehicle moves live on the **Live Fleet Map** (`https://fleet.dspng.tech/live-map`), with the Teltonika source badge and Teltonika-specific telemetry (GSM signal, battery/external voltage, fuel level, harsh-driving indicators) shown in the vehicle popup.

---

## 8. Live Fleet Map Teltonika Integration

The Live Fleet Map (`apps/web/src/pages/LiveFleetMap.tsx`) renders the FMS telematics map (Leaflet) with live vehicle markers. Both MeshSat and Teltonika telemetry flow through the same ingest endpoint and appear identically as moving markers.

When a vehicle's latest position comes from a Teltonika device, its popup/detail additionally shows:

* A **source badge** distinguishing **MeshSat** vs **Teltonika** (derived from `gps_devices.device_type`).
* **GSM signal** (`gsm_signal`).
* **Battery** (`battery_pct`) and **external voltage** (`external_voltage_mv`, shown in volts).
* **Fuel level** (`fuel_level_pct`) and **engine RPM / hours** when OBD/CAN data is present.
* **Trip odometer** and **geofence zone** when provided.
* **Harsh-driving event** indicator (`harsh_event`) when the latest record carried an accelerometer event.

### Default Map Center & Zoom Configuration

Because the FMS fleet operates in Papua New Guinea (PNG / National Capital District / Port Moresby, approx `lat: -9.4438`, `lon: 147.1803`), the Live Fleet Map defaults to those coordinates whenever no vehicle currently has a GPS fix.
