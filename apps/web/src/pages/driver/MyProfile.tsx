import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { DriverProfile } from "../../types";
import { PageHeader, StatusBadge } from "./shared";

export default function MyProfile() {
  const [profile, setProfile] = useState<DriverProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ data: DriverProfile }>("/driver-portal/profile")
      .then((res) => setProfile(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-4 text-ink-400">Loading profile…</div>;
  if (!profile) return <div className="p-4 text-signal-red">Unable to load your profile.</div>;

  const licenceExpiringSoon = profile.licenceExpiry && new Date(profile.licenceExpiry).getTime() - Date.now() < 90 * 864e5;

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Full Name", value: profile.fullName },
    { label: "Employee Number", value: profile.employeeNumber },
    { label: "Department", value: profile.department ?? "—" },
    { label: "Email", value: profile.email ?? "—" },
    { label: "Licence Number", value: profile.licenceNumber },
    { label: "Licence Class", value: profile.licenceClass ?? "—" },
    {
      label: "Licence Expiry",
      value: (
        <span className={licenceExpiringSoon ? "text-signal-red" : ""}>
          {profile.licenceExpiry} {licenceExpiringSoon && "· expiring soon"}
        </span>
      ),
    },
    { label: "Authorisation", value: <StatusBadge value={profile.authorisationStatus} /> },
    { label: "Training", value: profile.training ?? "—" },
    { label: "Accident History", value: profile.accidentHistory ?? "None recorded" },
    { label: "Account Status", value: <StatusBadge value={profile.accountStatus ?? undefined} /> },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="My Profile" subtitle="Your driver record and licence details" />
      <div className="panel divide-y divide-base-700">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 px-5 py-3">
            <div className="text-xs uppercase tracking-wide text-ink-500">{r.label}</div>
            <div className="text-sm text-ink-100">{r.value}</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-ink-500">Contact an administrator to correct any details on your driver record.</p>
    </div>
  );
}
