"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { readViewState, toQuery } from "@/lib/viewstate";

const ITEMS = [
  { href: "/", label: "Explore" },
  { href: "/timeline", label: "Timeline" },
  { href: "/discoveries", label: "Discoveries" },
  { href: "/compare", label: "Compare" },
  { href: "/tracking", label: "Tracking" },
  { href: "/intelligence", label: "Sky Intelligence" },
  { href: "/community", label: "Community" },
];

export function Nav() {
  const path = usePathname();
  const sp = useSearchParams();
  const [open, setOpen] = useState(false);
  // Carry the sky position between sections so the context follows the user.
  const v = readViewState(sp);
  const carry = toQuery({ ra: v.ra, dec: v.dec, fov: v.fov, det: v.det, a: v.a, b: v.b, size: v.size, cand: v.cand });
  const active = (h: string) => (h === "/" ? path === "/" : path.startsWith(h) || (h === "/discoveries" && path.startsWith("/discovery")));

  return (
    <header className="h-12 shrink-0 border-b border-line bg-bg/95 backdrop-blur z-30 relative">
      <div className="h-full px-4 flex items-center gap-6">
        <Link href={`/${carry}`} className="flex items-center gap-2 shrink-0" aria-label="Sky Time Machine home">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
            <circle cx="12" cy="12" r="9.5" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
            <path d="M12 6v6l4 2" stroke="var(--text)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
            <circle cx="18.5" cy="5.5" r="1.4" fill="var(--derived)" />
          </svg>
          <span className="text-[13px] font-semibold tracking-wide">Sky Time Machine</span>
        </Link>
        <nav className="hidden lg:flex items-center gap-1 text-[13px]" aria-label="Main">
          {ITEMS.map((it) => (
            <Link
              key={it.href}
              href={`${it.href}${carry}`}
              aria-current={active(it.href) ? "page" : undefined}
              className={`px-2.5 py-1.5 rounded transition-colors ${
                active(it.href) ? "text-text bg-panel-2" : "text-muted hover:text-text"
              }`}
            >
              {it.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto hidden md:block text-[11px] text-faint">
          Data: NASA/IPAC IRSA · SPHEREx DR1
        </div>
        <button
          className="lg:hidden ml-auto text-muted text-sm px-2 py-1 border border-line rounded"
          aria-expanded={open}
          aria-controls="mobile-nav"
          onClick={() => setOpen((o) => !o)}
        >
          Menu
        </button>
      </div>
      {open && (
        <nav id="mobile-nav" className="lg:hidden absolute top-12 inset-x-0 bg-panel border-b border-line p-2 grid grid-cols-2 gap-1 text-sm">
          {ITEMS.map((it) => (
            <Link key={it.href} href={`${it.href}${carry}`} onClick={() => setOpen(false)}
              className={`px-3 py-2 rounded ${active(it.href) ? "bg-panel-2 text-text" : "text-muted"}`}>
              {it.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
