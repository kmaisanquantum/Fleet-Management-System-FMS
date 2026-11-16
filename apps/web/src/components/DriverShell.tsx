import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const DRIVER_NAV_GROUPS: { title: string; items: { to: string; label: string }[] }[] = [
  {
    title: "My Workspace",
    items: [
      { to: "/portal", label: "Dashboard" },
      { to: "/portal/profile", label: "My Profile" },
      { to: "/portal/notifications", label: "Notifications" },
    ],
  },
  {
    title: "Vehicle & Trips",
    items: [
      { to: "/portal/vehicle", label: "My Assigned Vehicle" },
      { to: "/portal/trips", label: "My Trips" },
      { to: "/portal/mileage", label: "Mileage Records" },
      { to: "/portal/inspections", label: "Daily Inspections" },
    ],
  },
  {
    title: "Vehicle Reporting",
    items: [
      { to: "/portal/fuel", label: "Fuel Records" },
      { to: "/portal/faults", label: "Report Vehicle Fault" },
      { to: "/portal/incidents", label: "Accident & Incident Reports" },
      { to: "/portal/maintenance", label: "Maintenance Requests" },
    ],
  },
  {
    title: "Driver Performance",
    items: [
      { to: "/portal/safety", label: "Safety Score" },
      { to: "/portal/behaviour", label: "Driving Behaviour" },
      { to: "/portal/reports", label: "My Driving Reports" },
    ],
  },
  {
    title: "Other",
    items: [
      { to: "/portal/leave", label: "Leave / Absence Requests" },
      { to: "/portal/documents", label: "My Documents" },
    ],
  },
];

export default function DriverShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-base-950">
      {/* Mobile Top Bar */}
      <header className="lg:hidden flex items-center justify-between px-4 py-3 bg-base-900 border-b border-base-700 shrink-0 sticky top-0 z-20">
        <div className="font-display font-semibold text-base leading-tight text-ink-100">
          Driver <span className="text-amber-400">Portal</span>
        </div>
        <button
          type="button"
          onClick={() => setNavOpen(!navOpen)}
          className="p-2 text-ink-300 hover:text-ink-100 hover:bg-base-800 rounded-md transition-colors"
          aria-label="Toggle navigation menu"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {navOpen ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            )}
          </svg>
        </button>
      </header>

      {/* Mobile Drawer Backdrop */}
      {navOpen && <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setNavOpen(false)} />}

      {/* Navigation Sidebar Drawer */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 shrink-0 border-r border-base-700 bg-base-900 flex flex-col transform transition-transform duration-200 ease-in-out lg:static lg:translate-x-0 ${
          navOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="px-5 py-5 border-b border-base-700 flex items-center justify-between">
          <div>
            <div className="font-display font-semibold text-lg leading-tight text-ink-100">Driver</div>
            <div className="font-display font-semibold text-lg leading-tight text-amber-400">Portal</div>
            <div className="text-[10px] uppercase tracking-widest text-ink-500 mt-1">Fleet Management System</div>
          </div>
          <button
            type="button"
            onClick={() => setNavOpen(false)}
            className="lg:hidden text-ink-400 hover:text-ink-100 p-1"
            aria-label="Close navigation menu"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto py-3">
          {DRIVER_NAV_GROUPS.map((group) => (
            <div key={group.title} className="mb-4">
              <div className="px-5 mb-1 text-[10px] uppercase tracking-widest text-ink-500 font-medium">{group.title}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/portal"}
                  onClick={() => setNavOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center px-5 py-2 text-sm border-l-2 transition-colors ${
                      isActive
                        ? "border-amber-400 text-ink-100 bg-base-800"
                        : "border-transparent text-ink-300 hover:bg-base-800 hover:text-ink-100"
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
          <button
            className="flex w-full items-center px-5 py-2 text-sm border-l-2 border-transparent text-ink-300 hover:bg-base-800 hover:text-ink-100 transition-colors"
            onClick={() => {
              setNavOpen(false);
              logout();
              navigate("/login");
            }}
          >
            Logout
          </button>
        </nav>
        <div className="px-5 py-4 border-t border-base-700">
          <div className="text-sm text-ink-100">{user?.fullName}</div>
          <div className="text-xs text-ink-500 capitalize">{user?.role?.replace(/_/g, " ")}</div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-[1100px] mx-auto p-4 lg:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
