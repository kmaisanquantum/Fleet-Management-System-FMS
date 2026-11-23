# IoT Integration

## Target architecture (spec section 21)

```mermaid
flowchart LR
    SENSOR[IoT Sensor<br/>level / flow / temp / water / GPS] --> MQTT[MQTT]
    MQTT --> GW[IoT Gateway]
    GW --> BROKER[Message Broker]
    BROKER --> TELEMETRY[Telemetry Service]
    TELEMETRY --> NAFMS[Fleet Management System]
```

Future sensor types: tank level sensors, flow meters, temperature sensors,
water detection, GPS (for mobile refuellers), RFID (asset tracking), and
eventual PLC/SCADA integration at larger fuel farms.

## What's built in this MVP

`iot_devices` and `iot_readings` tables, plus:

- `GET /api/v1/iot/devices?airportId=` — registered devices
- `POST /api/v1/iot/devices` — register a device against a tank or refueller
- `GET /api/v1/iot/devices/:id/readings` — recent readings
- `POST /api/v1/iot/readings` — **simulated** ingest endpoint

The seed script (`apps/api/src/seed/seed.ts`) registers a handful of
`level_sensor` devices and generates simulated historical readings, so the
data model and read paths can be exercised end-to-end today.

## What's explicitly not built

`POST /iot/readings` stands in for the Telemetry Service's write path. A
real deployment would **not** expose a public POST endpoint for sensor
data — it would run an MQTT broker (e.g. Mosquitto or a managed IoT Core
service), a gateway process subscribing to sensor topics, and a telemetry
service that validates and writes readings server-side, with sensors never
talking to the REST API directly. This is flagged as
`TODO / FUTURE INTEGRATION` directly in the route source
(`apps/api/src/routes/iot.ts`) and in the IoT Devices screen in the web app.

## Why simulate rather than build the full pipeline

Standing up MQTT infrastructure, device provisioning/auth, and a telemetry
ingestion service is a substantial, mostly infrastructure-shaped project
independent of the fuel-management business logic this MVP is proving out.
Simulating readings at the data layer lets every downstream consumer —
tank dashboards, the low-stock alerting logic, future predictive
maintenance — be built and tested against realistic data now, with the
actual ingestion pipeline swappable in later without changing anything
above the `iot_readings` table.

## Fleet telematics (Teltonika FMB125)

Vehicle GPS/AVL telemetry is a separate, already-built pipeline from the
fuel-sensor IoT above. Teltonika FMB125 trackers forward rich JSON (GNSS +
AVL IO element map) to the FMS ingest endpoint
`POST /api/telemetry/ingest`, authenticated with
`Authorization: Bearer <TELEMETRY_INGEST_TOKEN>`. The endpoint resolves the
device IMEI to a vehicle, stores the position idempotently, interprets IO
elements into `fleet_exceptions` alerts (overspeed, idling, unplug, towing,
crash, geofence, immobilizer, eco driving) and derives refuel/drain events
from fuel-level deltas.

See `MESHSAT_INTEGRATION.md` section 8 for the full endpoint contract, IO
mapping table, and device-registration steps, and `API.md` for the
client-scoped read/report endpoints (`/api/telemetry/latest`,
`/summary`, `/export`).

**Fuel fallback.** When a fix does not carry an explicit `fuel_liters`, the
ingest derives it from the fuel counter (IO 12/13) so the `fuel_liters` column
always holds litres: `fuel_liters = raw_counter × scale_factor`. The raw counter
is never stored as `fuel_liters` (it stays in `io_json` for diagnostics).

### IO-ID → feature map (`io_feature_map`)

The device's raw IO element map is decoded through a configurable
`io_feature_map` (admin-editable via `GET/POST/PUT/DELETE /api/v1/settings/io-features`,
surface in the Settings page). Each row has a `scale_factor` (default `1`)
multiplied into the raw value for engineering-unit display and the fuel
fallback, a `device_model` scope (**`NULL` = all tracker models**), and a
`unit` label. Defaults seeded on first run:

| IO ID | Feature key | Label | Type | Scale factor | Unit | Device model |
|---|---|---|---|---|---|---|
| 12 | `fuel_counter` | GNSS Fuel Counter (primary) | scalar | `0.001` (ml → L) | L | all (`NULL`) |
| 13 | `fuel_counter` | GNSS Fuel Counter (secondary) | scalar | `0.001` (ml → L) | L | all (`NULL`) |
| 16 | `odometer` | Total Odometer | scalar | `0.001` (m → km) | km | all (`NULL`) |
| 66 | `external_voltage` | External (main) power voltage | scalar | `0.001` (mV → V) | V | all (`NULL`) |
| 67 | `internal_battery` | Internal battery voltage | scalar | `0.001` (mV → V) | V | all (`NULL`) |
| 78 | `ibutton` | iButton / Driver ID Read | scalar | 1 | — | all (`NULL`) |
| 239 | `ignition` | Ignition | boolean | 1 | — | all (`NULL`) |
| 240 | `movement` | Movement | boolean | 1 | — | all (`NULL`) |
| 255 | `overspeed` | Overspeeding | event | 1 | — | all (`NULL`) |
| 253 | `eco_accel` | Eco Driving — Harsh Acceleration | event | 1 | — | all (`NULL`) |
| 254 | `eco_brake` | Eco Driving — Harsh Braking | event | 1 | — | all (`NULL`) |
| 251 | `idling` | Excessive Idling | event | 1 | — | all (`NULL`) |
| 252 | `power_unplug` | Power Unplug / Tamper | event | 1 | — | all (`NULL`) |
| 246 | `towing` | Towing Detected | event | 1 | — | all (`NULL`) |
| 247 | `crash` | Crash Detection | event | 1 | — | all (`NULL`) |
| 175 | `geofence_auto` | Auto / Manual Geofence | event | 1 | — | all (`NULL`) |
| 174 | `geofence_zone` | Geofence Zone Event (IO 155–174) | event | 1 | — | all (`NULL`) |
| 179 | `immobilizer` | DOUT1 / Immobilizer | boolean | 1 | — | all (`NULL`) |
| 179 | `dout_ignition` | DOUT Driven by Ignition | boolean | 1 | — | all (`NULL`) |
| 249 | `jamming` | Network Jamming | event | 1 | — | all (`NULL`) |

`GET /api/telemetry/features/:imei` returns each feature with its latest raw
`value`, the row's `scale_factor`, and the scaled `scaled_value` (raw × factor)
alongside recent telemetry events. Because the mapping lives in the database,
changing the FMB125 Configurator IO assignment (or adding a new element) needs
no code change — add/edit the row instead; `device_model` lets a row apply to
one tracker model only (`NULL` = all).

### Device profiles & capabilities (`gps_devices`)

Each `gps_devices` row carries a `device_model` (default `FMB125`) and a
`capabilities` JSON blob — `{ has_fuel_rs232, has_can_j1939, has_ble_sensors,
has_camera, dout_count }` — so the UI can render capability-driven panels. The
seed binds both production IMEIs (`354018115690145`, `354018115694907`) as
`FMB125` with `dout_count = 2`. `GET /api/telemetry/features/:imei` returns the
parsed `device_model` and `capabilities`. `gps_devices.last_seen_at` tracks the
last successful ingest per device.

### Camera / media captures (`device_media`)

Camera and sensor captures are recorded in `device_media` (trigger type, camera
channel, media type, storage URL, capture time, metadata) keyed by device and
resolved to the vehicle/client like telemetry. The relay posts them to
`POST /api/telemetry/media` (Bearer ingest token) and the device panel's
**Camera / Media** tab lists them via `GET /api/telemetry/media?imei=`.

### Parameter-ID map (`param_map`)

Remote `setparam` commands reference a Teltonika parameter ID resolved through
the configurable `param_map` (admin-editable via `/api/v1/settings/param-map`).
Defaults seeded on first run:

| Feature key | Param ID | Description |
|---|---|---|
| `overspeed_threshold` | 1580 | Overspeeding threshold (km/h) |
| `idling_timeout` | 1581 | Excessive idling timeout (seconds) |
| `eco_driving_threshold` | 1582 | Eco (green) driving sensitivity |
| `geofence_radius` | 2051 | Auto geofence radius (metres) |
| `immobilizer_dout` | 1028 | DOUT1 / immobiliser control |

### Remote configuration & control (Codec 12)

Users with an elevated role (`admin` or `fleet_manager`; `client_user` is
read-only) can push Codec-12 commands (`setparam`, `setdigout`, `diagnostic`,
`camreq`, `raw`) to a tracker through `POST /api/telemetry/commands`. A
`setdigout` targets a DOUT relay (`dout_index`, default 1) and optionally a
pulse `timeout` — serialized as `setdigout <dout> <dout_index> [timeout]` — and
`diagnostic` accepts the whitelist `getinfo` / `getgps` / `getver` / `getstatus`
/ `readio`. Commands are queued in `device_commands` and POSTed to the MeshSat
VPS command endpoint
(`https://meshsat.dspng.space/api/cmd`, `Authorization: Bearer $MESHSAT_CMD_TOKEN`)
for delivery over the tracker's next TCP session (5027).
See `MESHSAT_INTEGRATION.md` section 9 for the command flow.
