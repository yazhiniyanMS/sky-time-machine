"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ComparisonViewer } from "@/components/ComparisonViewer";
import { PsfKernel } from "@/components/PsfKernel";
import { Checks, Empty, ErrorNote, f, MetaList, PageHeader, Panel, Progress, Stat, textLinkCls } from "@/components/ui";
import { API, type Comparison, get, type Job, pollJob, post } from "@/lib/api";
import { BANDS, decDms, fmtDate, raHms } from "@/lib/astro";
import { href, readViewState, toQuery } from "@/lib/viewstate";

const PSF_METHOD: Record<string, string> = {
  epsf_cross: "EPSF cross-convolution",
  gaussian: "Gaussian (header FWHM, no EPSF)",
  gaussian_not_needed: "not needed (equal header FWHM, no EPSF)",
  none: "none",
};

function ComparePage() {
  const sp = useSearchParams();
  const router = useRouter();
  const v = readViewState(sp);
  const [comp, setComp] = useState<Comparison | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [recent, setRecent] = useState<(Comparison & { n_candidates: number })[]>([]);
  const ready = v.ra != null && v.dec != null && v.a && v.b;
  const key = ready ? `${v.ra}|${v.dec}|${v.a}|${v.b}|${v.size ?? 0.1}` : v.cmp ?? "";

  useEffect(() => {
    let off = false;
    setErr(null);
    setComp(null);
    setJob(null);
    (async () => {
      try {
        let cid = v.cmp;
        if (ready) {
          const r = await post<{ comparison_id: string; job_id: string | null }>("/api/comparisons", {
            ra: v.ra, dec: v.dec, size_deg: v.size ?? 0.1, product_a: v.a, product_b: v.b,
          });
          cid = r.comparison_id;
          if (r.job_id) {
            const j = await pollJob(r.job_id, (jj) => !off && setJob(jj));
            if (j.status === "failed") throw new Error(j.message);
          }
        }
        if (cid) {
          const c = await get<Comparison>(`/api/comparisons/${cid}`);
          if (!off) setComp(c);
        } else {
          const rs = await get<(Comparison & { n_candidates: number })[]>("/api/comparisons");
          if (!off) setRecent(rs);
        }
      } catch (e: any) {
        if (!off) setErr(e.message);
      }
    })();
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setQ = (nv: Partial<typeof v>) => router.replace(`/compare${toQuery({ ...v, ...nv })}`, { scroll: false });

  if (!ready && !v.cmp)
    return (
      <div className="theme-graphite flex-1 bg-bg">
        <div className="px-4 sm:px-6 py-6 max-w-5xl w-full mx-auto flex flex-col gap-5">
          <PageHeader title="Epoch comparison" meta="pick two epochs on the timeline, or reopen a stored comparison" />
          <ErrorNote error={err} />
          <Panel title={`Stored comparisons (${recent.length})`}>
            {recent.length === 0 ? <Empty>No comparisons yet. Open the <Link className={textLinkCls} href="/timeline">Timeline</Link> for a position and choose epochs A and B.</Empty> : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead className="text-muted text-left"><tr className="border-b border-text/60"><th className="py-1.5 font-medium">Comparison</th><th className="font-medium">Status</th><th className="font-medium">Position · detector</th><th className="font-medium">Epochs</th><th className="font-medium text-right">Candidates</th></tr></thead>
                  <tbody>
                    {recent.map((c) => (
                      <tr key={c.id} className="border-b border-line">
                        <td className="py-1.5"><Link className="num underline decoration-line-strong hover:text-accent" href={href("/compare", { ra: c.ra, dec: c.dec, a: c.product_a, b: c.product_b, size: c.size_deg, det: c.detector ?? undefined, mode: "blink" })}>{c.id}</Link></td>
                        <td className={c.status === "done" ? "text-good" : c.status === "rejected" ? "text-warn" : "text-bad"}>{c.status}</td>
                        <td className="num text-muted">{c.ra.toFixed(4)}, {c.dec.toFixed(4)} · D{c.detector}</td>
                        <td className="num text-muted">{fmtDate(c.t_a_mjd, false)} → {fmtDate(c.t_b_mjd, false)}</td>
                        <td className="num text-right">{c.n_candidates}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      </div>
    );

  const m = comp?.provenance.metrics ?? {};
  const s = comp?.summary ?? {};
  return (
    <div className="theme-graphite flex-1 bg-bg">
      <div className="px-4 py-4 flex flex-col gap-4 max-w-[1720px] w-full mx-auto min-w-0">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3 pb-3 border-b border-line-strong">
          <div className="min-w-0">
            <div className="text-[12px] text-muted">Epoch comparison {comp && <span className="num text-text ml-1">{comp.id}</span>}</div>
            {v.ra != null && v.dec != null && <h1 className="num text-[18px] mt-0.5">{raHms(v.ra)} {decDms(v.dec)}</h1>}
            <div className="num text-[12px] text-muted mt-0.5">{f(v.size ?? 0.1, 2)}° field{v.det ? ` · detector ${v.det} (${BANDS[v.det]})` : ""}</div>
          </div>
          {comp && (
            <div className="flex flex-wrap gap-x-6 gap-y-2 ml-auto">
              <Stat label="Epoch A" value={fmtDate(comp.t_a_mjd)} />
              <Stat label="Epoch B" value={fmtDate(comp.t_b_mjd)} />
              <Stat label="Baseline" value={f(s.baseline_days, 2)} unit="d" />
              <Stat label="λ A / B" value={`${f(m.wave_a_um_median, 4)} / ${f(m.wave_b_um_median, 4)}`} unit="µm" />
              <Stat label="Usable" value={f((m.valid_fraction ?? 0) * 100, 1)} unit="%" />
              <Stat label="Residual shift" value={f(m.residual_shift_pix, 3)} unit="px" />
            </div>
          )}
        </div>
        <ErrorNote error={err} />
        {!comp && !err && <Progress value={job?.progress ?? 0.02} label={job ? `${job.message}` : "Submitting comparison to the pipeline…"} />}

        {comp && comp.status === "rejected" && (
          <div className="border-l-2 border-warn pl-3 py-1 text-[13px]">
            <span className="text-warn font-medium">Comparison rejected. </span>
            The two observations cannot be subtracted here: {(s.rejection_reasons ?? []).join("; ")}. The registered originals are still shown for inspection.
          </div>
        )}

        {comp && (
          <div className="grid grid-cols-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_340px] gap-x-8 gap-y-6 min-w-0">
            <ComparisonViewer comp={comp} mode={v.mode ?? "blink"} onMode={(mode) => setQ({ mode })} selected={v.cand} onSelect={(cand) => setQ({ cand })} />
            <aside className="flex flex-col gap-5 min-w-0">
              <Panel title="Actions" dense>
                <div className="flex flex-col gap-1.5 text-[13px]">
                  {v.cand && <Link className={textLinkCls} href={href(`/discovery/${v.cand}`, { ra: v.ra, dec: v.dec })}>Inspect {v.cand}</Link>}
                  <Link className={textLinkCls} href={href("/intelligence", { ra: v.ra, dec: v.dec, cmp: comp.id, cand: v.cand })}>Ask the assistant about this comparison</Link>
                  <button className={`text-left ${textLinkCls}`} onClick={() => navigator.clipboard?.writeText(window.location.href)}>Copy link to this view</button>
                  <div className="text-[12px] text-muted mt-2">FITS downloads (WCS and provenance keywords)</div>
                  <div className="flex flex-wrap gap-1.5 text-[12px] num">
                    {["a", "b", "diff", "sigma", "significance", "valid"].map((l) => (
                      <a key={l} className="px-2 h-6 inline-flex items-center border border-line-strong hover:bg-panel-2" href={`${API}/api/comparisons/${comp.id}/fits/${l}`}>{l}</a>
                    ))}
                  </div>
                </div>
              </Panel>
              <Panel title="Quality checks" dense><Checks checks={comp.provenance.quality_checks ?? []} /></Panel>
              <Panel title="Processing" dense>
                <MetaList labelWidth="8.5rem" rows={[
                  ["Pipeline", comp.pipeline_version],
                  ["Processed", `${comp.provenance.processed_at?.slice(0, 19)}Z`],
                  ["ZODI A / B", `${f(m.zodi_a_median, 3)} / ${f(m.zodi_b_median, 3)} MJy/sr`],
                  ["PSF FWHM A / B", `${f(m.psf_fwhm_a_arcsec, 2)}″ / ${f(m.psf_fwhm_b_arcsec, 2)}″ (header)`],
                  ["PSF matching", PSF_METHOD[m.psf_method] ?? m.psf_method ?? "—"],
                  ...(m.psf_method === "epsf_cross" ? [
                    ["PSF difference", `${f(m.psf_mismatch_tv, 3)} (total variation)`],
                    ["Effective FWHM", `${f(m.psf_fwhm_effective_arcsec, 2)}″`],
                    ["Detector PA A / B", `${f(m.psf_a?.rotation_deg, 1)}° / ${f(m.psf_b?.rotation_deg, 1)}°`],
                  ] as [string, string][] : []),
                  ["Noise rescale", `×${f(m.noise_rescale_factor, 3)}`],
                  ["Median |Δλ|/Δλ", f(m.dlambda_frac_median, 4)],
                  ["Candidates", `${s.n_candidates ?? 0} (${s.n_tier_a ?? 0} tier A, ${s.n_rejected ?? 0} rejected)`],
                ]} />
                {m.psf_kernel_a && m.psf_kernel_b && (
                  <div className="mt-3 flex gap-4 items-end">
                    <PsfKernel k={m.psf_kernel_a} label="PSF A (EPSF)" />
                    <PsfKernel k={m.psf_kernel_b} label="PSF B (EPSF)" />
                    <p className="text-[11px] text-muted flex-1">Archive EPSFs at the target on the comparison grid. A is convolved with PSF B and B with PSF A, so both share PSF A ⊗ PSF B.</p>
                  </div>
                )}
                <details className="mt-3 text-[12px]">
                  <summary className="cursor-pointer text-muted hover:text-text">Full provenance (JSON)</summary>
                  <pre className="mt-2 max-h-80 overflow-auto bg-panel border border-line p-2 num text-[10px] text-muted">{JSON.stringify(comp.provenance, null, 2)}</pre>
                </details>
              </Panel>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <ComparePage />
    </Suspense>
  );
}
