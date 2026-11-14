"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ErrorNote, Panel, TierBadge, VerificationBadge } from "@/components/ui";
import { type CandidateBrief, get } from "@/lib/api";
import { CLASS_LABEL, fmtDate } from "@/lib/astro";
import { href, readViewState } from "@/lib/viewstate";

interface ListResp { candidates: CandidateBrief[]; total: number; ranking: string; class_descriptions: Record<string, string> }

function Discoveries() {
  const v = readViewState(useSearchParams());
  const [data, setData] = useState<ListResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rej, setRej] = useState(false);
  const [cls, setCls] = useState("");
  const [near, setNear] = useState(v.ra != null);
  const [radius, setRadius] = useState(1);

  useEffect(() => {
    const q = new URLSearchParams();
    if (near && v.ra != null && v.dec != null) { q.set("ra", String(v.ra)); q.set("dec", String(v.dec)); q.set("radius", String(radius)); }
    if (rej) q.set("include_rejected", "true");
    if (cls) q.set("machine_class", cls);
    get<ListResp>(`/api/candidates?${q}`).then(setData).catch((e) => setErr(e.message));
  }, [rej, cls, near, radius, v.ra, v.dec]);

  return (
    <div className="p-4 max-w-[1400px] w-full mx-auto flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-lg font-semibold">Discoveries</h1>
          <p className="text-[12px] text-muted">Machine-detected change candidates. All are unverified unless a reviewer has changed their status.</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-[12px] text-muted">
          {v.ra != null && (
            <label className="flex items-center gap-1"><input type="checkbox" checked={near} onChange={(e) => setNear(e.target.checked)} />
              within <input type="number" min={0.05} max={10} step="any" value={radius} onChange={(e) => setRadius(+e.target.value)} className="w-16 h-7 bg-bg border border-line-strong rounded px-1 num text-text" />° of view
            </label>
          )}
          <select value={cls} onChange={(e) => setCls(e.target.value)} aria-label="Machine class filter" className="h-7 bg-bg border border-line-strong rounded px-1 text-text">
            <option value="">All classes</option>
            {Object.entries(CLASS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <label className="flex items-center gap-1"><input type="checkbox" checked={rej} onChange={(e) => setRej(e.target.checked)} />Include rejected</label>
        </div>
      </div>
      <ErrorNote error={err} />
      <Panel title={`${data?.total ?? 0} candidates`} right={<span className="text-[11px] text-faint">Ranking: {data?.ranking}</span>}>
        {data && data.candidates.length === 0 && <p className="text-[13px] text-muted">No candidates yet. Run a comparison from the Timeline to populate this list.</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="text-faint text-left"><tr className="border-b border-line">
              <th className="py-1 font-normal">ID</th><th className="font-normal">Tier</th><th className="font-normal">Class</th>
              <th className="font-normal text-right">Peak</th><th className="font-normal text-right">ΔF (µJy)</th>
              <th className="font-normal">D</th><th className="font-normal">Epochs</th><th className="font-normal">RA, Dec</th>
              <th className="font-normal">Status</th><th className="font-normal">Community</th>
            </tr></thead>
            <tbody>
              {data?.candidates.map((c) => (
                <tr key={c.id} className={`border-b border-line/60 hover:bg-panel-2 ${c.rejected ? "opacity-50" : ""}`}>
                  <td className="py-1 num"><Link className="text-accent" href={href(`/discovery/${c.id}`, {})}>{c.id}</Link></td>
                  <td><TierBadge tier={c.quality_tier} /></td>
                  <td title={data.class_descriptions[c.machine_class]}>{CLASS_LABEL[c.machine_class]}</td>
                  <td className={`num text-right ${c.sign > 0 ? "text-pos" : "text-neg"}`}>{c.peak_significance.toFixed(1)}σ</td>
                  <td className="num text-right">{c.diff_flux_ujy.toFixed(0)} ± {c.diff_flux_err_ujy.toFixed(0)}</td>
                  <td className="num">{c.detector}</td>
                  <td className="num text-muted">{fmtDate(c.t_a_mjd, false)} → {fmtDate(c.t_b_mjd, false)}</td>
                  <td className="num text-muted">{c.ra.toFixed(5)}, {c.dec.toFixed(5)}</td>
                  <td><VerificationBadge status={c.verification_status} /></td>
                  <td className="num text-muted">{Object.entries(c.community ?? {}).map(([k, n]) => `${k.replace("_", " ")} ${n}`).join(" · ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

export default function Page() {
  return <Suspense><Discoveries /></Suspense>;
}
