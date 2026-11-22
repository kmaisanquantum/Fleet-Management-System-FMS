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
| POST | `/ingest` | Ingest one normalized FMB125 record. Auth: `Authorization: Bearer <TELEMETRY_INGEST_TOKEN>` (timing-safe compare). Body: `{ imei, timestamp (ISO-8601), lat, lon, sats, speed_kmh, ignition, fuel_liters, io }`. Resolves the vehicle via `gps_devices.device_identifier = imei` (404 unknown, 400 unbound). Idempotent on `(imei, recorded_at)` → `201` on insert, `200 { duplicate: true }` on duplicate. Interprets IO elements into `fleet_exceptions` alert rows (overspeed 255, idling 251, unplug 252, towing 246, crash 247, geofence 175 / 155–174, immobilizer/DOUT 179, eco driving 253/254) — each row tagged with `type` and `source='telemetry'`; fuel counter IO 12/13 is stored raw in `io_json` and echoed as `fuelCounter`; refuel/drain is detected from fuel-level deltas. |
| GET | `/latest` | Per-vehicle latest position, ignition, speed, satellites and fuel. Client-scoped. |
| GET | `/summary?from&to` | Fuel consumption (refuelled/consumed), distance, per-vehicle efficiency and the alert/event log over a range. Client-scoped. |
| GET | `/export?format=csv&from&to` | CSV export of position history (max 20 000 rows). Client-scoped. |

Client scoping: fleet/national roles (`admin`, `fleet_admin`, `fleet_manager`, `national_fuel_manager`, `executive`, `auditor`, `finance_officer`, `procurement_officer`) see all clients; a user mapped to one or more clients through the `user_clients` table (e.g. the `client_user` role) sees only vehicles whose `client_id` is in that mapping.

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
