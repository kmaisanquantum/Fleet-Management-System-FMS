import { useEffect, useMemo, useState } from "react";
import {
  fuelCardsApi,
  type FuelCard,
  type FuelCardOptions,
  type FuelCardSummary,
  type FuelCardTransaction,
} from "../api/fuelCards";

function pgt(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-AU", { timeZone: "Pacific/Port_Moresby", hour12: false });
}

function dateTimeInput(date = new Date()): string {
  return new Date(date.getTime() + 10 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

function money(value: number | null | undefined): string {
  return value == null ? "—" : `PGK ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const EMPTY_CARD = {
  cardNumber: "",
  provider: "",
  vehicleId: "",
  imei: "",
  driverId: "",
  status: "active" as FuelCard["status"],
  dailyLimitLiters: "",
  monthlyLimitAmount: "",
  notes: "",
};

const EMPTY_SWIPE = {
  cardId: "",
  transactionAt: "",
  stationName: "",
  stationLat: "",
  stationLon: "",
  liters: "",
  amount: "",
  currency: "PGK",
  gpsLat: "",
  gpsLon: "",
};

function emptySwipe() {
  return { ...EMPTY_SWIPE, transactionAt: dateTimeInput() };
}

export default function FuelCards() {
  const [cards, setCards] = useState<FuelCard[]>([]);
  const [transactions, setTransactions] = useState<FuelCardTransaction[]>([]);
  const [summary, setSummary] = useState<FuelCardSummary | null>(null);
  const [options, setOptions] = useState<FuelCardOptions>({ vehicles: [], drivers: [], depots: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tab, setTab] = useState<"cards" | "transactions">("cards");
  const [statusFilter, setStatusFilter] = useState("all");
  const [txnStatusFilter, setTxnStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  const [cardModal, setCardModal] = useState(false);
  const [editingCard, setEditingCard] = useState<FuelCard | null>(null);
  const [cardForm, setCardForm] = useState({ ...EMPTY_CARD });
  const [savingCard, setSavingCard] = useState(false);

  const [swipeModal, setSwipeModal] = useState(false);
  const [swipeForm, setSwipeForm] = useState(emptySwipe);
  const [savingSwipe, setSavingSwipe] = useState(false);
  const [importing, setImporting] = useState(false);

  const selectedSwipeCard = useMemo(() => cards.find((card) => card.id === swipeForm.cardId), [cards, swipeForm.cardId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [cardRes, txnRes, summaryRes, optionRes] = await Promise.all([
        fuelCardsApi.list({ status: statusFilter === "all" ? undefined : statusFilter, search: search || undefined }),
        fuelCardsApi.transactions({ status: txnStatusFilter === "all" ? undefined : txnStatusFilter, limit: 250 }),
        fuelCardsApi.summary(),
        fuelCardsApi.options(),
      ]);
      setCards(cardRes.data);
      setTransactions(txnRes.data);
      setSummary(summaryRes.data);
      setOptions(optionRes.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load fuel cards");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, txnStatusFilter]);

  function openNewCard() {
    setEditingCard(null);
    setCardForm({ ...EMPTY_CARD });
    setCardModal(true);
  }

  function openEditCard(card: FuelCard) {
    setEditingCard(card);
    setCardForm({
      cardNumber: card.card_number,
      provider: card.provider ?? "",
      vehicleId: card.resolved_vehicle_id ?? card.assigned_vehicle_id ?? card.vehicle_id ?? "",
      imei: card.assigned_imei ?? "",
      driverId: card.assigned_driver_id ?? card.authorised_driver_id ?? "",
      status: card.status,
      dailyLimitLiters: card.daily_limit_liters == null ? "" : String(card.daily_limit_liters),
      monthlyLimitAmount: card.monthly_limit_amount == null ? "" : String(card.monthly_limit_amount),
      notes: card.notes ?? "",
    });
    setCardModal(true);
  }

  function setVehicle(vehicleId: string) {
    const vehicle = options.vehicles.find((item) => item.id === vehicleId);
    setCardForm((current) => ({ ...current, vehicleId, imei: vehicle?.imei ?? current.imei }));
  }

  async function saveCard(event: React.FormEvent) {
    event.preventDefault();
    setSavingCard(true);
    setError(null);
    setMessage(null);
    try {
      const body = {
        cardNumber: cardForm.cardNumber.trim(),
        provider: cardForm.provider.trim() || null,
        vehicleId: cardForm.vehicleId || null,
        imei: cardForm.imei.trim() || null,
        driverId: cardForm.driverId || null,
        status: cardForm.status,
        dailyLimitLiters: cardForm.dailyLimitLiters ? Number(cardForm.dailyLimitLiters) : null,
        monthlyLimitAmount: cardForm.monthlyLimitAmount ? Number(cardForm.monthlyLimitAmount) : null,
        notes: cardForm.notes.trim() || null,
      };
      if (editingCard) {
        await fuelCardsApi.update(editingCard.id, body);
        setMessage(`Fuel card ${body.cardNumber} updated`);
      } else {
        await fuelCardsApi.create(body);
        setMessage(`Fuel card ${body.cardNumber} registered`);
      }
      setCardModal(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save fuel card");
    } finally {
      setSavingCard(false);
    }
  }

  async function toggleCard(card: FuelCard) {
    const next = card.status === "active" ? "suspended" : "active";
    setError(null);
    setMessage(null);
    try {
      await fuelCardsApi.update(card.id, { status: next });
      setMessage(`Fuel card ${card.card_number} ${next === "active" ? "reactivated" : "suspended"}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update card status");
    }
  }

  function openSwipe(card?: FuelCard) {
    setSwipeForm({ ...emptySwipe(), cardId: card?.id ?? cards[0]?.id ?? "" });
    setSwipeModal(true);
  }

  async function saveSwipe(event: React.FormEvent) {
    event.preventDefault();
    if (!swipeForm.cardId) return;
    setSavingSwipe(true);
    setError(null);
    setMessage(null);
    try {
      const result = await fuelCardsApi.swipe(swipeForm.cardId, {
        transactionAt: swipeForm.transactionAt || undefined,
        stationName: swipeForm.stationName || undefined,
        stationLat: swipeForm.stationLat ? Number(swipeForm.stationLat) : undefined,
        stationLon: swipeForm.stationLon ? Number(swipeForm.stationLon) : undefined,
        liters: Number(swipeForm.liters),
        amount: swipeForm.amount ? Number(swipeForm.amount) : undefined,
        currency: swipeForm.currency || "PGK",
        gpsLat: swipeForm.gpsLat ? Number(swipeForm.gpsLat) : undefined,
        gpsLon: swipeForm.gpsLon ? Number(swipeForm.gpsLon) : undefined,
      });
      setSwipeModal(false);
      setMessage(
        result.reconciliation.status === "flagged"
          ? `Swipe flagged and ${result.reconciliation.alertsCreated} alert(s) queued`
          : "Swipe matched the vehicle GPS and card limits"
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to log swipe");
    } finally {
      setSavingSwipe(false);
    }
  }

  async function importCsv(file: File | null) {
    if (!file) return;
    setImporting(true);
    setError(null);
    setMessage(null);
    try {
      const result = await fuelCardsApi.importCsv(await file.text());
      setMessage(
        `Imported ${result.data.imported} transactions (${result.data.flagged} flagged, ${result.data.duplicates} duplicates skipped)` +
          (result.data.errors.length ? `. ${result.data.errors.length} row error(s).` : ".")
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "CSV import failed");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink-100">Fuel Cards</h1>
          <p className="text-sm text-ink-400 mt-1">
            Register cards, log swipes and reconcile every transaction against vehicle GPS and card limits.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={openNewCard} className="btn-primary text-xs px-4 py-2">+ Register card</button>
          <button onClick={() => openSwipe()} className="btn-secondary text-xs px-4 py-2">Log swipe</button>
          <label className={`btn-secondary text-xs px-4 py-2 cursor-pointer ${importing ? "opacity-60" : ""}`}>
            {importing ? "Importing…" : "Import CSV"}
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              disabled={importing}
              onChange={(event) => void importCsv(event.target.files?.[0] ?? null)}
            />
          </label>
        </div>
      </div>

      {error && <div className="p-3 rounded-lg bg-signal-red/10 text-signal-red text-sm">{error}</div>}
      {message && <div className="p-3 rounded-lg bg-signal-green/10 text-signal-green text-sm">{message}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="panel p-4">
          <div className="text-[10px] uppercase tracking-wide text-ink-500">Cards</div>
          <div className="font-data text-2xl font-semibold text-ink-100 mt-1">{summary?.cards.total ?? cards.length}</div>
        </div>
        <div className="panel p-4">
          <div className="text-[10px] uppercase tracking-wide text-ink-500">Active</div>
          <div className="font-data text-2xl font-semibold text-signal-green mt-1">{summary?.cards.active ?? 0}</div>
        </div>
        <div className="panel p-4">
          <div className="text-[10px] uppercase tracking-wide text-ink-500">Flagged swipes</div>
          <div className="font-data text-2xl font-semibold text-signal-red mt-1">{summary?.transactions.flagged ?? 0}</div>
        </div>
        <div className="panel p-4">
          <div className="text-[10px] uppercase tracking-wide text-ink-500">Litres reconciled</div>
          <div className="font-data text-2xl font-semibold text-ink-100 mt-1">
            {(summary?.transactions.liters ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} L
          </div>
        </div>
        <div className="panel p-4">
          <div className="text-[10px] uppercase tracking-wide text-ink-500">Card spend</div>
          <div className="font-data text-2xl font-semibold text-ink-100 mt-1">{money(summary?.transactions.amount)}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-base-700">
        <div className="flex gap-1">
          {(["cards", "transactions"] as const).map((item) => (
            <button
              key={item}
              onClick={() => setTab(item)}
              className={`px-4 py-2 text-sm border-b-2 -mb-px capitalize ${
                tab === item ? "border-amber-400 text-ink-100" : "border-transparent text-ink-400 hover:text-ink-100"
              }`}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          {tab === "cards" ? (
            <>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="input text-xs">
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="lost">Lost</option>
                <option value="blocked">Blocked</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <input
                className="input text-xs"
                placeholder="Search card, provider or notes"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void load();
                }}
              />
              <button className="btn-secondary text-xs px-3 py-2" onClick={() => void load()}>Search</button>
            </>
          ) : (
            <select value={txnStatusFilter} onChange={(event) => setTxnStatusFilter(event.target.value)} className="input text-xs">
              <option value="all">All reconciliations</option>
              <option value="matched">Matched</option>
              <option value="flagged">Flagged</option>
            </select>
          )}
        </div>
      </div>

      {loading ? (
        <div className="panel p-10 text-center text-ink-400">Loading fuel cards…</div>
      ) : tab === "cards" ? (
        <div className="panel overflow-x-auto">
          <table className="table-shell">
            <thead>
              <tr>
                <th>Card</th>
                <th>Provider</th>
                <th>Assigned vehicle</th>
                <th>Driver</th>
                <th>IMEI</th>
                <th>Status</th>
                <th>Daily limit</th>
                <th>Monthly limit</th>
                <th>Swipes</th>
                <th>Flagged</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {cards.length === 0 ? (
                <tr><td colSpan={11} className="text-center text-ink-500 py-8">No fuel cards registered.</td></tr>
              ) : cards.map((card) => (
                <tr key={card.id}>
                  <td className="font-data text-ink-100">{card.card_number}</td>
                  <td>{card.provider || "—"}</td>
                  <td>{card.vehicle_number ? `${card.vehicle_number} · ${card.registration_number}` : "Unassigned"}</td>
                  <td>{card.driver_name || "Unassigned"}</td>
                  <td className="font-data text-xs">{card.assigned_imei || "—"}</td>
                  <td>
                    <span className={`pill ${card.status === "active" ? "bg-signal-green/15 text-signal-green" : card.status === "lost" ? "bg-signal-red/15 text-signal-red" : "bg-amber-400/15 text-amber-400"}`}>
                      {card.status}
                    </span>
                  </td>
                  <td className="font-data">{card.daily_limit_liters ? `${card.daily_limit_liters} L` : "—"}</td>
                  <td className="font-data">{money(card.monthly_limit_amount)}</td>
                  <td className="font-data">{card.transaction_count}</td>
                  <td className={`font-data ${Number(card.flagged_count) > 0 ? "text-signal-red" : ""}`}>{card.flagged_count}</td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      <button className="text-amber-400 hover:text-amber-300 text-xs" onClick={() => openEditCard(card)}>Edit</button>
                      <button className="text-ink-300 hover:text-ink-100 text-xs" onClick={() => openSwipe(card)}>Swipe</button>
                      <button className="text-ink-300 hover:text-ink-100 text-xs" onClick={() => void toggleCard(card)}>
                        {card.status === "active" ? "Block" : "Activate"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="table-shell">
            <thead>
              <tr>
                <th>Time</th>
                <th>Card</th>
                <th>Vehicle</th>
                <th>Station</th>
                <th>Litres</th>
                <th>Amount</th>
                <th>GPS distance</th>
                <th>Status</th>
                <th>Flag reason</th>
              </tr>
            </thead>
            <tbody>
              {transactions.length === 0 ? (
                <tr><td colSpan={9} className="text-center text-ink-500 py-8">No card transactions yet.</td></tr>
              ) : transactions.map((txn) => (
                <tr key={txn.id}>
                  <td className="whitespace-nowrap font-data text-xs">{pgt(txn.transaction_at)}</td>
                  <td className="font-data text-ink-100">{txn.card_number}</td>
                  <td>{txn.vehicle_number ? `${txn.vehicle_number} · ${txn.registration_number}` : "Unassigned"}</td>
                  <td>{txn.station_name || "—"}</td>
                  <td className="font-data">{txn.liters} L</td>
                  <td className="font-data">{money(txn.amount)}</td>
                  <td className="font-data">{txn.distance_km == null ? "—" : `${txn.distance_km} km`}</td>
                  <td>
                    <span className={`pill ${txn.status === "matched" ? "bg-signal-green/15 text-signal-green" : "bg-signal-red/15 text-signal-red"}`}>
                      {txn.status}
                    </span>
                  </td>
                  <td className="text-xs max-w-md">{txn.flag_reason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cardModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-base-900 border border-base-700 rounded-xl p-6 w-full max-w-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-bold text-ink-100">{editingCard ? "Edit fuel card" : "Register fuel card"}</h2>
            <form onSubmit={saveCard} className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="label">Card number</label>
                  <input required className="input text-xs font-mono" value={cardForm.cardNumber} onChange={(event) => setCardForm({ ...cardForm, cardNumber: event.target.value })} />
                </div>
                <div>
                  <label className="label">Provider</label>
                  <input className="input text-xs" placeholder="e.g. Puma, TotalEnergies" value={cardForm.provider} onChange={(event) => setCardForm({ ...cardForm, provider: event.target.value })} />
                </div>
                <div>
                  <label className="label">Assigned vehicle</label>
                  <select className="input text-xs" value={cardForm.vehicleId} onChange={(event) => setVehicle(event.target.value)}>
                    <option value="">Unassigned</option>
                    {options.vehicles.map((vehicle) => (
                      <option key={vehicle.id} value={vehicle.id}>{vehicle.vehicle_number} · {vehicle.registration_number}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Assigned IMEI</label>
                  <input className="input text-xs font-mono" value={cardForm.imei} onChange={(event) => setCardForm({ ...cardForm, imei: event.target.value })} />
                </div>
                <div>
                  <label className="label">Assigned driver</label>
                  <select className="input text-xs" value={cardForm.driverId} onChange={(event) => setCardForm({ ...cardForm, driverId: event.target.value })}>
                    <option value="">Unassigned</option>
                    {options.drivers.map((driver) => (
                      <option key={driver.id} value={driver.id}>{driver.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Status</label>
                  <select className="input text-xs" value={cardForm.status} onChange={(event) => setCardForm({ ...cardForm, status: event.target.value as FuelCard["status"] })}>
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                    <option value="lost">Lost</option>
                    <option value="blocked">Blocked</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
                <div>
                  <label className="label">Daily limit (litres)</label>
                  <input type="number" step="0.1" min="0" className="input text-xs" value={cardForm.dailyLimitLiters} onChange={(event) => setCardForm({ ...cardForm, dailyLimitLiters: event.target.value })} />
                </div>
                <div>
                  <label className="label">Monthly limit (PGK)</label>
                  <input type="number" step="0.01" min="0" className="input text-xs" value={cardForm.monthlyLimitAmount} onChange={(event) => setCardForm({ ...cardForm, monthlyLimitAmount: event.target.value })} />
                </div>
              </div>
              <div>
                <label className="label">Notes</label>
                <textarea className="input text-xs w-full" rows={3} value={cardForm.notes} onChange={(event) => setCardForm({ ...cardForm, notes: event.target.value })} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" className="btn-secondary text-xs px-4 py-2" onClick={() => setCardModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary text-xs px-4 py-2" disabled={savingCard}>{savingCard ? "Saving…" : "Save card"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {swipeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-base-900 border border-base-700 rounded-xl p-6 w-full max-w-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-bold text-ink-100">Log fuel card swipe</h2>
            <form onSubmit={saveSwipe} className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="label">Fuel card</label>
                  <select required className="input text-xs" value={swipeForm.cardId} onChange={(event) => setSwipeForm({ ...swipeForm, cardId: event.target.value })}>
                    <option value="">Select card</option>
                    {cards.map((card) => (
                      <option key={card.id} value={card.id}>{card.card_number} · {card.vehicle_number ?? "Unassigned"}</option>
                    ))}
                  </select>
                  {selectedSwipeCard && (
                    <div className="text-[11px] text-ink-500 mt-1">
                      {selectedSwipeCard.vehicle_number ?? "No vehicle"} · {selectedSwipeCard.assigned_imei ?? "No IMEI"} · {selectedSwipeCard.status}
                    </div>
                  )}
                </div>
                <div>
                  <label className="label">Transaction time (PGT)</label>
                  <input required type="datetime-local" className="input text-xs" value={swipeForm.transactionAt} onChange={(event) => setSwipeForm({ ...swipeForm, transactionAt: event.target.value })} />
                </div>
                <div>
                  <label className="label">Station name</label>
                  <input className="input text-xs" value={swipeForm.stationName} onChange={(event) => setSwipeForm({ ...swipeForm, stationName: event.target.value })} />
                </div>
                <div>
                  <label className="label">Currency</label>
                  <input className="input text-xs" value={swipeForm.currency} onChange={(event) => setSwipeForm({ ...swipeForm, currency: event.target.value })} />
                </div>
                <div>
                  <label className="label">Station latitude</label>
                  <input type="number" step="any" className="input text-xs" value={swipeForm.stationLat} onChange={(event) => setSwipeForm({ ...swipeForm, stationLat: event.target.value })} />
                </div>
                <div>
                  <label className="label">Station longitude</label>
                  <input type="number" step="any" className="input text-xs" value={swipeForm.stationLon} onChange={(event) => setSwipeForm({ ...swipeForm, stationLon: event.target.value })} />
                </div>
                <div>
                  <label className="label">Litres</label>
                  <input required type="number" step="0.01" min="0.01" className="input text-xs" value={swipeForm.liters} onChange={(event) => setSwipeForm({ ...swipeForm, liters: event.target.value })} />
                </div>
                <div>
                  <label className="label">Amount</label>
                  <input type="number" step="0.01" min="0" className="input text-xs" value={swipeForm.amount} onChange={(event) => setSwipeForm({ ...swipeForm, amount: event.target.value })} />
                </div>
                <div>
                  <label className="label">Recorded GPS latitude (optional)</label>
                  <input type="number" step="any" className="input text-xs" value={swipeForm.gpsLat} onChange={(event) => setSwipeForm({ ...swipeForm, gpsLat: event.target.value })} />
                </div>
                <div>
                  <label className="label">Recorded GPS longitude (optional)</label>
                  <input type="number" step="any" className="input text-xs" value={swipeForm.gpsLon} onChange={(event) => setSwipeForm({ ...swipeForm, gpsLon: event.target.value })} />
                </div>
              </div>
              <p className="text-[11px] text-ink-500">
                Leave GPS blank to reconcile against the vehicle&apos;s nearest telemetry fix around the transaction time.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" className="btn-secondary text-xs px-4 py-2" onClick={() => setSwipeModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary text-xs px-4 py-2" disabled={savingSwipe}>{savingSwipe ? "Logging…" : "Log and reconcile"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
