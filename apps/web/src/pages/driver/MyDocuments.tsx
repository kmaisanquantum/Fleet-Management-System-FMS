import { FormEvent, useEffect, useState } from "react";
import { api } from "../../api/client";
import { DriverDocument } from "../../types";
import { EmptyState, Field, Modal, PageHeader, PhotoUpload, StatusBadge } from "./shared";

interface DocumentsResponse {
  data: DriverDocument[];
  licence: { licenceNumber: string; licenceClass: string | null; licenceExpiry: string } | null;
}

const DOC_TYPES = ["licence", "permit", "medical", "certification", "insurance", "other"];

export default function MyDocuments() {
  const [documents, setDocuments] = useState<DriverDocument[]>([]);
  const [licence, setLicence] = useState<DocumentsResponse["licence"]>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [documentType, setDocumentType] = useState("licence");
  const [title, setTitle] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [files, setFiles] = useState<string[]>([]);

  function load() {
    api
      .get<DocumentsResponse>("/driver-portal/documents")
      .then((res) => {
        setDocuments(res.data || []);
        setLicence(res.licence);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (files.length === 0) {
      setError("Please attach a document file.");
      return;
    }
    try {
      await api.post("/driver-portal/documents", {
        documentType,
        title,
        fileUrl: files[0],
        expiryDate: expiryDate || undefined,
      });
      setShowForm(false);
      setTitle("");
      setExpiryDate("");
      setFiles([]);
      load();
    } catch (err: any) {
      setError(err.message || "Failed to upload document");
    }
  }

  if (loading) return <div className="p-4 text-ink-400">Loading documents…</div>;

  const licenceExpiringSoon = licence?.licenceExpiry && new Date(licence.licenceExpiry).getTime() - Date.now() < 90 * 864e5;

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Documents"
        subtitle="Upload your licences, permits and certifications"
        action={<button className="btn-primary" onClick={() => setShowForm(true)}>Upload Document</button>}
      />

      {licence && (
        <div className="panel p-5">
          <h2 className="font-display font-semibold text-ink-100 mb-2">Licence</h2>
          <div className="text-sm text-ink-200">
            {licence.licenceNumber} {licence.licenceClass ? `· Class ${licence.licenceClass}` : ""}
          </div>
          <div className={`text-sm mt-1 ${licenceExpiringSoon ? "text-signal-red" : "text-ink-400"}`}>
            Expires {licence.licenceExpiry} {licenceExpiringSoon && "· expiring soon"}
          </div>
        </div>
      )}

      {documents.length === 0 ? (
        <div className="panel"><EmptyState>No documents uploaded.</EmptyState></div>
      ) : (
        <div className="panel divide-y divide-base-700">
          {documents.map((d) => (
            <div key={d.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-5 py-3">
              <div>
                <div className="text-sm text-ink-100">{d.title}</div>
                <div className="text-xs text-ink-500 capitalize">
                  {d.document_type}{d.expiry_date ? ` · expires ${d.expiry_date}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-3">
                {d.file_url && <a className="text-xs text-amber-400 hover:underline" href={d.file_url} target="_blank" rel="noreferrer">View</a>}
                <StatusBadge value={d.status} />
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <Modal title="Upload Document" onClose={() => setShowForm(false)}>
          <form onSubmit={handleSubmit} className="space-y-3">
            {error && <div className="text-sm text-signal-red">{error}</div>}
            <div>
              <label className="label">Document Type *</label>
              <select className="input" value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
                {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <Field label="Title *" value={title} onChange={(e) => setTitle(e.target.value)} required />
            <Field label="Expiry Date" type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
            <PhotoUpload label="File *" value={files} onChange={setFiles} multiple={false} />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn-primary">Upload</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
