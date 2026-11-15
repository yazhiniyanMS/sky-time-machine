"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ErrorNote, inputCls, Panel, TierBadge, VerificationBadge } from "@/components/ui";
import { API, type DiscoveryPage, get } from "@/lib/api";
import { ASSOCIATION_LABEL, CLASS_LABEL, DETECTOR_COLORS, fmtDate } from "@/lib/astro";
import { href } from "@/lib/viewstate";

const DEFAULTS: Record<string, string> = { sort: "significance", order: "desc", page: "1", page_size: "25" };

function Feed() {
  const sp = useSearchParams();
  const router = useRouter();
  const p = (k: string) => sp.get(k) ?? DEFAULTS[k] ?? "";
  const [data, setData] = useState<DiscoveryPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [qDraft, setQDraft] = useState(p("q"));

  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "" || v === DEFAULTS[k]) next.delete(k);
      else next.set(k, v);
    }
    if (!("page" in changes)) next.delete("page");
    router.replace(`/discoveries?${next.toString()}`, { scroll: false });
  };

  const query = sp.toString();
  useEffect(() => {
    const q = new URLSearchParams(query);
    for (const [k, v] of Object.entries(DEFAULTS)) if (!q.has(k)) q.set(k, v);
    if (!q.get("near")) { q.delete("ra"); q.delete("dec"); q.delete("radius"); }
    q.delete("near");
    setLoading(true);
    get<DiscoveryPage>(`/api/discoveries?${q}`).then((d) => { setData(d); setErr(null); }).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }, [query]);

  const tiers = (p("tier") || "A,B").split(",").filter(Boolean);
  const toggleTier = (t: string) => {
    const next = tiers.includes(t) ? tiers.filter((x) => x !== t) : [...tiers, t];
    set({ tier: next.sort().join(",") === "A,B" ? null : next.sort().join(",") || "A" });
  };
  const near = sp.get("near") === "1";
  const page = Number(p("page"));

  return (
    <div className="px-4 sm:px-6 py-6 max-w-[1500px] w-full mx-auto flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="serif text-[26px] leading-tight font-semibold tracking-[-0.01em]">Discoveries</h1>
          <p className="text-[12px] text-muted max-w-3xl">Change candidates detected automatically in stored comparisons of real SPHEREx images. Machine classes are rule-based labels, and every candidate is unverified unless a reviewer has changed its status.</p>
        </div>
        <a className="ml-auto text-[12px] text-text underline decoration-line-strong hover:text-accent" href={`${API}/api/export/candidates.csv`}>Export all as CSV</a>
      </div>

      <section aria-label="Filters" className="flex flex-wrap items-end gap-3 border-y border-line-strong px-3 py-2">
        <form onSubmit={(e) => { e.preventDefault(); set({ q: qDraft.trim() || null }); }} className="flex items-end gap-1">
          <label className="flex flex-col gap-1 text-[12px] text-muted">Candidate ID
            <input value={qDraft} onChange={(e) => setQDraft(e.target.value)} placeholder="ST-2026-000142" className={`${inputCls} w-44 num`} />
          </label>
          <button className="h-8 px-3 text-[12px] border border-line-strong hover:bg-panel-2">Search</button>
        </form>
        <label className="flex flex-col gap-1 text-[12px] text-muted">Sort
          <select value={`${p("sort")}:${p("order")}`} onChange={(e) => { const [s, o] = e.target.value.split(":"); set({ sort: s, order: o }); }} className={inputCls}>
            <option value="significance:desc">Significance (tier first)</option>
            <option value="snr:desc">Aperture S/N</option>
            <option value="date:desc">Observation date, newest</option>
            <option value="date:asc">Observation date, oldest</option>
            <option value="created:desc">Processed, newest</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-muted">Type
          <select value={p("machine_class")} onChange={(e) => set({ machine_class: e.target.value })} className={inputCls}>
            <option value="">All machine classes</option>
            {Object.entries(CLASS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <fieldset className="flex flex-col gap-1 text-[12px] text-muted">
          <legend className="mb-1">Quality tier</legend>
          <div className="flex gap-2 normal-case tracking-normal text-[12px] text-muted h-8 items-center">
            {["A", "B", "R"].map((t) => (
              <label key={t} className="flex items-center gap-1"><input type="checkbox" checked={tiers.includes(t)} onChange={() => toggleTier(t)} />{t === "R" ? "Rejected" : t}</label>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1 text-[12px] text-muted">Min S/N
          <input type="number" step="any" min={0} value={p("min_snr")} onChange={(e) => set({ min_snr: e.target.value })} className={`${inputCls} w-20 num`} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-muted">Verification
          <select value={p("verification")} onChange={(e) => set({ verification: e.target.value })} className={inputCls}>
            <option value="">Any</option><option value="unverified">Unverified</option><option value="under_review">Under review</option>
            <option value="confirmed_real">Confirmed real</option><option value="rejected_artifact">Rejected artifact</option>
          </select>
        </label>
        {sp.get("ra") && sp.get("dec") && (
          <label className="flex items-center gap-1 text-[12px] text-muted h-8">
            <input type="checkbox" checked={near} onChange={(e) => set({ near: e.target.checked ? "1" : null })} />
            within <input type="number" step="any" min={0.01} value={p("radius") || "1"} onChange={(e) => set({ radius: e.target.value, near: "1" })} className={`${inputCls} w-16 num`} />° of current view
          </label>
        )}
      </section>

      <ErrorNote error={err} />
      <Panel title={data ? `${data.total} candidate${data.total === 1 ? "" : "s"}` : "Loading…"} right={loading && <span className="text-[11px] text-faint">Updating…</span>}>
        {data && data.total === 0 && (
          <div className="py-6 text-[13px] text-muted max-w-2xl">
            {data.n_comparisons_processed === 0 ? (
              <>No comparisons have been processed yet, so there are no candidates. Candidates appear only after real SPHEREx epochs are compared. Open the <Link className="text-text underline decoration-line-strong hover:text-accent" href="/timeline?ra=10.6847&dec=41.269&det=1">Timeline</Link>, choose a spectrally matched pair and run a comparison.</>
            ) : (
              <>No candidate matches these filters ({data.n_comparisons_processed} comparison{data.n_comparisons_processed === 1 ? "" : "s"} processed). Widen the filters, or run more comparisons from the Timeline to add candidates.</>
            )}
          </div>
        )}
        {data && data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-[12px] [&_td]:px-2 [&_th]:px-2 [&_td:first-child]:pl-0 [&_th:first-child]:pl-0">
              <thead className="text-muted text-left"><tr className="border-b border-text/60">
                <th className="py-1 font-normal">Candidate</th><th className="font-normal">RA, Dec</th><th className="font-normal">Machine class</th>
                <th className="font-normal">Tier</th><th className="font-normal text-right">Peak</th><th className="font-normal text-right">S/N</th>
                <th className="font-normal">Epochs (A → B)</th><th className="font-normal">Band</th><th className="font-normal">Pipeline</th>
                <th className="font-normal">Quality flags</th><th className="font-normal">Counterparts</th><th className="font-normal">Status</th>
              </tr></thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id} className={`border-b border-line/60 hover:bg-panel-2 ${c.rejected ? "opacity-50" : ""}`}>
                    <td className="py-1.5 num"><Link className="text-text underline decoration-line-strong hover:text-accent" href={href(`/discovery/${c.id}`, {})}>{c.id}</Link></td>
                    <td className="num text-muted">{c.ra.toFixed(5)}, {c.dec >= 0 ? "+" : ""}{c.dec.toFixed(5)}</td>
                    <td title={data.class_descriptions[c.machine_class]}>{CLASS_LABEL[c.machine_class]}</td>
                    <td><TierBadge tier={c.quality_tier} /></td>
                    <td className={`num text-right ${c.sign > 0 ? "text-pos" : "text-neg"}`}>{c.peak_significance >= 0 ? "+" : ""}{c.peak_significance.toFixed(1)}σ</td>
                    <td className="num text-right">{c.diff_snr != null ? c.diff_snr.toFixed(1) : "—"}</td>
                    <td className="num text-muted whitespace-nowrap">{fmtDate(c.t_a_mjd, false)} → {fmtDate(c.t_b_mjd, false)}</td>
                    <td className="num whitespace-nowrap"><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: DETECTOR_COLORS[c.detector ?? 1] }} />D{c.detector} · {c.wave_um ? `${c.wave_um.toFixed(3)} µm` : "—"}</td>
                    <td className="num text-faint">{c.pipeline_version.replace("stm-pipeline-", "v")}</td>
                    <td className="text-faint">{c.failed_checks.length ? c.failed_checks.join(", ") : "none"}</td>
                    <td className="text-muted">{c.counterpart_association ? ASSOCIATION_LABEL[c.counterpart_association] : "not checked"}</td>
                    <td><VerificationBadge status={c.verification_status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.pages > 1 && (
          <nav aria-label="Pagination" className="flex items-center gap-2 mt-3 text-[12px]">
            <button disabled={page <= 1} onClick={() => set({ page: String(page - 1) })} className="px-2 h-7 border border-line rounded disabled:opacity-40">Previous</button>
            <span className="num text-muted">Page {data.page} of {data.pages}</span>
            <button disabled={page >= data.pages} onClick={() => set({ page: String(page + 1) })} className="px-2 h-7 border border-line rounded disabled:opacity-40">Next</button>
            <select aria-label="Page size" value={p("page_size")} onChange={(e) => set({ page_size: e.target.value })} className={`${inputCls} ml-2`}>
              {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n} per page</option>)}
            </select>
          </nav>
        )}
        {data && <p className="text-[11px] text-faint mt-3">{data.note}</p>}
      </Panel>
    </div>
  );
}

export default function Page() {
  return <Suspense><Feed /></Suspense>;
}
