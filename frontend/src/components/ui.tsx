// Shared primitives for the "Plate & Graphite" system (docs/DESIGN_SYSTEM.md).
import type { ReactNode } from "react";
import type { Check } from "@/lib/api";

/** Flat section: a hairline rule, a sentence-case head and optional controls. No box. */
export function Panel({ title, right, children, className = "", dense = false }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; dense?: boolean }) {
  return (
    <section className={`border-t border-line-strong ${className}`}>
      {(title || right) && (
        <header className={`flex items-baseline gap-3 ${dense ? "pt-2 pb-1.5" : "pt-2.5 pb-2"}`}>
          <h2 className="text-[13px] font-semibold text-text">{title}</h2>
          <div className="ml-auto flex items-center gap-2 text-[12px]">{right}</div>
        </header>
      )}
      <div className={title || right ? "" : "pt-3"}>{children}</div>
    </section>
  );
}

/** Page head: serif title, one line of mono metadata, optional controls on the right. */
export function PageHeader({ title, meta, right, eyebrow }: { title: ReactNode; meta?: ReactNode; right?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-x-8 gap-y-3 pb-4 border-b border-text/80">
      <div className="min-w-0">
        {eyebrow && <div className="text-[12px] text-muted mb-1">{eyebrow}</div>}
        <h1 className="serif text-[26px] leading-[1.15] font-semibold tracking-[-0.01em]">{title}</h1>
        {meta && <div className="num text-[12px] text-muted mt-1.5">{meta}</div>}
      </div>
      {right && <div className="ml-auto flex flex-wrap items-end gap-x-6 gap-y-2">{right}</div>}
    </div>
  );
}

export function Button({ children, variant = "default", className = "", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" }) {
  const v = {
    default: "border border-line-strong bg-transparent hover:bg-panel-2 text-text",
    primary: "bg-text text-on-ink hover:opacity-90 font-medium",
    ghost: "text-muted hover:text-text underline-offset-4 hover:underline",
  }[variant];
  return (
    <button {...rest} className={`h-8 px-3 rounded-sm text-[13px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${v} ${className}`}>
      {children}
    </button>
  );
}

/** Link styled as the single primary action of a view. */
export const primaryLinkCls = "h-9 px-4 inline-flex items-center justify-center rounded-sm bg-text text-on-ink text-[13px] font-medium hover:opacity-90";
export const textLinkCls = "text-text underline decoration-line-strong hover:decoration-accent hover:text-accent";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-muted">
      {label}
      {children}
    </label>
  );
}

export const inputCls =
  "h-8 px-2 rounded-sm bg-panel border border-line-strong text-[13px] text-text placeholder:text-faint focus:border-text outline-none";

export function Tag({ children, tone = "muted", title }: { children: ReactNode; tone?: "muted" | "original" | "derived" | "bad" | "good" | "warn" | "text"; title?: string }) {
  const c = { muted: "text-muted border-line-strong", original: "text-original border-original/60", derived: "text-derived border-derived/60", bad: "text-bad border-bad/60", good: "text-good border-good/60", warn: "text-warn border-warn/60", text: "text-text border-text/60" }[tone];
  return <span title={title} className={`inline-flex items-center h-[18px] px-1.5 border text-[10px] font-medium uppercase tracking-[0.06em] leading-none whitespace-nowrap ${c}`}>{children}</span>;
}

export function KindBadge({ kind }: { kind: "original" | "derived" | "synthetic" }) {
  const label = { original: "Original", derived: "Derived", synthetic: "Synthetic" }[kind];
  const title = { original: "Archive pixels (resampled to the common grid)", derived: "Computed by this pipeline", synthetic: "Synthetic test input" }[kind];
  return <Tag tone={kind === "synthetic" ? "bad" : kind} title={title}>{label}</Tag>;
}

export function TierBadge({ tier }: { tier: "A" | "B" | "R" }) {
  const t = { A: "Tier A — all checks passed", B: "Tier B — warnings", R: "Rejected — failed a hard check" }[tier];
  const tone = { A: "good", B: "warn", R: "bad" }[tier] as "good" | "warn" | "bad";
  return <Tag tone={tone} title={t}>Tier {tier}</Tag>;
}

export function VerificationBadge({ status }: { status: string }) {
  const tone = status === "confirmed_real" ? "good" : status === "rejected_artifact" ? "bad" : status === "under_review" ? "warn" : "muted";
  return <Tag tone={tone}>{status.replace("_", " ")}</Tag>;
}

/** Pass/fail list: a glyph and a word, never colour alone. Name and detail stack so it fits narrow columns. */
export function Checks({ checks }: { checks: Check[] }) {
  return (
    <ul className="text-[12px]">
      {checks.map((c, i) => {
        const s = c.passed ? ["✓", "text-good", "pass"] : c.severity === "error" ? ["✕", "text-bad", "fail"] : c.severity === "warning" ? ["!", "text-warn", "warning"] : ["·", "text-faint", "info"];
        return (
          <li key={i} className="py-1.5 border-b border-line last:border-0">
            <div className="flex items-baseline gap-2">
              <span className={`num text-[11px] w-16 shrink-0 ${s[1]}`} aria-label={c.passed ? "passed" : `failed (${c.severity})`}>{s[0]} {s[2]}</span>
              <span className="num text-text break-all">{c.name}</span>
            </div>
            <div className="text-muted pl-[4.5rem] break-words">{c.detail}</div>
          </li>
        );
      })}
    </ul>
  );
}

/** Label above a mono value. Used in metadata strips. */
export function Stat({ label, value, unit, sub }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[11px] text-muted">{label}</span>
      <span className="num text-[13px] text-text whitespace-nowrap">
        {value}
        {unit && <span className="text-muted ml-1">{unit}</span>}
      </span>
      {sub && <span className="num text-[11px] text-faint">{sub}</span>}
    </div>
  );
}

/** Two-column definition list for technical metadata. */
export function MetaList({ rows, labelWidth = "9rem" }: { rows: [ReactNode, ReactNode][]; labelWidth?: string }) {
  return (
    <dl className="grid gap-x-4 text-[12px]" style={{ gridTemplateColumns: `${labelWidth} 1fr` }}>
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted py-1 border-b border-line">{k}</dt>
          <dd className="num py-1 border-b border-line min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="border-l-2 border-bad pl-3 py-1 text-[13px]">
      <span className="text-bad font-medium">Error. </span>
      <span className="text-text">{error}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-muted py-3">{children}</p>;
}

export function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div className="flex flex-col gap-1.5 py-1" role="status" aria-live="polite">
      <div className="h-px bg-line-strong overflow-hidden">
        <div className="h-px bg-text transition-[width]" style={{ width: `${Math.max(2, Math.round(value * 100))}%` }} />
      </div>
      {label && <span className="text-[12px] text-muted">{label}</span>}
    </div>
  );
}

/** Flat segmented control with an ink underline on the active option. */
export function Segmented<T extends string | number>({ options, value, onChange, label }: { options: { value: T; label: ReactNode; title?: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-stretch border border-line-strong rounded-sm overflow-hidden">
      {options.map((o, i) => (
        <button key={String(o.value)} role="radio" aria-checked={o.value === value} title={o.title} onClick={() => onChange(o.value)}
          className={`h-8 px-3 text-[13px] ${i ? "border-l border-line-strong" : ""} ${o.value === value ? "bg-text text-on-ink" : "text-muted hover:text-text hover:bg-panel-2"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const f = (x: number | null | undefined, d = 2) => (x == null || !isFinite(x) ? "—" : x.toFixed(d));
