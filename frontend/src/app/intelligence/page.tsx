"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Button, ErrorNote, inputCls } from "@/components/ui";
import { get, post } from "@/lib/api";
import { readViewState } from "@/lib/viewstate";

interface Msg { role: "user" | "assistant"; content: string; meta?: { mode: string; model: string | null; grounding?: any; notice?: string } }

const EXAMPLES = [
  "What changed in this region?",
  "Show unusual candidates.",
  "Explain why this candidate was flagged.",
  "Compare the brightness across available observations.",
  "Is this detection likely to be an artifact?",
  "Explain the scientific significance of this observation.",
];

// Minimal, safe markdown: headings, bold, inline code, bullet lists. No HTML injection.
function Markdown({ text }: { text: string }) {
  const inline = (s: string, k: number) =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) =>
      p.startsWith("**") ? <strong key={`${k}-${i}`}>{p.slice(2, -2)}</strong> :
      p.startsWith("`") ? <code key={`${k}-${i}`} className="num text-accent">{p.slice(1, -1)}</code> : p);
  return (
    <div className="flex flex-col gap-1.5 text-[13px] leading-relaxed">
      {text.split("\n").map((l, i) =>
        l.startsWith("### ") || l.startsWith("## ") ? <h3 key={i} className="text-[12px] uppercase tracking-wider text-muted mt-2">{l.replace(/^#+ /, "")}</h3> :
        /^\s*[-*] /.test(l) ? <div key={i} className="pl-4 relative before:content-['–'] before:absolute before:left-0 before:text-faint">{inline(l.replace(/^\s*[-*] /, ""), i)}</div> :
        l.trim() === "" ? <div key={i} className="h-1" /> :
        /^_.*_$/.test(l.trim()) ? <p key={i} className="italic text-muted">{l.trim().slice(1, -1)}</p> : <p key={i}>{inline(l, i)}</p>)}
    </div>
  );
}

function Intelligence() {
  const v = readViewState(useSearchParams());
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<{ provider: string; model: string | null; llm_enabled: boolean } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const ctx = { ra: v.ra, dec: v.dec, fov: v.fov, detector: v.det, product_a: v.a, product_b: v.b, candidate_id: v.cand, comparison_id: v.cmp, radius: Math.min(1, v.fov ?? 0.25) };

  useEffect(() => { get<typeof status>("/api/assistant/status").then(setStatus).catch(() => {}); }, []);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setErr(null);
    const history = msgs.map(({ role, content }) => ({ role, content }));
    setMsgs((m) => [...m, { role: "user", content: question }]);
    setQ("");
    setBusy(true);
    try {
      const r = await post<{ answer: string; mode: string; model: string | null; grounding: any; notice?: string }>("/api/assistant/chat", { question, history, context: ctx });
      setMsgs((m) => [...m, { role: "assistant", content: r.answer, meta: { mode: r.mode, model: r.model, grounding: r.grounding, notice: r.notice } }]);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const ctxChips = [
    v.ra != null && v.dec != null && `Region ${v.ra.toFixed(3)}, ${v.dec.toFixed(3)}`,
    v.cmp && `Comparison ${v.cmp}`,
    v.cand && `Candidate ${v.cand}`,
    v.det && `Detector ${v.det}`,
  ].filter(Boolean) as string[];

  return (
    <div className="flex-1 flex flex-col max-w-3xl w-full mx-auto p-4 gap-3 min-h-0">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold mr-2">Sky Intelligence</h1>
        <span className={`text-[11px] px-1.5 h-5 inline-flex items-center rounded border ${status?.llm_enabled ? "border-accent/50 text-accent" : "border-line-strong text-muted"}`}>
          {status ? (status.llm_enabled ? `LLM · ${status.model}` : "Rule-based mode (no LLM key configured)") : "…"}
        </span>
      </div>
      <div className="flex flex-wrap gap-1 text-[11px]">
        <span className="text-faint mr-1">Context:</span>
        {ctxChips.length ? ctxChips.map((c) => <span key={c} className="px-1.5 h-5 inline-flex items-center rounded bg-panel-2 border border-line num">{c}</span>) : <span className="text-muted">none — open this page from a comparison or candidate to ground answers.</span>}
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col gap-4 py-2 min-h-[300px]">
        {msgs.length === 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-muted">Answers are grounded in stored measurements, quality checks and this project&apos;s methodology documents. Measurements and interpretation are labelled separately; no candidate is presented as a confirmed discovery.</p>
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((e) => <button key={e} onClick={() => ask(e)} className="text-[12px] px-2 py-1 border border-line rounded hover:border-accent text-left">{e}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "self-end max-w-[85%] bg-panel-2 border border-line rounded-md px-3 py-2 text-[13px]" : "border-l-2 border-accent-dim pl-3"}>
            {m.role === "user" ? m.content : <Markdown text={m.content} />}
            {m.meta && (
              <div className="mt-2 text-[10px] text-faint num flex flex-wrap gap-x-3">
                <span>{m.meta.mode === "llm" ? `model ${m.meta.model}` : "rule-based"}</span>
                {m.meta.grounding?.candidate && <span>candidate {m.meta.grounding.candidate}</span>}
                {m.meta.grounding?.comparison && <span>comparison {m.meta.grounding.comparison}</span>}
                {m.meta.grounding?.documents?.length > 0 && <span>docs: {m.meta.grounding.documents.join("; ")}</span>}
                {m.meta.notice && <span className="text-warn">{m.meta.notice}</span>}
              </div>
            )}
          </div>
        ))}
        {busy && <p className="text-[12px] text-muted" role="status">Thinking…</p>}
        <div ref={end} />
      </div>
      <ErrorNote error={err} />
      <form onSubmit={(e) => { e.preventDefault(); ask(q); }} className="flex gap-2 sticky bottom-2">
        <label htmlFor="ask" className="sr-only">Ask a question</label>
        <input id="ask" value={q} onChange={(e) => setQ(e.target.value)} maxLength={2000} placeholder="Ask about this region, comparison or candidate…" className={`${inputCls} flex-1 h-10`} />
        <Button variant="primary" className="h-10" disabled={busy || !q.trim()}>Ask</Button>
      </form>
    </div>
  );
}

export default function Page() {
  return <Suspense><Intelligence /></Suspense>;
}
