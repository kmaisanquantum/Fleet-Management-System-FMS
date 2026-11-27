export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
  airportId: string | null;
  clientIds?: string[];
}

export interface Airport {
  id: string;
  code: string;
  iata_code: string | null;
  name: string;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  status: "active" | "inactive";
  connectivity_profile: "online" | "intermittent" | "offline_capable";
}

export interface Tank {
  id: string;
  airport_id: string;
  fuel_facility_id: string;
  fuel_product_id: string;
  tank_code: string;
  capacity: number;
  current_level: number;
  temperature: number | null;
  water_level: number | null;
  status: string;
  maintenance_status: string;
  next_inspection: string | null;
  next_calibration: string | null;
}

export interface Refueller {
  id: string;
  airport_id: string;
  asset_code: string;
  registration: string | null;
  capacity: number;
  current_level: number;
  status: "active" | "maintenance" | "offline" | "decommissioned";
}

export interface FuelReceipt {
  id: string;
  reference: string;
  airport_id: string;
  supplier_id: string;
  tank_id: string;
  quantity: number;
  status: "draft" | "submitted" | "verified" | "approved" | "posted";
  created_at: string;
}

export interface FuelUplift {
  id: string;
  reference: string;
  airport_id: string;
  airline_id: string;
  aircraft_id: string;
  flight_number: string | null;
  quantity: number;
  price_per_litre: number;
  total_amount: number;
  invoice_status: string;
  created_at: string;
}

export interface Reconciliation {
  id: string;
  airport_id: string;
  tank_id: string;
  recon_date: string;
  opening_stock: number;
  expected_closing: number;
  actual_closing: number | null;
  variance: number | null;
  variance_pct: number | null;
  status: string;
}

export interface Invoice {
  id: string;
  invoice_number: string;
  airport_id: string;
  customer_id: string;
  amount: number;
  total_amount: number;
  currency: string;
  invoice_date: string;
  due_date: string | null;
  status: string;
}

export interface Alert {
  id: string;
  severity: "critical" | "warning";
  airport_id: string | null;
  category: string;
  description: string;
  status: "open" | "in_progress" | "resolved";
  created_at: string;
}

export interface Vehicle {
  id: string;
  vehicle_number: string;
  registration_number: string;
  make: string;
  model: string;
  year: number | null;
  vehicle_type: string;
  chassis_vin: string | null;
  engine_number: string | null;
  colour: string | null;
  fuel_type: string;
  department: string | null;
  location: string | null;
  status: "active" | "inactive" | "under_repair" | "disposed";
  acquisition_date: string | null;
  acquisition_cost: number | null;
  current_value: number | null;
  ownership: "owned" | "leased" | "hired" | "other";
  insurance_policy: string | null;
  insurance_expiry: string | null;
  registration_expiry: string | null;
  gps_device_id: string | null;
  gps_imei: string | null;
  gps_device_type: "meshsat" | "teltonika" | null;
  gps_device_model: "FMB125" | "FMC130" | "FMC650" | "FMB920" | "DUALCAM" | null;
  gps_device_status: "active" | "inactive" | "maintenance" | null;
  assignment_id?: string | null;
  assigned_driver_id?: string | null;
  assigned_driver_name?: string | null;
  assigned_driver_employee_number?: string | null;
  assigned_since?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Driver {
  id: string;
  employee_number: string;
  name: string;
  department: string | null;
  licence_number: string;
  licence_class: string | null;
  licence_expiry: string;
  authorisation_status: "authorised" | "suspended" | "revoked" | "pending";
  accident_history: string | null;
  training: string | null;
  assignment_id?: string | null;
  assigned_vehicle_id?: string | null;
  assigned_vehicle_number?: string | null;
  assigned_vehicle_registration?: string | null;
  assigned_since?: string | null;
  created_at: string;
  updated_at: string;
}

export interface VehicleAllocation {
  id: string;
  vehicle_id: string;
  vehicle_number?: string;
  department: string | null;
  custodian: string | null;
  driver_id: string | null;
  driver_name?: string;
  allocation_date: string;
  return_date: string | null;
  approval_status: "pending" | "approved" | "rejected" | "returned";
  authorisation_status: "active" | "expired" | "revoked";
  notes: string | null;
  created_at: string;
}

export interface VehicleFuelLog {
  id: string;
  vehicle_id: string;
  vehicle_number?: string;
  driver_id: string | null;
  driver_name?: string;
  date: string;
  time: string | null;
  station: string | null;
  fuel_type: string;
  litres: number;
  cost_per_litre: number;
  total_cost: number;
  odometer_reading: number;
  payment_method: string | null;
  receipt_ref: string | null;
  l_per_100km: number | null;
  km_per_l: number | null;
  cost_per_km: number | null;
  created_at: string;
}

export interface VehicleTrip {
  id: string;
  vehicle_id: string;
  vehicle_number?: string;
  driver_id: string | null;
  driver_name?: string;
  date: string;
  time_out: string | null;
  time_in: string | null;
  start_location: string;
  destination: string;
  purpose: string | null;
  begin_odometer: number;
  end_odometer: number;
  total_km: number;
  odometer_anomaly: number;
  authorising_officer: string | null;
  created_at: string;
}

export interface VehicleInspection {
  id: string;
  vehicle_id: string;
  vehicle_number?: string;
  inspector_id: string | null;
  inspector_name: string;
  inspection_date: string;
  result: "pass" | "fail" | "requires_attention";
  checklist: string;
  notes: string | null;
  created_at: string;
}

export interface VehicleMaintenance {
  id: string;
  vehicle_id: string;
  vehicle_number?: string;
  maintenance_type: "scheduled_service" | "unscheduled_repair" | "inspection_fix" | "other";
  description: string;
  scheduled_date: string | null;
  completed_date: string | null;
  technician: string | null;
  work_performed: string | null;
  parts: string | null;
  cost: number | null;
  status: "scheduled" | "in_progress" | "completed" | "cancelled";
  created_at: string;
}

export interface FleetSummary {
  vehicles: {
    total: number;
    active: number;
    underRepair: number;
    inactive: number;
  };
  drivers: {
    total: number;
    authorised: number;
  };
  allocations: {
    active: number;
  };
  inspections: {
    recentPass: number;
    recentFail: number;
  };
  fuel: {
    monthlyTotalLitres: number;
    monthlyTotalCost: number;
    avgLPer100Km: number;
  };
  metrics?: {
    totalVehicles: number;
    activeVehicles: number;
    underRepairVehicles: number;
    authorisedDrivers: number;
    totalDrivers: number;
    activeAllocations: number;
    recentPassInspections: number;
    monthlyFuelLitres: number;
    monthlyFuelCost: number;
    avgFuelConsumption: number;
    totalKm: number;
    totalFuelCost: number;
    totalFuelLitres: number;
    totalMaintenanceCost: number;
    openBreakdowns: number;
  };
}

export interface DivisionConsumption {
  department: string;
  refuelCount: number;
  totalLitres: number;
  totalFuelCost: number;
  totalKm: number;
  vehicleCount: number;
}

export interface DailyMileage {
  department: string;
  date: string;
  totalKm: number;
}
