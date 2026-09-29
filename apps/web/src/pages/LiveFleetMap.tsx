import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { apiGet } from "../api/client";

// Fix standard Leaflet default marker icon paths in React
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

interface VehicleGpsData {
  vehicle_id: string;
  vehicle_number: string;
  registration_number: string;
  make: string;
  model: string;
  department: string;
  tank_capacity_litres: number;
  expected_km_per_l: number;
  current_odometer: number;
  current_latitude: number;
  current_longitude: number;
  last_gps_fix_at: string;
  computed_status: "moving" | "idle" | "stationary" | "offline" | "under_maintenance" | "unassigned";
  speed: number;
  heading: number;
  ignition: number;
  geofence_status: string;
  driver_name: string | null;
}

function createStatusIcon(status: string) {
  let color = "#3b82f6"; // blue (stationary)
  if (status === "moving") color = "#10b981"; // emerald
  else if (status === "idle") color = "#f59e0b"; // amber
  else if (status === "offline") color = "#6b7280"; // gray
  else if (status === "under_maintenance") color = "#ef4444"; // red

  const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32">
    <circle cx="12" cy="12" r="10" fill="${color}" stroke="#ffffff" stroke-width="2"/>
    <circle cx="12" cy="12" r="4" fill="#ffffff"/>
  </svg>`;

  return L.divIcon({
    className: "custom-leaflet-marker",
    html: svgIcon,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16],
  });
}

export default function LiveFleetMap() {
  const maptilerKey = import.meta.env.VITE_MAPTILER_KEY;
  const tileUrl = maptilerKey
    ? `https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=${maptilerKey}`
    : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

  const tileAttribution = maptilerKey
    ? '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  const meshsatMapUrl = import.meta.env.VITE_MESHSAT_MAP_URL || "https://meshsat.dspng.space/map";

  const [activeTab, setActiveTab] = useState<"fms" | "meshsat">("fms");
  const [vehicles, setVehicles] = useState<VehicleGpsData[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    loadLatestGps();
    const interval = setInterval(loadLatestGps, 15000); // refresh every 15s
    return () => clearInterval(interval);
  }, []);

  async function loadLatestGps() {
    try {
      const res = await apiGet<{ data: VehicleGpsData[] }>("/gps/latest");
      setVehicles(res.data);
    } catch (err) {
      console.error("Failed to load GPS positions:", err);
    } finally {
      setLoading(false);
    }
  }

  const filteredVehicles = vehicles.filter((v) => {
    if (filterStatus !== "all" && v.computed_status !== filterStatus) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        v.vehicle_number.toLowerCase().includes(q) ||
        v.registration_number.toLowerCase().includes(q) ||
        (v.driver_name && v.driver_name.toLowerCase().includes(q))
      );
    }
    return true;
  });

  // Calculate default map centre based on vehicles or default to PNG Port Moresby (-9.44, 147.18)
  const validCoords = filteredVehicles.filter((v) => v.current_latitude && v.current_longitude);
  const defaultCentre: [number, number] = validCoords.length > 0
    ? [validCoords[0].current_latitude, validCoords[0].current_longitude]
    : [-9.4438, 147.1803];

  return (
    <div className="space-y-4">
      {/* Page Title & Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink-100">Live Fleet Map & Telematics</h1>
          <p className="text-sm text-ink-400">Real-time GPS vehicle tracking, MeshSat satellite/radio network, ignition status, and speed monitoring</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {activeTab === "fms" && (
            <>
              <input
                type="text"
                placeholder="Search vehicle / driver…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="input text-xs w-48 bg-base-900 border-base-700 text-ink-100"
              />
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="input text-xs w-40 bg-base-900 border-base-700 text-ink-100"
              >
                <option value="all">All Statuses</option>
                <option value="moving">Moving</option>
                <option value="idle">Idle</option>
                <option value="stationary">Stationary</option>
                <option value="offline">Offline</option>
                <option value="under_maintenance">Under Maintenance</option>
              </select>
              <button onClick={loadLatestGps} className="btn-secondary text-xs px-3 py-2">
                🔄 Refresh
              </button>
            </>
          )}
        </div>
      </div>

      {/* View Switcher Tabs */}
      <div className="flex border-b border-base-700 space-x-4">
        <button
          onClick={() => setActiveTab("fms")}
          className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "fms"
              ? "border-amber-500 text-amber-500 font-semibold"
              : "border-transparent text-ink-400 hover:text-ink-200"
          }`}
        >
          🛰️ FMS Telematics Map
        </button>
        <button
          onClick={() => setActiveTab("meshsat")}
          className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "meshsat"
              ? "border-amber-500 text-amber-500 font-semibold"
              : "border-transparent text-ink-400 hover:text-ink-200"
          }`}
        >
          📡 MeshSat Mesh Map
        </button>
      </div>

      {/* Map Container */}
      <div className="bg-base-900 border border-base-700 rounded-xl overflow-hidden h-[600px] relative">
        {activeTab === "meshsat" ? (
          meshsatMapUrl ? (
            <iframe
              src={meshsatMapUrl}
              className="w-full h-full border-0"
              title="MeshSat Map"
              allow="geolocation"
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-ink-400 space-y-3 p-6 text-center">
              <div className="text-4xl">📡</div>
              <p className="text-base font-semibold text-ink-200">MeshSat Map Endpoint Unconfigured</p>
              <p className="text-xs max-w-md text-ink-400">
                To view the embedded MeshSat mesh network map, set <code className="bg-base-800 text-amber-400 px-1.5 py-0.5 rounded">VITE_MESHSAT_MAP_URL</code> (e.g. <code className="bg-base-800 text-amber-400 px-1.5 py-0.5 rounded">https://mesh.dspng.tech/map</code>) in the environment during web build.
              </p>
              <p className="text-xs text-ink-500 max-w-md">
                Note: The URL must use HTTPS to prevent browser mixed-content iframe blocking on HTTPS deployment sites.
              </p>
            </div>
          )
        ) : loading ? (
          <div className="h-full flex items-center justify-center text-ink-400">
            Loading telematics map…
          </div>
        ) : (
          <MapContainer
            center={defaultCentre}
            zoom={12}
            scrollWheelZoom={true}
            style={{ height: "100%", width: "100%", background: "#0f172a" }}
          >
            <TileLayer
              attribution={tileAttribution}
              url={tileUrl}
              subdomains={["a", "b", "c", "d"]}
            />
            {filteredVehicles.map((v) => {
              if (!v.current_latitude || !v.current_longitude) return null;
              return (
                <Marker
                  key={v.vehicle_id}
                  position={[v.current_latitude, v.current_longitude]}
                  icon={createStatusIcon(v.computed_status)}
                >
                  <Popup>
                    <div className="p-1 space-y-2 text-ink-900 min-w-[220px]">
                      <div className="flex items-center justify-between border-b pb-1">
                        <span className="font-bold text-sm">{v.vehicle_number}</span>
                        <span className="text-xs text-gray-600 font-mono">{v.registration_number}</span>
                      </div>
                      <div className="text-xs space-y-1">
                        <div><strong className="text-gray-700">Model:</strong> {v.make} {v.model}</div>
                        <div><strong className="text-gray-700">Driver:</strong> {v.driver_name || "Unassigned"}</div>
                        <div><strong className="text-gray-700">Status:</strong> <span className="uppercase font-bold text-[10px] px-1.5 py-0.5 rounded bg-gray-200">{v.computed_status}</span></div>
                        <div><strong className="text-gray-700">Speed:</strong> {v.speed || 0} km/h | Heading: {v.heading || 0}&deg;</div>
                        <div><strong className="text-gray-700">Ignition:</strong> {v.ignition === 1 ? "ON" : "OFF"}</div>
                        <div><strong className="text-gray-700">Odometer:</strong> {v.current_odometer?.toLocaleString() || 0} km</div>
                        <div><strong className="text-gray-700">Geofence:</strong> {v.geofence_status || "inside"}</div>
                      </div>
                      <div className="pt-2 border-t text-right">
                        <Link
                          to={`/vehicles/${v.vehicle_id}`}
                          className="text-xs font-semibold text-amber-600 hover:text-amber-800"
                        >
                          View Vehicle Profile &rarr;
                        </Link>
                      </div>
                    </div>
                  </Popup>
                </Marker>
              );
            })}
          </MapContainer>
        )}
      </div>
    </div>
  );
}
