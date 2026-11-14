"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CommunityPanel } from "@/components/CommunityPanel";
import { ImageCanvas, type View } from "@/components/ImageCanvas";
import { LightCurve } from "@/components/LightCurve";
import { Button, Checks, ErrorNote, f, Panel, Progress, Stat, TierBadge, VerificationBadge } from "@/components/ui";
import { type CandidateDetail, fetchLayer, get, type Job, type Layer, pollJob, post } from "@/lib/api";
import { CLASS_LABEL, decDms, fmtDate, raHms, TRACK_LABEL } from "@/lib/astro";
import { percentileLimits } from "@/lib/render";
import { href } from "@/lib/viewstate";

export default function DiscoveryPage() {
  const { id } = useParams<{ id: string }>();
  const [c, setC] = useState<CandidateDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<string, Layer>>({});
  const [view, setView] = useState<View | null>(null);
  const [phot, setPhot] = useState<Job | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    get<CandidateDetail>(`/api/candidates/${encodeURIComponent(id)}`).then(setC).catch((e) => setErr(e.message));
  }, [id]);

  useEffect(() => {
    if (!c) return;
    for (const n of ["a", "b", "diff", "significance"]) fetchLayer(c.comparison.id, n).then((l) => setLayers((s) => ({ ...s, [n]: l }))).catch(() => {});
  }, [c]);

  useEffect(() => {
    const l = layers.a;
    if (!c || !l || view) return;
    const x = c.measurements.x_pix, y = c.measurements.y_pix;
    setView({ zoom: Math.max(1, l.cols / 16), cx: x + 0.5 - l.cols / 2, cy: l.rows - 1 - y + 0.5 - l.rows / 2 });
  }, [c, layers.a, view]);

  const lim = useMemo(() => {
    if (!layers.a || !layers.b) return { lo: 0, hi: 1 };
    const both = new Float32Array(layers.a.data.length + layers.b.data.length);
    both.set(layers.a.data);
    both.set(layers.b.data, layers.a.data.length);
    return percentileLimits(both, 1, 99.7);
  }, [layers.a, layers.b]);

  if (err) return <div className="p-6"><ErrorNote error={err} /></div>;
  if (!c || !view) return <div className="p-6"><Progress value={0.3} label="Loading candidate…" /></div>;

  const m = c.measurements;
  const comp = c.comparison;
  const fwhmPix = (m.fwhm_arcsec ?? 7.5) / (m.pixscale_arcsec ?? 6.15);
  const markers = [{ id: c.id, x: m.x_pix, y: m.y_pix, sign: c.sign, r: m.aperture_radius_pix ?? 1.5 * fwhmPix, selected: true }];
  const common = { view, onView: setView, markers };
  const synthetic = comp.provenance.inputs?.some((i) => i.synthetic);

  async function runPhot() {
    try {
      const r = await post<{ job_id: string }>(`/api/candidates/${c!.id}/photometry`, {});
      setPhot(await pollJob(r.job_id, setPhot, 1200));
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <div className="p-4 max-w-[1500px] w-full mx-auto flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold num">{c.id}</h1>
            <TierBadge tier={c.quality_tier} />
            <VerificationBadge status={c.verification_status} />
            {synthetic && <span className="text-[11px] text-bad border border-bad/50 rounded px-1">SYNTHETIC INPUTS</span>}
          </div>
          <p className="text-[13px] text-muted">{CLASS_LABEL[c.machine_class]} <span className="text-faint">· machine label, not an identification</span></p>
        </div>
        <div className="flex flex-wrap gap-5 ml-auto">
          <Stat label="RA" value={raHms(c.ra)} sub={`${c.ra.toFixed(6)}°`} />
          <Stat label="Dec" value={decDms(c.dec)} sub={`${c.dec.toFixed(6)}°`} />
          <Stat label="Position σ" value={f(m.pos_err_arcsec, 1)} unit="″" />
          <Stat label="Peak" value={`${c.peak_significance >= 0 ? "+" : ""}${f(c.peak_significance, 1)}σ`} />
          <Stat label="ΔF" value={`${f(m.diff_flux_ujy, 1)} ± ${f(m.diff_flux_err_ujy, 1)}`} unit="µJy" />
        </div>
      </div>

      <div className="grid lg:grid-cols-4 sm:grid-cols-2 gap-2">
        <ImageCanvas {...common} className="h-64" layer={layers.a ?? null} title={`A · ${fmtDate(comp.t_a_mjd, false)}`} kind="original" limits={lim} stretch="asinh" cmap="gray" unit="MJy/sr" />
        <ImageCanvas {...common} className="h-64" layer={layers.b ?? null} title={`B · ${fmtDate(comp.t_b_mjd, false)}`} kind="original" limits={lim} stretch="asinh" cmap="gray" unit="MJy/sr" />
        <ImageCanvas {...common} className="h-64" layer={layers.diff ?? null} title="B − A" kind="derived" limits={percentileLimits(layers.diff?.data ?? new Float32Array([0, 1]), 0.5, 99.5, true)} stretch="linear" cmap="diverging" unit="MJy/sr" />
        <ImageCanvas {...common} className="h-64" layer={layers.significance ?? null} title="Significance" kind="derived" limits={{ lo: -8, hi: 8 }} stretch="linear" cmap="diverging" unit="σ" />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Panel title="Why it was flagged">
            <p className="text-[13px] leading-relaxed">{c.rank_explanation}</p>
            <p className="text-[12px] text-faint mt-2">{c.machine_class_description}</p>
          </Panel>
          <Panel title="Measurements">
            <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-[12px] num">
              {[
                ["Epoch A flux", `${f(m.flux_a_ujy, 1)} ± ${f(m.flux_a_err_ujy, 1)} µJy (S/N ${f(m.snr_a, 1)})`],
                ["Epoch B flux", `${f(m.flux_b_ujy, 1)} ± ${f(m.flux_b_err_ujy, 1)} µJy (S/N ${f(m.snr_b, 1)})`],
                ["Difference flux", `${f(m.diff_flux_ujy, 1)} ± ${f(m.diff_flux_err_ujy, 1)} µJy (S/N ${f(m.diff_snr, 1)})`],
                ["Peak significance", `${f(c.peak_significance, 2)}σ over ${m.npix} px`],
                ["λ A / λ B", `${f(m.wave_a_um, 4)} / ${f(m.wave_b_um, 4)} µm (bandwidth ${f(m.bandwidth_um, 4)})`],
                ["Aperture radius", `${f(m.aperture_radius_pix, 2)} px (1.5 × FWHM ${f(m.fwhm_arcsec, 2)}″)`],
                ["Signal epoch", fmtDate(m.epoch_signal_mjd)],
                ["Archive SOURCE flag", m.known_source_flag ? "set (known catalogue source)" : "not set"],
                ["Pipeline", c.pipeline_version],
                ["Comparison", comp.id],
              ].map(([k, val]) => (<div key={k} className="flex gap-2 border-b border-line/60 py-1"><dt className="text-faint w-36 shrink-0 font-sans">{k}</dt><dd>{val}</dd></div>))}
            </dl>
            {m.paired_with && <p className="text-[12px] mt-2">Paired with {m.paired_with.map((p: string) => <Link key={p} className="text-accent num mr-2" href={`/discovery/${p}`}>{p}</Link>)}</p>}
          </Panel>
          <Panel title="Quality checks"><Checks checks={c.quality_checks} /></Panel>
          <Panel title="Brightness across matched epochs" right={<Button onClick={runPhot} disabled={phot?.status === "running" || phot?.status === "queued"}>Run forced photometry</Button>}>
            {!phot && <p className="text-[12px] text-muted">Measures the flux at this position in every archive exposure of detector {comp.detector} that observed it within half a bandwidth of the candidate&apos;s wavelength. Downloads ~4 MB per exposure from IRSA.</p>}
            {phot && phot.status !== "done" && <Progress value={phot.progress} label={phot.message} />}
            {phot?.status === "done" && <LightCurve result={phot.result as any} highlight={[comp.t_a_mjd ?? 0, comp.t_b_mjd ?? 0]} />}
          </Panel>
        </div>
        <div className="flex flex-col gap-4">
          <Panel title="Share & explore">
            <div className="flex flex-col gap-2 text-[13px]">
              <Button onClick={() => { navigator.clipboard?.writeText(window.location.href); setCopied(true); }}>{copied ? "Permalink copied" : "Copy permalink"}</Button>
              <Link className="text-accent" href={href("/compare", { ra: comp.ra, dec: comp.dec, a: comp.product_a, b: comp.product_b, size: comp.size_deg, det: comp.detector ?? undefined, cand: c.id, mode: "blink" })}>Open in blink comparator →</Link>
              <Link className="text-accent" href={href("/", { ra: c.ra, dec: c.dec, fov: 0.3, cand: c.id, det: comp.detector ?? undefined })}>Show on sky map →</Link>
              <Link className="text-accent" href={href("/intelligence", { ra: c.ra, dec: c.dec, cand: c.id, cmp: comp.id })}>Ask Sky Intelligence →</Link>
              <a className="text-accent" target="_blank" rel="noreferrer" href={`https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${c.ra}+${c.dec}&Radius=15&Radius.unit=arcsec`}>SIMBAD objects within 15″ ↗</a>
            </div>
          </Panel>
          <Panel title="Tracking">
            {c.tracks.length === 0 ? <p className="text-[12px] text-muted">Not yet associated. Build tracks on the <Link className="text-accent" href={href("/tracking", { ra: c.ra, dec: c.dec })}>Tracking</Link> page.</p> :
              c.tracks.map((t) => (
                <div key={t.id} className="text-[12px] py-1 border-b border-line">
                  <span className="num">{t.id}</span> · {TRACK_LABEL[t.kind]} · {t.members.length} detection(s)
                </div>
              ))}
          </Panel>
          <Panel title="Source observations">
            <ul className="text-[12px] flex flex-col gap-1 num">
              {comp.provenance.inputs?.map((i) => (
                <li key={i.product_id}><a className="text-accent break-all" href={i.access_url}>{i.product_id}</a><div className="text-faint">{i.date_iso} · {i.band}</div></li>
              ))}
            </ul>
          </Panel>
          <Panel title="Community"><CommunityPanel targetId={c.id} /></Panel>
        </div>
      </div>
    </div>
  );
}
