"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { WatchButton } from "@/components/SaveTo";
import { Button, ErrorNote, Field, inputCls, Panel, Progress, TierBadge } from "@/components/ui";
import { API, del, get, type Investigation, patch } from "@/lib/api";
import { CLASS_LABEL, fmtDate } from "@/lib/astro";

const KIND_LABEL: Record<string, string> = { candidate: "Saved candidates", comparison: "Comparison results", spectrum: "Spectra", region: "Regions", observation: "Observations" };

export default function InvestigationPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [inv, setInv] = useState<Investigation | null>(null);
  const [draft, setDraft] = useState<Investigation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [ref, setRef] = useState({ title: "", url: "" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    get<Investigation>(`/api/investigations/${id}`).then((d) => { setInv(d); setDraft(d); }).catch((e) => setErr(e.message));
  }, [id]);

  async function save(changes: Partial<Investigation>) {
    try {
      const d = await patch<Investigation>(`/api/investigations/${id}`, changes);
      setInv(d); setDraft(d); setSaved(new Date().toLocaleTimeString());
    } catch (e: any) { setErr(e.message); }
  }
  async function removeItem(itemId: number) {
    try { const d = await del<Investigation>(`/api/investigations/${id}/items/${itemId}`); setInv(d); setDraft(d); } catch (e: any) { setErr(e.message); }
  }

  if (err && !inv) return <div className="p-6"><ErrorNote error={err} /></div>;
  if (!inv || !draft) return <div className="p-6"><Progress value={0.3} label="Loading investigation…" /></div>;
  const groups = Object.keys(KIND_LABEL).map((k) => ({ k, items: (inv.items ?? []).filter((i) => i.kind === k) })).filter((g) => g.items.length);
  const versions = [...new Set((inv.items ?? []).map((i) => i.payload?.pipeline_version).filter(Boolean))];
  const dirty = draft.title !== inv.title || draft.description !== inv.description || draft.notes !== inv.notes || draft.ra !== inv.ra || draft.dec !== inv.dec || draft.radius_deg !== inv.radius_deg;

  return (
    <div className="px-4 sm:px-6 py-6 max-w-[1300px] w-full mx-auto flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[260px]">
          <label className="sr-only" htmlFor="inv-title">Title</label>
          <input id="inv-title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className="serif w-full bg-transparent text-[26px] leading-tight font-semibold outline-none border-b border-transparent focus:border-text" />
          <p className="text-[11px] text-faint num">{inv.id} · owner {inv.owner || "—"} · created {inv.created_at.slice(0, 10)} · updated {inv.updated_at.slice(0, 16).replace("T", " ")}</p>
        </div>
        <div className="flex flex-wrap gap-2 text-[12px]">
          <Button variant="primary" disabled={!dirty} onClick={() => save({ title: draft.title, description: draft.description, notes: draft.notes, ra: draft.ra, dec: draft.dec, radius_deg: draft.radius_deg })}>Save changes</Button>
          <Button onClick={() => { navigator.clipboard?.writeText(window.location.href); setCopied(true); }}>{copied ? "Link copied" : "Copy share link"}</Button>
          <a className="h-8 px-3 grid place-items-center rounded border border-line-strong hover:border-muted" href={`${API}/api/investigations/${id}/report.html`} target="_blank" rel="noreferrer">Scientific report</a>
          <a className="h-8 px-3 grid place-items-center rounded border border-line-strong hover:border-muted" href={`${API}/api/investigations/${id}/export.md`}>Markdown</a>
          <a className="h-8 px-3 grid place-items-center rounded border border-line-strong hover:border-muted" href={`${API}/api/investigations/${id}/export.json`}>JSON</a>
        </div>
      </div>
      {saved && !dirty && <p className="text-[11px] text-good" role="status">Saved at {saved}</p>}
      <ErrorNote error={err} />

      <div className="grid lg:grid-cols-[1fr_360px] gap-4 [&>*]:min-w-0">
        <div className="flex flex-col gap-4">
          <Panel title="Description">
            <textarea rows={3} aria-label="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={`${inputCls} h-auto w-full py-1.5`} placeholder="Scientific question, target, plan…" />
          </Panel>
          {groups.length === 0 && <Panel title="Saved items"><p className="text-[13px] text-muted">Nothing saved yet. Use “Save to investigation” on candidate, comparison or spectrum pages.</p></Panel>}
          {groups.map(({ k, items }) => (
            <Panel key={k} title={`${KIND_LABEL[k]} (${items.length})`}>
              <ul className="divide-y divide-line text-[12px]">
                {items.map((it) => (
                  <li key={it.id} className="py-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    {k === "candidate" && <Link className="num underline decoration-line-strong hover:text-accent" href={`/discovery/${it.ref_id}`}>{it.ref_id}</Link>}
                    {k === "comparison" && <Link className="num underline decoration-line-strong hover:text-accent" href={`/compare?ra=${it.payload.ra}&dec=${it.payload.dec}&a=${it.payload.product_a}&b=${it.payload.product_b}&det=${it.payload.detector}&mode=blink`}>{it.ref_id}</Link>}
                    {k === "spectrum" && <Link className="num underline decoration-line-strong hover:text-accent" href={`/spectra?run=${it.ref_id}`}>{it.ref_id}</Link>}
                    {!["candidate", "comparison", "spectrum"].includes(k) && <span className="num">{it.ref_id}</span>}
                    {it.payload.quality_tier && <TierBadge tier={it.payload.quality_tier} />}
                    {it.payload.machine_class && <span className="text-muted">{CLASS_LABEL[it.payload.machine_class]}</span>}
                    {it.payload.peak_significance != null && <span className="num">{Number(it.payload.peak_significance).toFixed(1)}σ</span>}
                    {it.payload.t_a_mjd && <span className="num text-muted">{fmtDate(it.payload.t_a_mjd, false)} → {fmtDate(it.payload.t_b_mjd, false)}</span>}
                    {it.payload.pipeline_version && <span className="num text-faint">{it.payload.pipeline_version}</span>}
                    <button className="ml-auto text-faint hover:text-bad" onClick={() => removeItem(it.id)} aria-label={`Remove ${it.ref_id}`}>Remove</button>
                    {it.note && <p className="w-full text-muted">{it.note}</p>}
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
          <Panel title="Research notes">
            <textarea rows={10} aria-label="Research notes" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} className={`${inputCls} h-auto w-full py-1.5 num`} placeholder="Observations, hypotheses, follow-up ideas. Keep measurements and interpretation separate." />
          </Panel>
        </div>
        <div className="flex flex-col gap-4">
          <Panel title="Sky region">
            <div className="grid grid-cols-3 gap-2">
              <Field label="RA °"><input className={`${inputCls} num`} value={draft.ra ?? ""} onChange={(e) => setDraft({ ...draft, ra: e.target.value === "" ? null : Number(e.target.value) })} /></Field>
              <Field label="Dec °"><input className={`${inputCls} num`} value={draft.dec ?? ""} onChange={(e) => setDraft({ ...draft, dec: e.target.value === "" ? null : Number(e.target.value) })} /></Field>
              <Field label="Radius °"><input className={`${inputCls} num`} value={draft.radius_deg ?? ""} onChange={(e) => setDraft({ ...draft, radius_deg: e.target.value === "" ? null : Number(e.target.value) })} /></Field>
            </div>
            {inv.ra != null && (
              <div className="flex flex-col gap-1 mt-3 text-[12px]">
                <Link className="text-text underline decoration-line-strong hover:text-accent" href={`/?ra=${inv.ra}&dec=${inv.dec}&fov=${Math.max(0.3, (inv.radius_deg ?? 0.25) * 3)}`}>Open on the sky map</Link>
                <Link className="text-text underline decoration-line-strong hover:text-accent" href={`/timeline?ra=${inv.ra}&dec=${inv.dec}&det=1`}>Observation history (timeline)</Link>
                <Link className="text-text underline decoration-line-strong hover:text-accent" href={`/discoveries?ra=${inv.ra}&dec=${inv.dec}&radius=${inv.radius_deg ?? 0.25}&near=1`}>Candidates in this region</Link>
                <div className="mt-1"><WatchButton kind="investigation" refId={inv.id} label={inv.title} /></div>
              </div>
            )}
          </Panel>
          <Panel title="Scientific references">
            <ul className="text-[12px] flex flex-col gap-1">
              {inv.references.map((r, i) => (
                <li key={i} className="flex gap-2">
                  <span className="flex-1">{r.title || r.bibcode}{r.url && <> — <a className="break-all text-text underline decoration-line-strong hover:text-accent" href={r.url} target="_blank" rel="noreferrer">{r.url}</a></>}</span>
                  <button className="text-faint hover:text-bad" onClick={() => save({ references: inv.references.filter((_, j) => j !== i) })} aria-label="Remove reference">×</button>
                </li>
              ))}
              {inv.references.length === 0 && <li className="text-muted">None yet.</li>}
            </ul>
            <form className="flex flex-col gap-2 mt-2" onSubmit={(e) => { e.preventDefault(); if (!ref.title && !ref.url) return; save({ references: [...inv.references, ref] }); setRef({ title: "", url: "" }); }}>
              <input className={inputCls} placeholder="Title or bibcode" value={ref.title} onChange={(e) => setRef({ ...ref, title: e.target.value })} aria-label="Reference title" />
              <input className={inputCls} placeholder="URL (optional)" value={ref.url} onChange={(e) => setRef({ ...ref, url: e.target.value })} aria-label="Reference URL" />
              <Button type="submit">Add reference</Button>
            </form>
          </Panel>
          <Panel title="Processing versions">
            <p className="text-[12px] text-muted">{versions.length ? versions.join(", ") : "No processed items yet."}</p>
            <p className="text-[11px] text-faint mt-1">Items keep a snapshot of the record when saved; earlier pipeline versions remain readable and are never overwritten.</p>
          </Panel>
          <Panel title="Actions">
            <div className="flex flex-col gap-2 text-[12px]">
              <Link className="text-text underline decoration-line-strong hover:text-accent" href={`/intelligence?investigation=${inv.id}${inv.ra != null ? `&ra=${inv.ra}&dec=${inv.dec}` : ""}`}>Summarise with the assistant</Link>
              <button className="text-left text-faint hover:text-bad" onClick={async () => { if (confirm(`Delete investigation “${inv.title}”? This cannot be undone.`)) { await del(`/api/investigations/${id}`); router.push("/investigations"); } }}>Delete investigation</button>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
