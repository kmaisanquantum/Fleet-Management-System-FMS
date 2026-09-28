# Fleet Management System & Fleet Intelligence Extension

A comprehensive Fleet & Operations Management Platform prototype featuring automated GPS telematics integration, rule-based fuel card reconciliation, driver intelligence, and multi-dimensional utilisation analytics.

> **Prototype / design disclaimer** — this is a software prototype and MVP. All seed data is fictional — **DEMO / NOT REAL DATA**.

## What this is

An end-to-end digital fleet management chain covering:

```
Vehicle & Driver Register → GPS Telematics → Fuel Card / Depot Ingest →
Rule Engine Reconciliation → Exception Centre → Maintenance Scheduling →
Utilisation & Driver Safety Analytics
```

## Quick start (local dev)

Requires Node.js 20+.

```bash
# 1. Install dependencies & run API (SQLite-backed for zero-infra local dev)
npm install
npm --prefix apps/api run seed     # loads realistic fictional demo data
npm --prefix apps/api run dev      # http://localhost:4000

# 2. Run web app
npm --prefix apps/web run dev      # http://localhost:5173
```

Log in with the seeded demo account:

```
email:    admin@dspng.tech
password: Admin@2026
```

## Fleet Intelligence Extension Features

- **GPS Telematics Ingest**: Telemetry endpoint (`POST /api/v1/gps/positions`) capturing speed, heading, ignition state, odometer, and geofence status with live caching.
- **Interactive Live Fleet Map**: Interactive Leaflet map (`/live-map`) with status-coded vehicle markers (moving, idle, stationary, offline, in repair), popups, and click-to-detail profile navigation.
- **Rules-Based Reconciliation Engine**: Automatically checks transactions against station GPS location proximity, tank capacity limits, card/driver assignments, duplicate window checks, after-hours window, and abnormal consumption vs `expected_km_per_l`.
- **Exception Centre**: Severity-based summary (Critical, Warning, Info), category filters (Fuel, GPS, Security, Driver, Maintenance, Compliance), and interactive investigation drawer with supporting transaction & GPS data.
- **Tabbed Vehicle Intelligence Profile**: Comprehensive vehicle section (`/vehicles/:id`) containing Profile, Operational state, Fuel history & card info, Service schedules, Driver allocations, and linked Exceptions.
- **Driver Intelligence & Scorecards**: Safety scores out of 100 based on speeding, harsh braking, and idling telemetry events, risk ratings, and efficiency rankings.
- **Utilisation Analytics**: Multi-dimensional filtering by date range, department, vehicle type, driver, and location.

## Documentation

| Doc | Contents |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System architecture, request flow, layering |
| [DATABASE.md](./DATABASE.md) | Data model, schema, SQLite & PostgreSQL migrations |
| [API.md](./API.md) | REST endpoint reference |
| [SECURITY.md](./SECURITY.md) | AuthN/AuthZ, RBAC, audit logging |
| [USER_ROLES.md](./USER_ROLES.md) | User roles and permissions |
| [BUSINESS_RULES.md](./BUSINESS_RULES.md) | Configurable operational and reconciliation rules |
