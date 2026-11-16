import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import AppShell from "./components/AppShell";
import DriverShell from "./components/DriverShell";
import Login from "./pages/Login";
import FleetDashboard from "./pages/FleetDashboard";
import LiveFleetMap from "./pages/LiveFleetMap";
import ExceptionCentre from "./pages/ExceptionCentre";
import FuelIntelligence from "./pages/FuelIntelligence";
import DriverIntelligence from "./pages/DriverIntelligence";
import Utilisation from "./pages/Utilisation";
import VehicleDetail from "./pages/VehicleDetail";
import DivisionConsumption from "./pages/DivisionConsumption";
import Vehicles from "./pages/Vehicles";
import Drivers from "./pages/Drivers";
import VehicleAllocations from "./pages/VehicleAllocations";
import VehicleFuelLogs from "./pages/VehicleFuelLogs";
import VehicleTrips from "./pages/VehicleTrips";
import VehicleInspections from "./pages/VehicleInspections";
import VehicleMaintenance from "./pages/VehicleMaintenance";

import Alerts from "./pages/Alerts";
import AuditLog from "./pages/AuditLog";
import Users from "./pages/Users";
import Settings from "./pages/Settings";
import DriverSubmissions from "./pages/DriverSubmissions";

import DriverDashboard from "./pages/driver/DriverDashboard";
import MyProfile from "./pages/driver/MyProfile";
import Notifications from "./pages/driver/Notifications";
import MyVehicle from "./pages/driver/MyVehicle";
import MyTrips from "./pages/driver/MyTrips";
import MileageRecords from "./pages/driver/MileageRecords";
import DailyInspections from "./pages/driver/DailyInspections";
import FuelRecords from "./pages/driver/FuelRecords";
import ReportFault from "./pages/driver/ReportFault";
import Incidents from "./pages/driver/Incidents";
import MaintenanceRequests from "./pages/driver/MaintenanceRequests";
import SafetyScore from "./pages/driver/SafetyScore";
import DrivingBehaviour from "./pages/driver/DrivingBehaviour";
import DrivingReports from "./pages/driver/DrivingReports";
import LeaveRequests from "./pages/driver/LeaveRequests";
import MyDocuments from "./pages/driver/MyDocuments";

function Loading() {
  return <div className="min-h-screen flex items-center justify-center text-ink-500">Loading…</div>;
}

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  // Drivers are confined to the Driver Portal and never see the admin shell.
  if (user.role === "driver" && !location.pathname.startsWith("/portal")) return <Navigate to="/portal" replace />;
  return children;
}

function RequireAdmin({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin") return <Navigate to="/fleet" replace />;
  return children;
}

function RequireDriver({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "driver") return <Navigate to="/fleet" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/fleet" replace />} />
        <Route path="/fleet" element={<FleetDashboard />} />
        <Route path="/live-map" element={<LiveFleetMap />} />
        <Route path="/exceptions" element={<ExceptionCentre />} />
        <Route path="/fuel-intelligence" element={<FuelIntelligence />} />
        <Route path="/driver-intelligence" element={<DriverIntelligence />} />
        <Route path="/utilisation" element={<Utilisation />} />
        <Route path="/vehicles/:id" element={<VehicleDetail />} />

        <Route path="/fleet-consumption" element={<DivisionConsumption />} />
        <Route path="/vehicles" element={<Vehicles />} />
        <Route path="/drivers" element={<Drivers />} />
        <Route path="/fleet-allocations" element={<VehicleAllocations />} />
        <Route path="/fleet-fuel" element={<VehicleFuelLogs />} />
        <Route path="/fleet-trips" element={<VehicleTrips />} />
        <Route path="/fleet-inspections" element={<VehicleInspections />} />
        <Route path="/fleet-maintenance" element={<VehicleMaintenance />} />

        <Route path="/alerts" element={<RequireAdmin><Alerts /></RequireAdmin>} />
        <Route path="/audit" element={<RequireAdmin><AuditLog /></RequireAdmin>} />
        <Route path="/users" element={<RequireAdmin><Users /></RequireAdmin>} />
        <Route path="/driver-submissions" element={<RequireAdmin><DriverSubmissions /></RequireAdmin>} />
        <Route path="/settings" element={<RequireAdmin><Settings /></RequireAdmin>} />
      </Route>

      <Route
        element={
          <RequireDriver>
            <DriverShell />
          </RequireDriver>
        }
      >
        <Route path="/portal" element={<DriverDashboard />} />
        <Route path="/portal/profile" element={<MyProfile />} />
        <Route path="/portal/notifications" element={<Notifications />} />
        <Route path="/portal/vehicle" element={<MyVehicle />} />
        <Route path="/portal/trips" element={<MyTrips />} />
        <Route path="/portal/mileage" element={<MileageRecords />} />
        <Route path="/portal/inspections" element={<DailyInspections />} />
        <Route path="/portal/fuel" element={<FuelRecords />} />
        <Route path="/portal/faults" element={<ReportFault />} />
        <Route path="/portal/incidents" element={<Incidents />} />
        <Route path="/portal/maintenance" element={<MaintenanceRequests />} />
        <Route path="/portal/safety" element={<SafetyScore />} />
        <Route path="/portal/behaviour" element={<DrivingBehaviour />} />
        <Route path="/portal/reports" element={<DrivingReports />} />
        <Route path="/portal/leave" element={<LeaveRequests />} />
        <Route path="/portal/documents" element={<MyDocuments />} />
      </Route>

      <Route path="*" element={<Navigate to="/fleet" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
