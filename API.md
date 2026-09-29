# API Reference

Base URL: `/api/v1`. All endpoints except `/auth/login` and `/auth/refresh`
require `Authorization: Bearer <accessToken>`. For telemetry ingestion (`POST /gps/positions`), machine requests may optionally authenticate using `x-api-key: <TELEMETRY_API_KEY>`.

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
| POST | `/positions` | Ingest vehicle GPS telemetry `{ vehicleId, deviceIdentifier, lat, lon, speed, heading, ignition, odometer, altitude, battery, source, recordedAt }`. Supports JWT Bearer OR `x-api-key` header. |
| GET | `/latest` | Get latest GPS positions, speed, ignition, altitude, battery, and status for active vehicles |
| GET | `/positions?vehicleId=` | Get breadcrumb GPS position history for a vehicle |
| GET | `/devices` | List registered GPS/MeshSat telemetry devices and vehicle bindings |
| POST | `/devices` | Register or update a GPS device binding (`deviceIdentifier`, `vehicleId`, `status`). Admin/Fleet Manager. |

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
