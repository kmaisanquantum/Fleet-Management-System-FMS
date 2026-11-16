import { FormEvent, useEffect, useState } from "react";
import { api } from "../../api/client";
import { IncidentReport } from "../../types";
import { EmptyState, Field, Modal, PageHeader, PhotoUpload, StatusBadge } from "./shared";

const TYPES = ["accident", "incident", "near_miss", "damage", "theft", "other"];

export default function Incidents() {
  const [incidents, setIncidents] = useState<IncidentReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [incidentType, setIncidentType] = useState("accident");
  const [incidentDate, setIncidentDate] = useState(new Date().toISOString().slice(0, 10));
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [injuries, setInjuries] = useState(false);
  const [injuryDetails, setInjuryDetails] = useState("");
  const [damageDescription, setDamageDescription] = useState("");
  const [thirdPartyDetails, setThirdPartyDetails] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [documents, setDocuments] = useState<string[]>([]);

  function load() {
    api
      .get<{ data: IncidentReport[] }>("/driver-portal/incidents")
      .then((res) => setIncidents(res.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/driver-portal/incidents", {
        incidentType,
        incidentDate,
        location: location || undefined,
        description,
        injuries,
        injuryDetails: injuryDetails || undefined,
        damageDescription: damageDescription || undefined,
        thirdPartyDetails: thirdPartyDetails || undefined,
        photoUrls: photos,
        documentUrls: documents,
      });
      setShowForm(false);
      setDescription("");
      setInjuries(false);
      setInjuryDetails("");
      setDamageDescription("");
      setThirdPartyDetails("");
      setPhotos([]);
      setDocuments([]);
      load();
    } catch (err: any) {
      setError(err.message || "Failed to submit report");
    }
  }

  if (loading) return <div className="p-4 text-ink-400">Loading incident reports…</div>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Accident & Incident Reports"
        subtitle="Report accidents, damage and near-misses to fleet administration"
        action={<button className="btn-primary" onClick={() => setShowForm(true)}>New Report</button>}
      />

      {incidents.length === 0 ? (
        <div className="panel"><EmptyState>You have no incident reports.</EmptyState></div>
      ) : (
        <div className="space-y-3">
          {incidents.map((i) => (
            <div key={i.id} className="panel p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-ink-100 capitalize">{i.incident_type.replace(/_/g, " ")} · {i.incident_date}</div>
                <div className="flex gap-2">
                  {i.injuries === 1 && <StatusBadge value="critical" />}
                  <StatusBadge value={i.status} />
                </div>
              </div>
              <div className="text-sm text-ink-300 mt-1">{i.description}</div>
              {i.location && <div className="text-xs text-ink-500 mt-1">{i.location}</div>}
              {i.admin_notes && <div className="text-xs text-ink-300 mt-1">Admin: {i.admin_notes}</div>}
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <Modal title="Accident / Incident Report" onClose={() => setShowForm(false)}>
          <form onSubmit={handleSubmit} className="space-y-3">
            {error && <div className="text-sm text-signal-red">{error}</div>}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Type *</label>
                <select className="input" value={incidentType} onChange={(e) => setIncidentType(e.target.value)}>
                  {TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
                </select>
              </div>
              <Field label="Date *" type="date" value={incidentDate} onChange={(e) => setIncidentDate(e.target.value)} required />
            </div>
            <Field label="Location" value={location} onChange={(e) => setLocation(e.target.value)} />
            <div>
              <label className="label">Description *</label>
              <textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} required />
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-200">
              <input type="checkbox" checked={injuries} onChange={(e) => setInjuries(e.target.checked)} />
              Injuries were involved
            </label>
            {injuries && (
              <div>
                <label className="label">Injury Details</label>
                <textarea className="input" rows={2} value={injuryDetails} onChange={(e) => setInjuryDetails(e.target.value)} />
              </div>
            )}
            <div>
              <label className="label">Damage Description</label>
              <textarea className="input" rows={2} value={damageDescription} onChange={(e) => setDamageDescription(e.target.value)} />
            </div>
            <div>
              <label className="label">Third Party Details</label>
              <textarea className="input" rows={2} value={thirdPartyDetails} onChange={(e) => setThirdPartyDetails(e.target.value)} />
            </div>
            <PhotoUpload label="Photos" value={photos} onChange={setPhotos} capture />
            <PhotoUpload label="Supporting Documents" value={documents} onChange={setDocuments} />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn-primary">Submit Report</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
