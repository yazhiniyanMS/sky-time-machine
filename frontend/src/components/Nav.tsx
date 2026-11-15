"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { readViewState, toQuery } from "@/lib/viewstate";

// Ordered by how a session usually flows: find a position, list its epochs, compare, inspect.
const ITEMS = [
  { href: "/", label: "Explore" },
  { href: "/timeline", label: "Timeline" },
  { href: "/compare", label: "Compare" },
  { href: "/discoveries", label: "Discoveries" },
  { href: "/spectra", label: "Spectra" },
  { href: "/tracking", label: "Tracking" },
  { href: "/investigations", label: "Investigations" },
  { href: "/watchlists", label: "Watchlists" },
  { href: "/intelligence", label: "Assistant" },
];
const SECONDARY = [{ href: "/community", label: "Community" }];

export function Nav() {
  const path = usePathname();
  const sp = useSearchParams();
  const [open, setOpen] = useState(false);
  // Carry the sky position between sections so the context follows the user.
  const v = readViewState(sp);
  const carry = toQuery({ ra: v.ra, dec: v.dec, fov: v.fov, det: v.det, a: v.a, b: v.b, size: v.size, cand: v.cand });
  const active = (h: string) =>
    h === "/" ? path === "/" : path.startsWith(h) || (h === "/discoveries" && path.startsWith("/discovery"));
  const link = (it: { href: string; label: string }, cls: string, activeCls: string) => (
    <Link key={it.href} href={`${it.href}${carry}`} aria-current={active(it.href) ? "page" : undefined}
      onClick={() => setOpen(false)}
      className={`${cls} ${active(it.href) ? activeCls : "text-muted hover:text-text border-transparent"}`}>
      {it.label}
    </Link>
  );

  return (
    <header className="h-11 shrink-0 border-b border-line-strong bg-bg z-30 relative">
      <div className="h-full px-4 flex items-stretch gap-6">
        <Link href={`/${carry}`} className="flex items-center gap-2.5 shrink-0" aria-label="Sky Time Machine home">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="text-text">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
            <path d="M8 4v4l2.6 1.6" stroke="currentColor" strokeWidth="1.25" fill="none" />
          </svg>
          <span className="serif text-[16px] font-semibold tracking-[-0.01em]">Sky Time Machine</span>
        </Link>
        <nav className="hidden xl:flex items-stretch text-[13px]" aria-label="Main">
          {ITEMS.map((it) => link(it, "px-2.5 flex items-center border-b-2 -mb-px transition-colors", "text-text border-text font-medium"))}
        </nav>
        <div className="hidden xl:flex items-center gap-4 ml-auto text-[12px]">
          {SECONDARY.map((it) => link(it, "", "text-text font-medium"))}
          <span className="num text-[11px] text-faint border-l border-line pl-4">SPHEREx DR1 · NASA/IPAC IRSA</span>
        </div>
        <button className="xl:hidden ml-auto self-center h-8 text-[13px] px-3 border border-line-strong rounded-sm" aria-expanded={open}
          aria-controls="mobile-nav" onClick={() => setOpen((o) => !o)}>
          {open ? "Close" : "Menu"}
        </button>
      </div>
      {open && (
        <nav id="mobile-nav" className="xl:hidden absolute top-11 inset-x-0 bg-bg border-b border-line-strong text-[14px]">
          {[...ITEMS, ...SECONDARY].map((it) => link(it, "block px-4 py-2.5 border-b border-line", "text-text font-medium bg-panel-2"))}
        </nav>
      )}
    </header>
  );
}
