export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
  airportId: string | null;
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

/* ------------------------------------------------------------------ */
/* Driver Portal                                                       */
/* ------------------------------------------------------------------ */

export interface DriverProfile {
  id: string;
  employeeNumber: string;
  name: string;
  department: string | null;
  licenceNumber: string;
  licenceClass: string | null;
  licenceExpiry: string;
  authorisationStatus: string;
  accidentHistory: string | null;
  training: string | null;
  email: string | null;
  fullName: string;
  accountStatus: string | null;
}

export interface AssignedVehicleInfo {
  id: string;
  vehicle_number: string;
  registration_number: string;
  make: string;
  model: string;
  vehicle_type: string;
  fuel_type: string;
  department: string | null;
  location: string | null;
  status: string;
  current_odometer: number;
  tank_capacity_litres: number | null;
  expected_km_per_l: number | null;
  allocation_id: string;
  allocation_date: string;
  return_date: string | null;
  blockReason?: string | null;
}

export interface DriverNotification {
  id: string;
  user_id: string;
  driver_id: string | null;
  title: string;
  body: string;
  category: string;
  related_entity: string | null;
  related_id: string | null;
  is_read: number;
  created_by: string | null;
  created_at: string;
  read_at: string | null;
}

export interface DriverDashboard {
  assignedVehicle: AssignedVehicleInfo | null;
  vehicleBlockReason: string | null;
  todaysTrips: VehicleTrip[];
  metrics: {
    totalKm: number;
    totalFuelLitres: number;
    totalFuelCost: number;
    avgKmPerL: number;
    pendingInspections: number;
    safetyScore: number;
    riskRating: "low" | "medium" | "high";
    openFaults: number;
    unreadNotifications: number;
  };
  notifications: DriverNotification[];
}

export interface ChecklistItemDef {
  key: string;
  label: string;
  critical: boolean;
}

export interface InspectionItem {
  id: string;
  inspection_id: string;
  item_key: string;
  label: string;
  status: "satisfactory" | "defective" | "na";
  is_critical: number;
  comment: string | null;
  created_at: string;
}

export interface DriverInspection extends Omit<VehicleInspection, "checklist"> {
  driver_id: string | null;
  photo_urls: string | null;
  cleared: number;
  items: InspectionItem[];
}

export interface VehicleFault {
  id: string;
  vehicle_id: string;
  vehicle_number?: string;
  driver_id: string | null;
  driver_name?: string;
  reported_by_user_id: string | null;
  category: string;
  description: string;
  severity: "minor" | "major" | "critical";
  odometer: number | null;
  photo_urls: string | null;
  status: "open" | "acknowledged" | "in_progress" | "resolved" | "cleared" | "rejected";
  admin_notes: string | null;
  maintenance_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface IncidentReport {
  id: string;
  vehicle_id: string | null;
  vehicle_number?: string;
  driver_id: string | null;
  driver_name?: string;
  reported_by_user_id: string | null;
  incident_type: "accident" | "incident" | "near_miss" | "damage" | "theft" | "other";
  incident_date: string;
  location: string | null;
  description: string;
  injuries: number;
  injury_details: string | null;
  damage_description: string | null;
  third_party_details: string | null;
  photo_urls: string | null;
  document_urls: string | null;
  status: "submitted" | "under_review" | "investigating" | "closed";
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface DriverLeaveRequest {
  id: string;
  driver_id: string;
  driver_name?: string;
  employee_number?: string;
  user_id: string | null;
  leave_type: "annual" | "sick" | "compassionate" | "unpaid" | "other";
  start_date: string;
  end_date: string;
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  admin_notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface DriverDocument {
  id: string;
  driver_id: string;
  driver_name?: string;
  employee_number?: string;
  user_id: string | null;
  document_type: string;
  title: string;
  file_url: string | null;
  file_name: string | null;
  mime_type: string | null;
  expiry_date: string | null;
  status: "pending" | "verified" | "rejected" | "expired";
  admin_notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface DriverSafety {
  safetyScore: number;
  riskRating: "low" | "medium" | "high";
  speedingCount: number;
  harshBrakingCount: number;
  harshAccelCount: number;
  idlingCount: number;
  totalEvents: number;
  monthlyTrend: { month: string; speeding: number; harshBraking: number; harshAccel: number; idling: number; total: number }[];
  openExceptions: number;
  recentEvents: { id: string; event_type: string; recorded_at: string; value: number; lat: number | null; lon: number | null }[];
}

export interface UploadedFileInfo {
  url: string;
  fileName: string;
  mimeType: string;
  size: number;
}
