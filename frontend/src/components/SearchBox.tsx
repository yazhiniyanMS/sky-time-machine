"use client";

import { useState } from "react";
import { get } from "@/lib/api";
import { parseCoords } from "@/lib/astro";

export function SearchBox({ onGo, className = "" }: { onGo: (ra: number, dec: number, label: string) => void; className?: string }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = q.trim();
    if (!text) return;
    setErr(null);
    const c = parseCoords(text);
    if (c) return onGo(c.ra, c.dec, text);
    setBusy(true);
    try {
      const r = await get<{ ra: number; dec: number }>(`/api/resolve?name=${encodeURIComponent(text)}`);
      onGo(r.ra, r.dec, text);
    } catch (e: any) {
      setErr(e.message || "Not found");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={`flex flex-col gap-1 ${className}`} role="search">
      <div className="flex h-8 rounded-sm border border-line-strong bg-panel focus-within:border-text">
        <label htmlFor="sky-search" className="sr-only">Object name or coordinates</label>
        <input
          id="sky-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Object name or RA Dec — M31, 10.6847 +41.2690"
          className="flex-1 min-w-0 bg-transparent px-2.5 text-[13px] outline-none placeholder:text-faint"
          autoComplete="off"
        />
        <button type="submit" disabled={busy} className="px-3 text-[12px] font-medium text-text hover:bg-panel-2 border-l border-line-strong">
          {busy ? "Resolving…" : "Go to"}
        </button>
      </div>
      {err && <p role="alert" className="text-[12px] text-bad">{err}</p>}
    </form>
  );
}
