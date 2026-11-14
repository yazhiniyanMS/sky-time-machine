// Small UI primitives shared across pages.
import type { ReactNode } from "react";
import type { Check } from "@/lib/api";

export function Panel({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`border border-line rounded-md bg-panel ${className}`}>
      {(title || right) && (
        <header className="flex items-center gap-2 px-3 h-9 border-b border-line">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.08em] text-muted">{title}</h2>
          <div className="ml-auto flex items-center gap-2">{right}</div>
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Button({ children, variant = "default", className = "", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" }) {
  const v = {
    default: "border border-line-strong bg-panel-2 hover:border-muted text-text",
    primary: "bg-accent text-[#04121f] hover:brightness-110 font-medium",
    ghost: "text-muted hover:text-text",
  }[variant];
  return (
    <button {...rest} className={`h-8 px-3 rounded text-[13px] transition disabled:opacity-40 disabled:cursor-not-allowed ${v} ${className}`}>
      {children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-faint">
      {label}
      {children}
    </label>
  );
}

export const inputCls =
  "h-8 px-2 rounded bg-bg border border-line-strong text-[13px] text-text normal-case tracking-normal placeholder:text-faint focus:border-accent outline-none";

export function KindBadge({ kind }: { kind: "original" | "derived" | "synthetic" }) {
  const style = {
    original: "border-accent/50 text-accent",
    derived: "border-derived/60 text-derived",
    synthetic: "border-bad/60 text-bad",
  }[kind];
  const label = { original: "Original data", derived: "Derived product", synthetic: "Synthetic" }[kind];
  return <span className={`inline-flex items-center h-5 px-1.5 rounded border text-[10px] uppercase tracking-wider ${style}`}>{label}</span>;
}

export function TierBadge({ tier }: { tier: "A" | "B" | "R" }) {
  const s = { A: "bg-good/15 text-good border-good/40", B: "bg-warn/10 text-warn border-warn/40", R: "bg-bad/10 text-bad border-bad/40" }[tier];
  const t = { A: "Tier A — all checks passed", B: "Tier B — warnings", R: "Rejected — failed a hard check" }[tier];
  return <span title={t} className={`inline-flex items-center h-5 px-1.5 rounded border text-[11px] num ${s}`}>{tier}</span>;
}

export function VerificationBadge({ status }: { status: string }) {
  const s =
    status === "confirmed_real" ? "text-good border-good/40" : status === "rejected_artifact" ? "text-bad border-bad/40" : status === "under_review" ? "text-warn border-warn/40" : "text-muted border-line-strong";
  return <span className={`inline-flex items-center h-5 px-1.5 rounded border text-[10px] uppercase tracking-wider ${s}`}>{status.replace("_", " ")}</span>;
}

export function Checks({ checks }: { checks: Check[] }) {
  return (
    <ul className="divide-y divide-line text-[12px]">
      {checks.map((c, i) => (
        <li key={i} className="py-1.5 flex gap-2 items-start">
          <span
            aria-label={c.passed ? "passed" : `failed (${c.severity})`}
            className={`mt-1 w-2 h-2 rounded-full shrink-0 ${c.passed ? "bg-good" : c.severity === "error" ? "bg-bad" : c.severity === "warning" ? "bg-warn" : "bg-faint"}`}
          />
          <span className="num text-muted w-44 shrink-0">{c.name}</span>
          <span className="text-text/90">{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export function Stat({ label, value, unit, sub }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-faint">{label}</span>
      <span className="num text-[13px]">
        {value}
        {unit && <span className="text-muted ml-1">{unit}</span>}
      </span>
      {sub && <span className="text-[11px] text-faint">{sub}</span>}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div role="alert" className="border border-bad/40 bg-bad/5 text-bad text-[13px] rounded px-3 py-2">{error}</div>;
}

export function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div className="flex flex-col gap-1" role="status" aria-live="polite">
      <div className="h-1 bg-line rounded overflow-hidden">
        <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
      {label && <span className="text-[12px] text-muted">{label}</span>}
    </div>
  );
}

export const f = (x: number | null | undefined, d = 2) => (x == null || !isFinite(x) ? "—" : x.toFixed(d));
