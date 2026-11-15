"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { get, type Investigation, post } from "@/lib/api";
import { Button, inputCls } from "./ui";

/** Save a record (candidate, comparison, spectrum, region) into a persistent investigation. */
export function SaveToInvestigation({ kind, refId, label, defaults }: {
  kind: "candidate" | "comparison" | "spectrum" | "region" | "observation";
  refId: string;
  label?: string;
  defaults?: { ra?: number; dec?: number };
}) {
  const [invs, setInvs] = useState<Investigation[]>([]);
  const [target, setTarget] = useState("__new");
  const [title, setTitle] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { get<Investigation[]>("/api/investigations").then((l) => { setInvs(l); setTarget(l[0]?.id ?? "__new"); }).catch(() => {}); }, []);

  async function save() {
    setMsg(null);
    try {
      let id = target;
      if (target === "__new") {
        const inv = await post<Investigation>("/api/investigations", { title: title || `Investigation of ${refId}`, ra: defaults?.ra ?? null, dec: defaults?.dec ?? null, radius_deg: defaults?.ra != null ? 0.1 : null });
        id = inv.id;
        setInvs((l) => [inv, ...l]);
        setTarget(id);
      }
      await post(`/api/investigations/${id}/items`, { kind, ref_id: refId, label: label ?? "" });
      setMsg(id);
    } catch (e: any) { setMsg(`error: ${e.message}`); }
  }

  return (
    <div className="flex flex-col gap-2 text-[12px]">
      <div className="flex gap-2">
        <label className="sr-only" htmlFor={`inv-${refId}`}>Investigation</label>
        <select id={`inv-${refId}`} className={`${inputCls} flex-1 min-w-0`} value={target} onChange={(e) => setTarget(e.target.value)}>
          {invs.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
          <option value="__new">+ New investigation…</option>
        </select>
        <Button onClick={save}>Save</Button>
      </div>
      {target === "__new" && <input className={inputCls} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="New investigation title" />}
      {msg && (msg.startsWith("error") ? <p className="text-bad">{msg}</p> : <p className="text-good" role="status">Saved to <Link className="underline" href={`/investigations/${msg}`}>{msg}</Link></p>)}
    </div>
  );
}

export function WatchButton({ kind, refId, ra, dec, label }: { kind: "region" | "candidate" | "investigation"; refId?: string; ra?: number; dec?: number; label?: string }) {
  const [state, setState] = useState<string | null>(null);
  async function watch() {
    try {
      const w = await post<{ id: string; n_known_products: number }>("/api/watchlists", { kind, ref_id: refId ?? null, ra: ra ?? null, dec: dec ?? null, label: label ?? "" });
      setState(`Watching (${w.n_known_products} products in baseline)`);
    } catch (e: any) { setState(`error: ${e.message}`); }
  }
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <Button onClick={watch} disabled={!!state && !state.startsWith("error")}>Add to watchlist</Button>
      {state && <span className={state.startsWith("error") ? "text-bad" : "text-muted"} role="status">{state} {!state.startsWith("error") && <Link className="text-text underline decoration-line-strong hover:text-accent" href="/watchlists">view</Link>}</span>}
    </div>
  );
}
