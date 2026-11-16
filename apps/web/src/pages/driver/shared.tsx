import { InputHTMLAttributes, ReactNode, useState } from "react";
import { uploadFiles } from "../../api/client";

/** Compact page heading used across the Driver Portal. */
export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-display font-semibold text-ink-100">{title}</h1>
        {subtitle && <p className="text-sm text-ink-400 mt-1">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="px-4 py-8 text-center text-ink-500 text-sm">{children}</div>;
}

const STATUS_STYLES: Record<string, string> = {
  pass: "bg-emerald-950 text-signal-green border-emerald-800",
  satisfactory: "bg-emerald-950 text-signal-green border-emerald-800",
  approved: "bg-emerald-950 text-signal-green border-emerald-800",
  verified: "bg-emerald-950 text-signal-green border-emerald-800",
  cleared: "bg-emerald-950 text-signal-green border-emerald-800",
  resolved: "bg-emerald-950 text-signal-green border-emerald-800",
  closed: "bg-emerald-950 text-signal-green border-emerald-800",
  completed: "bg-emerald-950 text-signal-green border-emerald-800",
  requires_attention: "bg-amber-950 text-amber-400 border-amber-800",
  pending: "bg-amber-950 text-amber-400 border-amber-800",
  submitted: "bg-amber-950 text-amber-400 border-amber-800",
  under_review: "bg-amber-950 text-amber-400 border-amber-800",
  acknowledged: "bg-amber-950 text-amber-400 border-amber-800",
  scheduled: "bg-amber-950 text-amber-400 border-amber-800",
  in_progress: "bg-amber-950 text-amber-400 border-amber-800",
  investigating: "bg-amber-950 text-amber-400 border-amber-800",
  open: "bg-amber-950 text-amber-400 border-amber-800",
  na: "bg-base-800 text-ink-400 border-base-600",
  fail: "bg-red-950 text-signal-red border-red-800",
  defective: "bg-red-950 text-signal-red border-red-800",
  rejected: "bg-red-950 text-signal-red border-red-800",
  critical: "bg-red-950 text-signal-red border-red-800",
  major: "bg-amber-950 text-amber-400 border-amber-800",
  minor: "bg-base-800 text-ink-300 border-base-600",
  cancelled: "bg-base-800 text-ink-400 border-base-600",
  expired: "bg-red-950 text-signal-red border-red-800",
};

export function StatusBadge({ value }: { value: string | null | undefined }) {
  const v = (value ?? "unknown").toLowerCase();
  const cls = STATUS_STYLES[v] ?? "bg-base-800 text-ink-300 border-base-600";
  return <span className={`inline-block px-2 py-0.5 text-xs rounded font-medium border ${cls}`}>{v.replace(/_/g, " ")}</span>;
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
}

export function Field({ label, hint, className, ...rest }: FieldProps) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className={`input ${className ?? ""}`} {...rest} />
    </div>
  );
}

interface PhotoUploadProps {
  label?: string;
  value: string[];
  onChange: (urls: string[]) => void;
  multiple?: boolean;
  /** Enables camera capture on phones. */
  capture?: boolean;
}

/**
 * Uploads photos/documents and exposes the resulting URLs. Uploads immediately
 * on selection via the Driver Portal uploads endpoint (mime + size validated
 * server-side); the URLs are then submitted with the parent form.
 */
export function PhotoUpload({ label = "Photos", value, onChange, multiple = true, capture = false }: PhotoUploadProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const uploaded = await uploadFiles(files);
      onChange([...value, ...uploaded.map((u) => u.url)]);
    } catch (err: any) {
      setError(err.message || "Upload failed");
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  return (
    <div>
      <label className="label">{label}</label>
      <input
        type="file"
        accept="image/*,application/pdf"
        multiple={multiple}
        {...(capture ? { capture: "environment" as const } : {})}
        onChange={handleChange}
        className="block w-full text-sm text-ink-300 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-amber-400 file:text-base-950 hover:file:bg-amber-500"
      />
      {busy && <div className="text-xs text-ink-400 mt-1">Uploading…</div>}
      {error && <div className="text-xs text-signal-red mt-1">{error}</div>}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {value.map((url) => (
            <div key={url} className="relative group">
              {url.endsWith(".pdf") ? (
                <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center h-16 px-3 bg-base-900 border border-base-600 rounded text-xs text-ink-300">
                  PDF
                </a>
              ) : (
                <img src={url} alt="upload" className="h-16 w-16 object-cover rounded border border-base-600" />
              )}
              <button
                type="button"
                onClick={() => onChange(value.filter((v) => v !== url))}
                className="absolute -top-2 -right-2 bg-signal-red text-base-950 rounded-full w-5 h-5 text-xs leading-5"
                aria-label="Remove attachment"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="panel p-5 sm:p-6 w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-b-none sm:rounded-lg">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-display font-semibold text-ink-100">{title}</h2>
          <button type="button" onClick={onClose} className="text-ink-400 hover:text-ink-100 text-xl leading-none" aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
