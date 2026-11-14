"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ComparisonViewer } from "@/components/ComparisonViewer";
import { Checks, ErrorNote, f, Panel, Progress, Stat } from "@/components/ui";
import { API, type Comparison, get, type Job, pollJob, post } from "@/lib/api";
import { BANDS, decDms, fmtDate, raHms } from "@/lib/astro";
import { href, readViewState, toQuery } from "@/lib/viewstate";

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
      <div className="p-4 max-w-5xl w-full mx-auto flex flex-col gap-4">
        <h1 className="text-lg font-semibold">Compare</h1>
        <p className="text-[13px] text-muted">Pick two epochs on the <Link className="text-accent" href="/timeline">Timeline</Link>, or reopen a stored comparison.</p>
        <ErrorNote error={err} />
        <Panel title={`Stored comparisons (${recent.length})`}>
          <ul className="text-[12px] divide-y divide-line">
            {recent.map((c) => (
              <li key={c.id} className="py-1.5 flex items-center gap-3">
                <Link className="num text-accent" href={href("/compare", { ra: c.ra, dec: c.dec, a: c.product_a, b: c.product_b, size: c.size_deg, det: c.detector ?? undefined, mode: "blink" })}>{c.id}</Link>
                <span className={`text-[11px] uppercase ${c.status === "done" ? "text-good" : c.status === "rejected" ? "text-warn" : "text-bad"}`}>{c.status}</span>
                <span className="num text-muted">{c.ra.toFixed(4)}, {c.dec.toFixed(4)} · D{c.detector}</span>
                <span className="num text-muted">{fmtDate(c.t_a_mjd, false)} → {fmtDate(c.t_b_mjd, false)}</span>
                <span className="ml-auto num">{c.n_candidates} cand.</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    );

  const m = comp?.provenance.metrics ?? {};
  const s = comp?.summary ?? {};
  return (
    <div className="p-4 flex flex-col gap-4 max-w-[1600px] w-full mx-auto min-w-0">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <h1 className="text-lg font-semibold">Epoch comparison {comp && <span className="num text-muted text-[14px]">{comp.id}</span>}</h1>
          {v.ra != null && v.dec != null && <p className="text-[12px] text-muted num">{raHms(v.ra)} {decDms(v.dec)} · {f(v.size ?? 0.1, 2)}° field{v.det ? ` · detector ${v.det} (${BANDS[v.det]})` : ""}</p>}
        </div>
        {comp && (
          <div className="flex flex-wrap gap-5 ml-auto">
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
      {!comp && !err && <Progress value={job?.progress ?? 0.02} label={job ? `${job.message}` : "Submitting comparison…"} />}

      {comp && comp.status === "rejected" && (
        <div className="border border-warn/40 bg-warn/5 rounded px-3 py-2 text-[13px] text-warn">
          Comparison rejected — the two observations cannot be scientifically subtracted here: {(s.rejection_reasons ?? []).join("; ")}.
          The registered originals are still shown for inspection.
        </div>
      )}

      {comp && (
        <div className="grid xl:grid-cols-[1fr_360px] gap-4 min-w-0 [&>*]:min-w-0">
          <ComparisonViewer comp={comp} mode={v.mode ?? "blink"} onMode={(mode) => setQ({ mode })} selected={v.cand} onSelect={(cand) => setQ({ cand })} />
          <div className="flex flex-col gap-4">
            <Panel title="Actions">
              <div className="flex flex-col gap-2 text-[13px]">
                {v.cand && <Link className="text-accent" href={href(`/discovery/${v.cand}`, { ra: v.ra, dec: v.dec })}>Inspect {v.cand} →</Link>}
                <Link className="text-accent" href={href("/intelligence", { ra: v.ra, dec: v.dec, cmp: comp.id, cand: v.cand })}>Ask Sky Intelligence about this comparison →</Link>
                <button className="text-left text-accent" onClick={() => navigator.clipboard?.writeText(window.location.href)}>Copy link to this view</button>
                <div className="text-[12px] text-muted">Download FITS (with WCS + provenance keywords):</div>
                <div className="flex flex-wrap gap-2 text-[12px] num">
                  {["a", "b", "diff", "sigma", "significance", "valid"].map((l) => (
                    <a key={l} className="px-2 py-0.5 border border-line rounded hover:border-accent" href={`${API}/api/comparisons/${comp.id}/fits/${l}`}>{l}</a>
                  ))}
                </div>
              </div>
            </Panel>
            <Panel title="Comparison quality checks"><Checks checks={comp.provenance.quality_checks ?? []} /></Panel>
            <Panel title="Processing">
              <dl className="grid grid-cols-[130px_1fr] gap-y-1 text-[12px] num">
                <dt className="text-faint">Pipeline</dt><dd>{comp.pipeline_version}</dd>
                <dt className="text-faint">Processed</dt><dd>{comp.provenance.processed_at?.slice(0, 19)}Z</dd>
                <dt className="text-faint">ZODI A / B</dt><dd>{f(m.zodi_a_median, 3)} / {f(m.zodi_b_median, 3)} MJy/sr</dd>
                <dt className="text-faint">PSF FWHM A / B</dt><dd>{f(m.psf_fwhm_a_arcsec, 2)}″ / {f(m.psf_fwhm_b_arcsec, 2)}″{m.psf_matched ? " (matched)" : ""}</dd>
                <dt className="text-faint">Noise rescale</dt><dd>×{f(m.noise_rescale_factor, 3)}</dd>
                <dt className="text-faint">Median |Δλ|/Δλ</dt><dd>{f(m.dlambda_frac_median, 4)}</dd>
                <dt className="text-faint">Candidates</dt><dd>{s.n_candidates ?? 0} ({s.n_tier_a ?? 0} tier A, {s.n_rejected ?? 0} rejected)</dd>
              </dl>
              <details className="mt-2 text-[11px]">
                <summary className="cursor-pointer text-muted">Full provenance (JSON)</summary>
                <pre className="mt-2 max-h-80 overflow-auto bg-bg border border-line rounded p-2 num text-[10px] text-muted">{JSON.stringify(comp.provenance, null, 2)}</pre>
              </details>
            </Panel>
          </div>
        </div>
      )}
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
