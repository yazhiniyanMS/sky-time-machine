"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Button, ErrorNote, Field, inputCls, Panel } from "@/components/ui";
import { get, type Investigation, post } from "@/lib/api";
import { readViewState } from "@/lib/viewstate";

function Investigations() {
  const v = readViewState(useSearchParams());
  const router = useRouter();
  const [list, setList] = useState<Investigation[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", description: "", owner: "", ra: v.ra?.toString() ?? "", dec: v.dec?.toString() ?? "", radius_deg: "0.25" });

  useEffect(() => {
    get<Investigation[]>("/api/investigations").then(setList).catch((e) => setErr(e.message));
    try { const o = localStorage.getItem("stm-author"); if (o) setForm((f) => ({ ...f, owner: o })); } catch {}
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const inv = await post<Investigation>("/api/investigations", {
        title: form.title, description: form.description, owner: form.owner,
        ra: form.ra ? Number(form.ra) : null, dec: form.dec ? Number(form.dec) : null, radius_deg: form.ra ? Number(form.radius_deg) : null,
      });
      try { localStorage.setItem("stm-author", form.owner); } catch {}
      router.push(`/investigations/${inv.id}`);
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="px-4 sm:px-6 py-6 max-w-[1200px] w-full mx-auto flex flex-col gap-4">
      <div>
        <h1 className="serif text-[26px] leading-tight font-semibold tracking-[-0.01em]">Investigations</h1>
        <p className="text-[12px] text-muted">Research collections stored on the server: saved candidates, comparisons, spectra, notes and references. Each has a permanent URL you can share.</p>
      </div>
      <ErrorNote error={err} />
      <div className="grid lg:grid-cols-[1fr_360px] gap-4">
        <Panel title={`Saved investigations (${list?.length ?? 0})`}>
          {list && list.length === 0 && <p className="text-[13px] text-muted">None yet. Create one here, or use “Save to investigation” on any candidate page.</p>}
          <ul className="divide-y divide-line">
            {list?.map((i) => (
              <li key={i.id} className="py-2 flex flex-wrap items-baseline gap-x-3">
                <Link className="font-medium underline decoration-line-strong hover:text-accent" href={`/investigations/${i.id}`}>{i.title}</Link>
                <span className="num text-[11px] text-faint">{i.id}</span>
                <span className="text-[12px] text-muted">{i.n_items} item{i.n_items === 1 ? "" : "s"}</span>
                {i.ra != null && <span className="num text-[11px] text-muted">{i.ra.toFixed(3)}, {i.dec?.toFixed(3)}</span>}
                <span className="ml-auto num text-[11px] text-faint">updated {i.updated_at.slice(0, 16).replace("T", " ")}</span>
                {i.description && <p className="w-full text-[12px] text-muted truncate">{i.description}</p>}
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="New investigation">
          <form onSubmit={create} className="flex flex-col gap-3">
            <Field label="Title"><input required maxLength={200} className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
            <Field label="Description"><textarea rows={3} className={`${inputCls} h-auto py-1`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <Field label="Owner (display name)"><input maxLength={64} className={inputCls} value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} /></Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="RA °"><input className={`${inputCls} num`} value={form.ra} onChange={(e) => setForm({ ...form, ra: e.target.value })} /></Field>
              <Field label="Dec °"><input className={`${inputCls} num`} value={form.dec} onChange={(e) => setForm({ ...form, dec: e.target.value })} /></Field>
              <Field label="Radius °"><input className={`${inputCls} num`} value={form.radius_deg} onChange={(e) => setForm({ ...form, radius_deg: e.target.value })} /></Field>
            </div>
            <Button variant="primary" type="submit">Create</Button>
          </form>
        </Panel>
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense><Investigations /></Suspense>;
}
