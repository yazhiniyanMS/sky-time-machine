"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CommunityPanel } from "@/components/CommunityPanel";
import { ImageCanvas, type View } from "@/components/ImageCanvas";
import { AssessmentPanel, CounterpartsPanel, DataKindLegend, HistoryPanel, PsfPanel } from "@/components/CandidatePanels";
import { SaveToInvestigation, WatchButton } from "@/components/SaveTo";
import { Button, ErrorNote, f, Panel, Progress, Stat, Tag, TierBadge, VerificationBadge } from "@/components/ui";
import { API, type CandidateDetail, fetchLayer, get, type Layer } from "@/lib/api";
import { CLASS_LABEL, decDms, fmtDate, raHms, TRACK_LABEL } from "@/lib/astro";
import { percentileLimits } from "@/lib/render";
import { href } from "@/lib/viewstate";

export default function DiscoveryPage() {
  const { id } = useParams<{ id: string }>();
  const [c, setC] = useState<CandidateDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<string, Layer>>({});
  const [view, setView] = useState<View | null>(null);
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



  return (
    <div className="px-4 sm:px-6 py-6 max-w-[1500px] w-full mx-auto flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-10 gap-y-4 pb-4 border-b border-text/80">
        <div className="min-w-0">
          <div className="text-[12px] text-muted">Change candidate · {CLASS_LABEL[c.machine_class]} <span className="text-faint">(machine label, not an identification)</span></div>
          <h1 className="num text-[26px] leading-tight font-medium mt-1">{c.id}</h1>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <TierBadge tier={c.quality_tier} />
            <VerificationBadge status={c.verification_status} />
            {synthetic && <Tag tone="bad">Synthetic inputs</Tag>}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-7 gap-y-2 ml-auto">
          <Stat label="RA" value={raHms(c.ra)} sub={`${c.ra.toFixed(6)}°`} />
          <Stat label="Dec" value={decDms(c.dec)} sub={`${c.dec.toFixed(6)}°`} />
          <Stat label="Position σ" value={f(m.pos_err_arcsec, 1)} unit="″" />
          <Stat label="Peak" value={`${c.peak_significance >= 0 ? "+" : ""}${f(c.peak_significance, 1)}σ`} />
          <Stat label="ΔF" value={`${f(m.diff_flux_ujy, 1)} ± ${f(m.diff_flux_err_ujy, 1)}`} unit="µJy" />
        </div>
      </div>
      <DataKindLegend />

      <div className="grid lg:grid-cols-4 sm:grid-cols-2 gap-3">
        <ImageCanvas {...common} className="h-64" layer={layers.a ?? null} title={`A · ${fmtDate(comp.t_a_mjd, false)}`} kind="original" limits={lim} stretch="asinh" cmap="gray" unit="MJy/sr" />
        <ImageCanvas {...common} className="h-64" layer={layers.b ?? null} title={`B · ${fmtDate(comp.t_b_mjd, false)}`} kind="original" limits={lim} stretch="asinh" cmap="gray" unit="MJy/sr" />
        <ImageCanvas {...common} className="h-64" layer={layers.diff ?? null} title="B − A" kind="derived" limits={percentileLimits(layers.diff?.data ?? new Float32Array([0, 1]), 0.5, 99.5, true)} stretch="linear" cmap="diverging" unit="MJy/sr" />
        <ImageCanvas {...common} className="h-64" layer={layers.significance ?? null} title="Significance" kind="derived" limits={{ lo: -8, hi: 8 }} stretch="linear" cmap="diverging" unit="σ" />
      </div>

      <div className="grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-x-10 gap-y-6">
        <div className="flex flex-col gap-6 min-w-0">
          <AssessmentPanel id={c.id} />
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
            {m.paired_with && <p className="text-[12px] mt-2">Paired with {m.paired_with.map((p: string) => <Link key={p} className="num mr-2 underline decoration-line-strong hover:text-accent" href={`/discovery/${p}`}>{p}</Link>)}</p>}
          </Panel>
          <div className="flex flex-col gap-6 [&>*]:min-w-0">
            <PsfPanel id={c.id} />
            <CounterpartsPanel id={c.id} />
          </div>
          <HistoryPanel id={c.id} ra={c.ra} dec={c.dec} detector={comp.detector}
            epochs={[{ x: comp.t_a_mjd ?? 0, label: "A" }, { x: comp.t_b_mjd ?? 0, label: "B" }]} />
        </div>
        <div className="flex flex-col gap-6 min-w-0">
          <Panel title="Save and monitor">
            <div className="flex flex-col gap-3">
              <SaveToInvestigation kind="candidate" refId={c.id} label={CLASS_LABEL[c.machine_class]} defaults={{ ra: c.ra, dec: c.dec }} />
              <WatchButton kind="candidate" refId={c.id} label={c.id} />
            </div>
          </Panel>
          <Panel title="Share and explore">
            <div className="flex flex-col gap-2 text-[13px]">
              <Button onClick={() => { navigator.clipboard?.writeText(window.location.href); setCopied(true); }}>{copied ? "Permalink copied" : "Copy permalink"}</Button>
              <Link className="text-text underline decoration-line-strong hover:text-accent" href={href("/compare", { ra: comp.ra, dec: comp.dec, a: comp.product_a, b: comp.product_b, size: comp.size_deg, det: comp.detector ?? undefined, cand: c.id, mode: "blink" })}>Open in the blink comparator</Link>
              <Link className="text-text underline decoration-line-strong hover:text-accent" href={href("/", { ra: c.ra, dec: c.dec, fov: 0.3, cand: c.id, det: comp.detector ?? undefined })}>Show on the sky map</Link>
              <Link className="text-text underline decoration-line-strong hover:text-accent" href={href("/intelligence", { ra: c.ra, dec: c.dec, cand: c.id, cmp: comp.id })}>Ask the assistant</Link>
              <a className="text-text underline decoration-line-strong hover:text-accent" target="_blank" rel="noreferrer" href={`https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${c.ra}+${c.dec}&Radius=15&Radius.unit=arcsec`}>SIMBAD objects within 15″ ↗</a>
            </div>
          </Panel>
          <Panel title="Tracking">
            {c.tracks.length === 0 ? <p className="text-[12px] text-muted">Not yet associated. Build tracks on the <Link className="text-text underline decoration-line-strong hover:text-accent" href={href("/tracking", { ra: c.ra, dec: c.dec })}>Tracking</Link> page.</p> :
              c.tracks.map((t) => (
                <div key={t.id} className="text-[12px] py-1 border-b border-line">
                  <span className="num">{t.id}</span> · {TRACK_LABEL[t.kind]} · {t.members.length} detection(s)
                </div>
              ))}
          </Panel>
          <Panel title="Processing history">
            <dl className="grid grid-cols-[110px_1fr] gap-y-1 text-[12px] num">
              <dt className="text-faint font-sans">Comparison</dt><dd>{comp.id}</dd>
              <dt className="text-faint font-sans">Pipeline</dt><dd>{c.pipeline_version}</dd>
              <dt className="text-faint font-sans">Processed</dt><dd>{String(comp.provenance.processed_at ?? "").slice(0, 19)}</dd>
              <dt className="text-faint font-sans">Detected</dt><dd>{c.created_at.slice(0, 19)}</dd>
              <dt className="text-faint font-sans">Software</dt><dd className="break-all">{Object.entries(comp.provenance.software ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ")}</dd>
            </dl>
            <a className="text-[12px] text-text underline decoration-line-strong hover:text-accent mt-2 inline-block" href={`${API}/api/comparisons/${comp.id}/references.csv`}>Observation references (CSV)</a>
          </Panel>
          <Panel title="Source observations">
            <ul className="text-[12px] flex flex-col gap-1 num">
              {comp.provenance.inputs?.map((i) => (
                <li key={i.product_id}><a className="break-all text-text underline decoration-line-strong hover:text-accent" href={i.access_url}>{i.product_id}</a><div className="text-faint">{i.date_iso} · {i.band}</div></li>
              ))}
            </ul>
          </Panel>
          <Panel title="Community"><CommunityPanel targetId={c.id} /></Panel>
        </div>
      </div>
    </div>
  );
}
