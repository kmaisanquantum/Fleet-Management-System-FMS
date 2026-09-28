/**
 * Generates comprehensive initial system and Fleet Intelligence data.
 */
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { db, initSchema } from "../db";

initSchema();

console.log("Seeding Fleet Management System & Intelligence data...");

// Wipe existing data for clean seed
const tables = [
  "business_rules", "fleet_exceptions", "driver_events", "geofences", "gps_positions",
  "gps_devices", "vehicle_fuel_logs", "fuel_cards", "fuel_stations",
  "vehicle_disposals", "vehicle_accidents", "vehicle_breakdowns",
  "vehicle_maintenance", "vehicle_inspections", "vehicle_trips",
  "vehicle_allocations", "drivers", "vehicles", "audit_logs", "alerts",
  "users", "role_permissions", "permissions", "roles"
];

for (const t of tables) {
  try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
}

// --- Roles ---
const ROLES = [
  ["admin", "Systems Admin"],
  ["fleet_admin", "Fleet Administrator"],
  ["fleet_manager", "Fleet Manager"],
  ["department_manager", "Department Manager"],
  ["driver", "Driver"],
  ["finance", "Finance"],
  ["management", "Management"],
  ["fuel_operator", "Fuel Operator"]
] as const;

const roleIds: Record<string, string> = {};
for (const [name, desc] of ROLES) {
  const id = uuid();
  roleIds[name] = id;
  db.prepare(`INSERT INTO roles (id, name, description) VALUES (?, ?, ?)`).run(id, name, desc);
}

// --- Users ---
const passwordHash = bcrypt.hashSync("Admin@2026", 10);
function makeUser(email: string, fullName: string, role: string) {
  const id = uuid();
  db.prepare(`
    INSERT INTO users (id, email, password_hash, full_name, role_id, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(id, email, passwordHash, fullName, roleIds[role]);
  return id;
}

const adminId = makeUser("admin@dspng.tech", "Admin User", "admin");
makeUser("fleetmgr@dspng.tech", "Fleet Manager", "fleet_manager");
makeUser("driver1@dspng.tech", "John Driver", "driver");

// --- Business Rules ---
const BUSINESS_RULES = [
  { key: "max_allowed_variance_pct", value: "0.5", value_type: "number", label: "Max allowed reconciliation variance (%)", description: "Maximum percentage variance allowed during daily fuel stock reconciliation before an alert is flagged." },
  { key: "default_currency", value: "PGK", value_type: "string", label: "Default currency", description: "Base operating currency code (e.g. PGK, AUD, USD)." },
  { key: "invoice_payment_terms_days", value: "30", value_type: "number", label: "Invoice payment terms (days)", description: "Default payment due window in days for customer fuel uplift invoices." },
  { key: "default_calibration_period_months", value: "12", value_type: "number", label: "Calibration period (default months)", description: "Standard calibration validity period in months for meters and storage tanks." },
  { key: "negative_inventory_allowed", value: "false", value_type: "boolean", label: "Negative inventory allowed", description: "Allows stock withdrawals below zero balance when set to true." },
];

for (const rule of BUSINESS_RULES) {
  db.prepare(`
    INSERT INTO business_rules (key, value, value_type, label, description, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(rule.key, rule.value, rule.value_type, rule.label, rule.description, adminId);
}

// --- Fuel Stations & Depots ---
const STATIONS = [
  { id: uuid(), name: "Port Moresby Central Depot", code: "DEP-POM-01", type: "depot", lat: -9.4438, lon: 147.1803, address: "Napa Napa Rd, Port Moresby" },
  { id: uuid(), name: "Puma Energy Waigani", code: "STN-POM-02", type: "station", lat: -9.4182, lon: 147.1872, address: "Waigani Drive, Port Moresby" },
  { id: uuid(), name: "Mobil Boroko Express", code: "STN-POM-03", type: "station", lat: -9.4715, lon: 147.1985, address: "Hubert Murray Hwy, Boroko" },
  { id: uuid(), name: "Lae Port Fuel Depot", code: "DEP-LAE-01", type: "depot", lat: -6.7265, lon: 146.9944, address: "Milfordhaven Rd, Lae" },
  { id: uuid(), name: "Mt Hagen Central Station", code: "STN-HGN-01", type: "station", lat: -5.8612, lon: 144.2289, address: "Highlands Hwy, Mt Hagen" },
];

for (const s of STATIONS) {
  db.prepare(`
    INSERT INTO fuel_stations (id, name, code, station_type, lat, lon, address, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(s.id, s.name, s.code, s.type, s.lat, s.lon, s.address);
}

// --- Drivers ---
const DRIVERS = [
  { id: uuid(), empNo: "EMP-101", name: "John Tau", dept: "Operations", licence: "DL-90812", class: "Class 4", expiry: "2028-05-20" },
  { id: uuid(), empNo: "EMP-102", name: "Sarah Kila", dept: "Logistics", licence: "DL-88231", class: "Class 3", expiry: "2027-11-15" },
  { id: uuid(), empNo: "EMP-103", name: "Peter Vagi", dept: "Field Services", licence: "DL-77341", class: "Class 4", expiry: "2026-09-10" },
  { id: uuid(), empNo: "EMP-104", name: "Mary Namaliu", dept: "Executive", licence: "DL-65412", class: "Class 3", expiry: "2029-01-30" },
];

for (const d of DRIVERS) {
  db.prepare(`
    INSERT INTO drivers (id, employee_number, name, department, licence_number, licence_class, licence_expiry, authorisation_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'authorised')
  `).run(d.id, d.empNo, d.name, d.dept, d.licence, d.class, d.expiry);
}

// --- Vehicles ---
const VEHICLES = [
  {
    id: uuid(),
    vNum: "V-101",
    reg: "BKP-402",
    make: "Toyota",
    model: "Hilux 4x4",
    year: 2022,
    vType: "Utility",
    fuelType: "Diesel",
    dept: "Operations",
    tankCap: 80,
    expectedKmL: 8.5,
    odometer: 45210,
    lat: -9.4442,
    lon: 147.1810,
    loc: "Port Moresby Depot",
    status: "active",
    driverId: DRIVERS[0].id
  },
  {
    id: uuid(),
    vNum: "V-102",
    reg: "LAE-319",
    make: "Toyota",
    model: "Land Cruiser Hardtop",
    year: 2021,
    vType: "4WD SUV",
    fuelType: "Diesel",
    dept: "Field Services",
    tankCap: 110,
    expectedKmL: 6.8,
    odometer: 78340,
    lat: -6.7270,
    lon: 146.9950,
    loc: "Lae Highway",
    status: "active",
    driverId: DRIVERS[2].id
  },
  {
    id: uuid(),
    vNum: "V-103",
    reg: "BKP-881",
    make: "Isuzu",
    model: "NPR 400 Truck",
    year: 2023,
    vType: "Medium Truck",
    fuelType: "Diesel",
    dept: "Logistics",
    tankCap: 150,
    expectedKmL: 5.2,
    odometer: 32100,
    lat: -9.4190,
    lon: 147.1880,
    loc: "Waigani Commercial Zone",
    status: "active",
    driverId: DRIVERS[1].id
  },
  {
    id: uuid(),
    vNum: "V-104",
    reg: "HGN-104",
    make: "Nissan",
    model: "Navara Double Cab",
    year: 2020,
    vType: "Utility",
    fuelType: "Diesel",
    dept: "Field Services",
    tankCap: 80,
    expectedKmL: 9.0,
    odometer: 112000,
    lat: -5.8620,
    lon: 144.2295,
    loc: "Mt Hagen Workshop",
    status: "under_repair",
    driverId: null
  },
  {
    id: uuid(),
    vNum: "V-105",
    reg: "BKP-105",
    make: "Hyundai",
    model: "Santa Fe",
    year: 2023,
    vType: "Passenger SUV",
    fuelType: "Unleaded Petrol",
    dept: "Executive",
    tankCap: 65,
    expectedKmL: 10.5,
    odometer: 18400,
    lat: -9.4720,
    lon: 147.1990,
    loc: "Boroko HQ",
    status: "active",
    driverId: DRIVERS[3].id
  }
];

const nowIso = new Date().toISOString().replace("T", " ").substring(0, 19);

for (const v of VEHICLES) {
  const cardId = uuid();
  const cardNum = `FC-9000-${v.vNum.replace("V-", "")}`;
  const deviceId = uuid();
  const devIdent = `GPS-DEV-${v.vNum.replace("V-", "")}`;

  // Insert Vehicle first
  db.prepare(`
    INSERT INTO vehicles (
      id, vehicle_number, registration_number, make, model, year, vehicle_type,
      fuel_type, department, location, status, tank_capacity_litres, expected_km_per_l,
      gps_device_id, fuel_card_id, current_odometer, current_latitude, current_longitude,
      current_location_name, last_gps_fix_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    v.id, v.vNum, v.reg, v.make, v.model, v.year, v.vType, v.fuelType, v.dept,
    v.loc, v.status, v.tankCap, v.expectedKmL, deviceId, cardId, v.odometer,
    v.lat, v.lon, v.loc, nowIso
  );

  // Insert GPS device
  db.prepare(`
    INSERT INTO gps_devices (id, vehicle_id, device_identifier, status)
    VALUES (?, ?, ?, 'active')
  `).run(deviceId, v.id, devIdent);

  // Insert Fuel Card
  db.prepare(`
    INSERT INTO fuel_cards (id, card_number, vehicle_id, authorised_driver_id, status, limits)
    VALUES (?, ?, ?, ?, 'active', ?)
  `).run(cardId, cardNum, v.id, v.driverId, JSON.stringify({ monthlyLimitKina: 5000, maxLitresPerTxn: v.tankCap }));

  // Insert Allocation
  if (v.driverId) {
    db.prepare(`
      INSERT INTO vehicle_allocations (id, vehicle_id, driver_id, department, allocation_date, authorisation_status)
      VALUES (?, ?, ?, ?, '2026-01-01', 'active')
    `).run(uuid(), v.id, v.driverId, v.dept);
  }

  // Insert Recent GPS position traces
  const speeds = v.status === "under_repair" ? [0, 0] : [45, 62, 0, 55, 0];
  const ignitions = v.status === "under_repair" ? [0, 0] : [1, 1, 1, 1, 0];
  for (let i = 0; i < speeds.length; i++) {
    const timeOffset = (speeds.length - i) * 15; // 15 mins ago
    const recTime = new Date(Date.now() - timeOffset * 60000).toISOString().replace("T", " ").substring(0, 19);
    db.prepare(`
      INSERT INTO gps_positions (id, vehicle_id, lat, lon, speed, heading, ignition, odometer, recorded_at, geofence_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'inside')
    `).run(
      uuid(), v.id, v.lat + (i * 0.001), v.lon + (i * 0.001),
      speeds[i], 180, ignitions[i], v.odometer - ((speeds.length - i) * 10), recTime
    );
  }
}

// --- Geofences ---
const GEOFENCES = [
  { id: uuid(), name: "Port Moresby HQ & Depot", lat: -9.4438, lon: 147.1803, radius: 1500 },
  { id: uuid(), name: "Waigani Commercial Precinct", lat: -9.4182, lon: 147.1872, radius: 2000 },
  { id: uuid(), name: "Lae Industrial Zone", lat: -6.7265, lon: 146.9944, radius: 3000 },
];
for (const g of GEOFENCES) {
  db.prepare(`
    INSERT INTO geofences (id, name, lat, lon, radius_meters, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(g.id, g.name, g.lat, g.lon, g.radius);
}

// --- Driver Events ---
const EVENTS = [
  { vId: VEHICLES[0].id, dId: DRIVERS[0].id, type: "speeding", val: 88, lat: -9.442, lon: 147.181 },
  { vId: VEHICLES[0].id, dId: DRIVERS[0].id, type: "harsh_braking", val: 14, lat: -9.445, lon: 147.183 },
  { vId: VEHICLES[1].id, dId: DRIVERS[2].id, type: "excessive_idling", val: 35, lat: -6.728, lon: 146.996 },
  { vId: VEHICLES[2].id, dId: DRIVERS[1].id, type: "harsh_accel", val: 12, lat: -9.420, lon: 147.189 },
];
for (const e of EVENTS) {
  db.prepare(`
    INSERT INTO driver_events (id, event_type, vehicle_id, driver_id, recorded_at, value, lat, lon)
    VALUES (?, ?, ?, ?, datetime('now', '-2 hours'), ?, ?, ?)
  `).run(uuid(), e.type, e.vId, e.dId, e.val, e.lat, e.lon);
}

// --- Fuel Transactions (Verified + Exception Cases) ---
const cardV1 = db.prepare("SELECT fuel_card_id FROM vehicles WHERE id = ?").get(VEHICLES[0].id) as any;
const cardV2 = db.prepare("SELECT fuel_card_id FROM vehicles WHERE id = ?").get(VEHICLES[1].id) as any;
const cardV3 = db.prepare("SELECT fuel_card_id FROM vehicles WHERE id = ?").get(VEHICLES[2].id) as any;

// 1. Verified Transaction (V-101 at Waigani)
const tx1Id = uuid();
db.prepare(`
  INSERT INTO vehicle_fuel_logs (
    id, vehicle_id, driver_id, date, time, station, fuel_type, litres, cost_per_litre,
    total_cost, odometer_reading, payment_method, receipt_ref, km_per_l, l_per_100km,
    cost_per_km, fuel_card_id, station_id, source, gps_verified, reconciliation_status
  ) VALUES (
    ?, ?, ?, '2026-03-27', '09:30:00', 'Puma Energy Waigani', 'Diesel', 65.0, 3.80,
    247.0, 45210, 'Fuel Card', 'RC-88102', 8.6, 11.6, 0.44, ?, ?, 'card', 1, 'verified'
  )
`).run(tx1Id, VEHICLES[0].id, DRIVERS[0].id, cardV1.fuel_card_id, STATIONS[1].id);

// 2. Exception Transaction: Capacity Exceeded + Card Mismatch (V-101 filled 110L on 80L tank using V-102's card)
const tx2Id = uuid();
db.prepare(`
  INSERT INTO vehicle_fuel_logs (
    id, vehicle_id, driver_id, date, time, station, fuel_type, litres, cost_per_litre,
    total_cost, odometer_reading, payment_method, receipt_ref, km_per_l, l_per_100km,
    cost_per_km, fuel_card_id, station_id, source, gps_verified, reconciliation_status
  ) VALUES (
    ?, ?, ?, '2026-03-28', '23:15:00', 'Mobil Boroko Express', 'Diesel', 115.0, 3.80,
    437.0, 45400, 'Fuel Card', 'RC-88190', 3.2, 31.25, 1.18, ?, ?, 'card', 0, 'exception'
  )
`).run(tx2Id, VEHICLES[0].id, DRIVERS[0].id, cardV2.fuel_card_id, STATIONS[2].id);

db.prepare(`
  INSERT INTO fleet_exceptions (
    id, severity, category, rule_code, vehicle_id, driver_id, transaction_id,
    description, status, notes, created_at
  ) VALUES (
    ?, 'critical', 'fuel', 'RULE_CAPACITY_EXCEEDED', ?, ?, ?,
    'Refuel quantity (115.0L) exceeds vehicle tank capacity (80.0L).', 'open',
    'Investigating potential card misuse or off-vehicle container filling.', datetime('now', '-4 hours')
  )
`).run(uuid(), VEHICLES[0].id, DRIVERS[0].id, tx2Id);

db.prepare(`
  INSERT INTO fleet_exceptions (
    id, severity, category, rule_code, vehicle_id, driver_id, transaction_id,
    description, status, notes, created_at
  ) VALUES (
    ?, 'critical', 'security', 'RULE_CARD_MISMATCH', ?, ?, ?,
    'Fuel card FC-9000-102 assigned to V-102 was presented for V-101.', 'investigating',
    'Card swapped between field teams.', datetime('now', '-4 hours')
  )
`).run(uuid(), VEHICLES[0].id, DRIVERS[0].id, tx2Id);

// 3. Exception Transaction: Station Location Mismatch (V-103 refuel recorded in Mt Hagen while GPS shows POM)
const tx3Id = uuid();
db.prepare(`
  INSERT INTO vehicle_fuel_logs (
    id, vehicle_id, driver_id, date, time, station, fuel_type, litres, cost_per_litre,
    total_cost, odometer_reading, payment_method, receipt_ref, km_per_l, l_per_100km,
    cost_per_km, fuel_card_id, station_id, source, gps_verified, reconciliation_status
  ) VALUES (
    ?, ?, ?, '2026-03-28', '14:20:00', 'Mt Hagen Central Station', 'Diesel', 120.0, 3.90,
    468.0, 32100, 'Fuel Card', 'RC-90112', 5.1, 19.6, 0.76, ?, ?, 'card', 0, 'exception'
  )
`).run(tx3Id, VEHICLES[2].id, DRIVERS[1].id, cardV3.fuel_card_id, STATIONS[4].id);

db.prepare(`
  INSERT INTO fleet_exceptions (
    id, severity, category, rule_code, vehicle_id, driver_id, transaction_id,
    description, status, created_at
  ) VALUES (
    ?, 'critical', 'gps', 'RULE_STATION_MISMATCH', ?, ?, ?,
    'Vehicle GPS location (Port Moresby) was 512 km away from station (Mt Hagen) at transaction time.', 'open', datetime('now', '-2 hours')
  )
`).run(uuid(), VEHICLES[2].id, DRIVERS[1].id, tx3Id);

// 4. Exception Transaction: Abnormal Consumption (V-102 Land Cruiser 3.8 km/L vs expected 6.8 km/L)
const tx4Id = uuid();
db.prepare(`
  INSERT INTO vehicle_fuel_logs (
    id, vehicle_id, driver_id, date, time, station, fuel_type, litres, cost_per_litre,
    total_cost, odometer_reading, payment_method, receipt_ref, km_per_l, l_per_100km,
    cost_per_km, fuel_card_id, station_id, source, gps_verified, reconciliation_status
  ) VALUES (
    ?, ?, ?, '2026-03-28', '11:00:00', 'Lae Port Fuel Depot', 'Diesel', 100.0, 3.75,
    375.0, 78340, 'Depot Direct', 'DP-1004', 3.8, 26.3, 0.98, ?, ?, 'depot', 1, 'exception'
  )
`).run(tx4Id, VEHICLES[1].id, DRIVERS[2].id, cardV2.fuel_card_id, STATIONS[3].id);

db.prepare(`
  INSERT INTO fleet_exceptions (
    id, severity, category, rule_code, vehicle_id, driver_id, transaction_id,
    description, status, created_at
  ) VALUES (
    ?, 'warning', 'fuel', 'RULE_ABNORMAL_CONSUMPTION', ?, ?, ?,
    'Calculated fuel efficiency (3.8 km/L) deviates by 44% from expected rating (6.8 km/L).', 'open', datetime('now', '-1 hours')
  )
`).run(uuid(), VEHICLES[1].id, DRIVERS[2].id, tx4Id);

// --- Maintenance Schedule Record ---
db.prepare(`
  INSERT INTO vehicle_maintenance (
    id, vehicle_id, maintenance_type, description, scheduled_date, status, cost
  ) VALUES (
    ?, ?, 'scheduled_service', '50,000 km Major Service & Injector Clean', '2026-04-05', 'scheduled', 1250.0
  )
`).run(uuid(), VEHICLES[0].id);

console.log("Seed complete: Intelligence data, GPS positions, Fuel cards, Stations, Business Rules, and Fleet Exceptions populated.");
