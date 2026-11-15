"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Button, ErrorNote, Field, inputCls, Panel } from "@/components/ui";
import { del, get, post, type WatchEntry } from "@/lib/api";
import { readViewState } from "@/lib/viewstate";

function Watchlists() {
  const v = readViewState(useSearchParams());
  const [list, setList] = useState<WatchEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ label: "", ra: v.ra?.toString() ?? "", dec: v.dec?.toString() ?? "", radius_deg: "0.01" });
  const load = () => get<WatchEntry[]>("/api/watchlists").then(setList).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id); setErr(null);
    try { await fn(); await load(); } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  }

  return (
    <div className="p-4 max-w-[1200px] w-full mx-auto flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Watchlists</h1>
        <p className="text-[12px] text-muted max-w-3xl">Saved regions, candidates and investigations. A check re-queries the IRSA archive and lists SPHEREx products released since the previous check. SPHEREx data are published in batches (weekly quick releases and periodic data releases), so “new” means newly released, not observed in real time.</p>
      </div>
      <ErrorNote error={err} />
      <div className="grid lg:grid-cols-[1fr_340px] gap-4">
        <Panel title={`Watched (${list?.length ?? 0})`}>
          {list && list.length === 0 && <p className="text-[13px] text-muted">Nothing watched yet. Add a region here, or use “Add to watchlist” on a candidate or investigation.</p>}
          <ul className="divide-y divide-line">
            {list?.map((w) => (
              <li key={w.id} className="py-3 flex flex-col gap-1 text-[12px]">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-medium">{w.label}</span>
                  <span className="text-[10px] uppercase tracking-wider text-faint">{w.kind}</span>
                  {w.kind === "candidate" && w.ref_id && <Link className="num text-accent" href={`/discovery/${w.ref_id}`}>{w.ref_id}</Link>}
                  {w.kind === "investigation" && w.ref_id && <Link className="num text-accent" href={`/investigations/${w.ref_id}`}>{w.ref_id}</Link>}
                  <Link className="num text-muted hover:text-accent" href={`/timeline?ra=${w.ra}&dec=${w.dec}&det=1`}>{w.ra.toFixed(4)}, {w.dec.toFixed(4)}</Link>
                  <span className="ml-auto flex gap-2">
                    <Button disabled={busy === w.id} onClick={() => act(w.id, () => post(`/api/watchlists/${w.id}/check`, {}))}>{busy === w.id ? "Checking…" : "Check now"}</Button>
                    <Button variant="ghost" onClick={() => act(w.id, () => del(`/api/watchlists/${w.id}`))}>Remove</Button>
                  </span>
                </div>
                <p className="text-muted num">{w.n_known_products} products known · last check {w.last_checked_at ? w.last_checked_at.slice(0, 16).replace("T", " ") : "never"} · <span className={w.last_new_count ? "text-warn" : ""}>{w.last_new_count} new at last check</span></p>
                {w.checks.length > 0 && (
                  <details><summary className="cursor-pointer text-faint">Check history ({w.checks.length})</summary>
                    <ul className="num text-[11px] text-faint mt-1">
                      {w.checks.map((c, i) => <li key={i}>{c.checked_at.slice(0, 16).replace("T", " ")} · {c.status} · {c.message}{c.new_products.length ? `: ${c.new_products.slice(0, 6).join(", ")}${c.new_products.length > 6 ? "…" : ""}` : ""}</li>)}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Watch a region">
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); act("new", () => post("/api/watchlists", { kind: "region", label: form.label, ra: Number(form.ra), dec: Number(form.dec), radius_deg: Number(form.radius_deg) })); }}>
            <Field label="Label"><input className={inputCls} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. M31 nucleus" /></Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="RA °"><input required className={`${inputCls} num`} value={form.ra} onChange={(e) => setForm({ ...form, ra: e.target.value })} /></Field>
              <Field label="Dec °"><input required className={`${inputCls} num`} value={form.dec} onChange={(e) => setForm({ ...form, dec: e.target.value })} /></Field>
              <Field label="Radius °"><input className={`${inputCls} num`} value={form.radius_deg} onChange={(e) => setForm({ ...form, radius_deg: e.target.value })} /></Field>
            </div>
            <Button variant="primary" type="submit" disabled={busy === "new"}>{busy === "new" ? "Recording baseline…" : "Watch region"}</Button>
            <p className="text-[11px] text-faint">The first check records the products already released as a baseline. Background re-checks run on the server only if STM_WATCH_INTERVAL_HOURS is set.</p>
          </form>
        </Panel>
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense><Watchlists /></Suspense>;
}
