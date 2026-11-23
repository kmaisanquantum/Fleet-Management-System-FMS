# API Reference

Base URL: `/api/v1`. All endpoints except `/auth/login` and `/auth/refresh`
require `Authorization: Bearer <accessToken>`. For telemetry ingestion (`POST /gps/positions`), machine requests may optionally authenticate using `x-api-key: <TELEMETRY_API_KEY>`. The richer Teltonika FMB125 ingest (`POST /api/telemetry/ingest`, mounted outside the `/api/v1` prefix) authenticates with `Authorization: Bearer <TELEMETRY_INGEST_TOKEN>`.

## Auth — `/api/v1/auth`

| Method | Path | Notes |
|---|---|---|
| POST | `/login` | `{ email, password }` → `{ accessToken, refreshToken, user }` |
| POST | `/refresh` | `{ refreshToken }` → `{ accessToken }` |
| GET | `/me` | Current authenticated user |

## System Settings — `/api/v1/settings`

| Method | Path | Notes |
|---|---|---|
| GET | `/` | List all business rules & settings |
| PUT | `/` | Update business rule values (Admin only; validates value_type and writes audit_logs) |
| GET | `/io-features` | List the configurable Teltonika IO-ID → feature mapping (`io_feature_map`) |
| POST | `/io-features` | Add an IO mapping `{ io_id, feature_key, label, value_type? (event\|scalar\|boolean), enabled?, scale_factor? }` (Admin only). `scale_factor` (default `1`) is the multiplier applied to the raw IO value for unit conversion — the fuel counters (IO 12/13) use `0.001` (millilitres → litres). |
| PUT | `/io-features/:id` | Update an IO mapping, including `scale_factor` (Admin only) |
| DELETE | `/io-features/:id` | Delete an IO mapping (Admin only) |
| GET | `/param-map` | List the configurable Teltonika parameter-ID map (`param_map`) |
| POST | `/param-map` | Add a parameter mapping `{ feature_key, param_id, description? }` (Admin only) |
| PUT | `/param-map/:id` | Update a parameter mapping (Admin only) |
| DELETE | `/param-map/:id` | Delete a parameter mapping (Admin only) |

The IO-feature and parameter maps are editable so that FMB125 Configurator IO/parameter changes require no code rewrite.

## GPS & Telematics — `/api/v1/gps`

| Method | Path | Notes |
|---|---|---|
| POST | `/positions` | Ingest vehicle GPS telemetry `{ vehicleId, deviceIdentifier, lat, lon, speed, heading, ignition, odometer, altitude, battery, source, recordedAt }`. Optional Teltonika FMB125 fields: `ignitionSource`, `movementSource`, `gsmSignal`, `externalVoltage`, `geofenceZoneId`, `tripOdometer`, `fuelLevelPct`, `engineRpm`, `engineHours`, `harshEvent` (`harsh_acceleration` \| `harsh_braking` \| `harsh_cornering` \| `crash`), `driverIdTag`, `io` (raw IO element map). Supports JWT Bearer OR `x-api-key` header. |
| GET | `/latest` | Get latest GPS positions, speed, ignition, altitude, battery, and status for active vehicles (incl. Teltonika GSM signal, fuel level, engine RPM/hours, harsh event, device type) |
| GET | `/positions?vehicleId=` | Get breadcrumb GPS position history for a vehicle |
| GET | `/devices` | List registered GPS telemetry devices and vehicle bindings, filterable by `?deviceType=meshsat\|teltonika` |
| POST | `/devices` | Register or update a GPS device binding (`deviceIdentifier`, `vehicleId`, `status`, `deviceType` = `meshsat` \| `teltonika`, default `meshsat`). Admin/Fleet Manager. |

## Client Telemetry (rich FMB125 JSON) — `/api/telemetry`

Mounted **outside** the `/api/v1` prefix. Used by the MeshSat gateway relay for rich Teltonika FMB125 JSON telemetry (IO elements + fuel) and by the client-facing telemetry pages.

| Method | Path | Notes |
|---|---|---|
| POST | `/ingest` | Ingest one normalized FMB125 record. Auth: `Authorization: Bearer <TELEMETRY_INGEST_TOKEN>` (timing-safe compare). Body: `{ imei, timestamp (ISO-8601), lat, lon, sats, speed_kmh, ignition, fuel_liters, io }`. Resolves the vehicle via `gps_devices.device_identifier = imei` (404 unknown, 400 unbound). Idempotent on `(imei, recorded_at)` → `201` on insert, `200 { duplicate: true }` on duplicate. Each successful insert stamps `vehicles.last_seen_at` (offline watchdog). Interprets IO elements into `fleet_exceptions` alert rows (overspeed 255, idling 251, unplug 252, towing 246, crash 247, geofence 175 / 155–174, immobilizer/DOUT 179, eco driving 253/254, **main-power cut** — external voltage IO 66 below 1000 mV → `power_unplug` / `RULE_MAIN_POWER_CUT`); each row tagged with `type` and `source='telemetry'`; the fuel counter IO 12/13 raw value is kept in `io_json` and echoed as `fuelCounter`. **Fuel fallback:** when `fuel_liters` is null/absent, `fuel_liters` is derived from the fuel counter (IO 12/13) × its `scale_factor` so the column always holds litres (never the raw counter). **Fuel jitter filtering:** a refuel/drain is only raised when the level change is at least the configured threshold — `FUEL_REFUEL_MIN_L` / `FUEL_DRAIN_MIN_L`, both default 5 L; smaller swings are ignored as sensor noise. |
| GET | `/latest` | Per-vehicle latest position, ignition, speed, satellites and fuel, plus `last_seen_at` and a computed `online` boolean (true when last seen within `DEVICE_OFFLINE_MINUTES`, default 15). Client-scoped. |
| GET | `/features/:imei` | Decode the device's latest raw IO payload through `io_feature_map` into the feature grid. Each feature row carries the raw `value`, the row's `scale_factor`, and the engineering-unit `scaled_value` (raw × `scale_factor`; e.g. fuel counter ml → litres, odometer m → km, external voltage mV → V). Features: GNSS Fuel Counter, **Odometer (IO 16, 0.001 m→km)**, **External Voltage (IO 66, 0.001 mV→V)**, **Internal Battery (IO 67, 0.001 mV→V)**, **Ignition (IO 239)**, **Movement (IO 240)**, Overspeeding, Eco/Green Driving, Immobilizer, Network Jamming, iButton Read, DOUT-via-Ignition, Excessive Idling, Unplug, Towing, Crash, Auto/Manual Geofence — plus the latest live state, `last_seen_at` + `online`, and recent `fleet_exceptions` telemetry events. 404 unbound/unknown device; 403 when the device is outside the caller's client scope. Client-scoped. |
| GET | `/summary?from&to` | Fuel consumption (refuelled/consumed), distance, per-vehicle efficiency and the alert/event log over a range. Client-scoped. |
| GET | `/export?format=csv&from&to` | CSV export of position history (max 20 000 rows). Client-scoped. |

Client scoping: fleet/national roles (`admin`, `fleet_admin`, `fleet_manager`, `national_fuel_manager`, `executive`, `auditor`, `finance_officer`, `procurement_officer`) see all clients; a user mapped to one or more clients through the `user_clients` table (e.g. the `client_user` role) sees only vehicles whose `client_id` is in that mapping.

## Device Commands (Teltonika Codec 12) — `/api/telemetry/commands`

Remote configuration/control for FMB125 trackers. All routes require an authenticated JWT with an elevated role (`admin` or `fleet_manager`) — the `client_user` role is **forbidden** (403) — and the target device's vehicle must belong to a client the caller may manage. Commands are queued in `device_commands`, audited, then POSTed to the MeshSat VPS command endpoint (`POST ${MESHSAT_CMD_URL}/api/cmd`, body `{ "imei": "<15-digit>", "command": "<teltonika-cmd>" }`, header `Authorization: Bearer ${MESHSAT_CMD_TOKEN}`), which queues them and delivers over the tracker's next TCP session (5027). Delivery is asynchronous.

The `command` string is the Teltonika form: `setparam <paramId>:<value>` (e.g. `setparam 1580:80`); `setdigout <0|1>` or `setdigout <0|1> <timeout>` (e.g. `setdigout 1`, `setdigout 1 30`); a `diagnostic` status command (`getinfo` \| `getgps` \| `getver` \| `getstatus`); or the raw command for `raw`.

| Method | Path | Notes |
|---|---|---|
| POST | `/` | Queue a command `{ imei, type: 'setparam' \| 'setdigout' \| 'diagnostic' \| 'raw', params, reason?, force? }`. `setparam` resolves `param_id` (or a mapped `feature_key`) via `param_map` and requires `value`; `setdigout` requires `dout` = 0/1 (immobilizer/DOUT1) and accepts an optional non-negative integer `timeout` (emits `setdigout <dout> <timeout>`); `diagnostic` requires `command` ∈ { `getinfo`, `getgps`, `getver`, `getstatus` } — a whitelist only, arbitrary strings are rejected (use `raw` for those); `raw` requires a `command` string. **Ignition-cut safety guard:** an ignition cut (`setdigout` `dout=1`) requires a non-empty `reason` (else `400`); the vehicle's latest reported speed (from `telemetry_records`, falling back to `gps_positions`) is checked and a cut is refused with `409 { error: "Vehicle moving — ignition cut blocked", speed_kmh }` when speed > 10 km/h, unless the caller's role is `admin` **and** `force: true` is set. `reason` is stored on the row and in the audit. Writes `audit_logs` with action `IGNITION_CUT_QUEUED` (setdigout `dout=1`), `IGNITION_RESTORE_QUEUED` (setdigout `dout=0`), or `DEVICE_COMMAND_QUEUED` (everything else); a forced override additionally writes `IGNITION_CUT_FORCED` carrying `speed_kmh`, `reason` and `forced: true`. Each audit `newValue` carries `imei`, `vehicle_id`, the serialized `command`, and `reason`. Endpoint accepts (2xx) → `status='sent'` + `sent_at`; endpoint rejects (non-2xx) or is unreachable → `'failed'` with the error in `response_text`. Response message: "Queued / Pending Next Tracker Sync". |
| POST | `/ack` | **Tracker-reply callback** (registered before JWT auth). Authenticated with `Authorization: Bearer <TELEMETRY_INGEST_TOKEN>` — the same bearer used by `/ingest`. Body `{ imei, command \| cmd, response? \| reply? }`: `command`/`cmd` is the Teltonika command string the tracker acknowledged (e.g. `setparam 1580:80`), `response`/`reply` the tracker's raw reply text. The most recent `device_commands` row for that IMEI with status `sent` whose serialized command matches is set to `status='acknowledged'`, `response_text=reply`, `acked_at=now`. Returns `200` with the updated row, `401` without a valid token, or `404` when no sent command matches. The MeshSat VPS calls this when the FMB125 replies over Codec 12. |
| GET | `/?imei=` | Queue + delivery history (up to 200 rows, newest first), tenant-scoped. |
| POST | `/:id/cancel` | Cancel a still-`queued` command (marks it `failed` with a reason); `409` if already dispatched. Writes `audit_logs`. |

Command statuses: `queued` → `sent` → `acknowledged` (the VPS reports the tracker's Codec 12 reply to `POST /ack`), or `failed`. The legacy `acked` value is still accepted. (With the current VPS contract a forward either succeeds immediately — `sent` — or is marked `failed`; a row remains `queued` only in the brief window before dispatch is attempted.)

**Immobilizer safety.** The web device panel requires an explicit confirmation (a modal showing the vehicle/IMEI, the exact command string, and an immobilization warning, gated behind a confirmation checkbox) plus a typed-in reason before it will dispatch an ignition cut (`setdigout 1`) or restore (`setdigout 0`). The API additionally enforces the server-side guard above (non-empty `reason`; refusal while moving > 10 km/h unless an admin forces it); callers that automate immobilization must supply a `reason` (and, to bypass the speed guard, be an `admin` with `force: true`).

## Fuel Transactions — `/api/v1/fuel-transactions`

| Method | Path | Notes |
|---|---|---|
| GET | `/` | List fuel transactions with `?reconciliationStatus=`, `?source=`, `?startDate=`, `?endDate=` |
| GET | `/:id` | Single transaction detail with linked cards, stations, and exceptions |
| POST | `/` | Ingest fuel transaction, trigger reconciliation service, compute efficiency metrics |
| GET | `/cards` | List fuel cards with assigned vehicles and drivers |
| GET | `/stations` | List fuel stations & depots with GPS coordinates |

## Fleet Overview & Utilisation — `/api/v1/fleet`

| Method | Path | Notes |
|---|---|---|
| GET | `/overview` | Comprehensive dashboard KPI metrics (moving/stationary/idle/offline counts, fuel consumed/cost today, utilisation %, open exceptions) |
| GET | `/utilisation` | Multi-dimensional utilisation analytics (`?startDate=`, `?endDate=`, `?department=`, `?vehicleId=`, `?type=`, `?location=`) |

## Fleet Exceptions — `/api/v1/exceptions`

| Method | Path | Notes |
|---|---|---|
| GET | `/` | List exceptions filtered by `?severity=`, `?category=`, `?status=`, `?vehicleId=`, `?driverId=` |
| GET | `/:id` | Detailed exception record with supporting transaction + GPS position + vehicle + driver |
| PATCH | `/:id` | Update exception status (`open`, `investigating`, `resolved`, `dismissed`), notes, and resolution text. Writes audit_logs. |

## Vehicles & Intelligence — `/api/v1/vehicles`

| Method | Path | Notes |
|---|---|---|
| GET | `/` | List vehicles (`?status=`, `?department=`) |
| GET | `/:id` | Single vehicle details |
| GET | `/:id/intelligence` | Tabbed intelligence profile (profile, operational state, fuel history, service logs, driver allocations, linked exceptions) |
| POST | `/` | Create vehicle |
| PUT | `/:id` | Update vehicle |
| DELETE | `/:id` | Delete vehicle (prevents deletion if foreign key records exist) |

## Driver Intelligence — `/api/v1/driver-intelligence`

| Method | Path | Notes |
|---|---|---|
| GET | `/` | List drivers with safety scores (out of 100), risk ratings, speeding/harsh braking telemetry counts, and driver rankings (`?department=`) |

## Vehicle Maintenance — `/api/v1/vehicle-maintenance`

| Method | Path | Notes |
|---|---|---|
| GET | `/maintenance` | List maintenance records |
| POST | `/maintenance` | Schedule or log maintenance work |
| GET | `/breakdowns` | List reported breakdowns |
| POST | `/breakdowns` | Report breakdown (triggers alert & sets vehicle status to `under_repair`) |
| GET | `/schedules` | Odometer and engine-hours based maintenance triggers (`ok`, `due_soon`, `overdue`) |

## Audit Logs — `/api/v1/audit-logs`
GET `?entity=&entityId=&userId=&limit=` — restricted to admin, auditor, national_fuel_manager, executive.
