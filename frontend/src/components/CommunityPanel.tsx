"use client";

import { useEffect, useState } from "react";
import { type Annotation, get, post } from "@/lib/api";
import { Button, ErrorNote, inputCls } from "./ui";

const KINDS = [
  { id: "interesting", label: "Interesting" },
  { id: "not_interesting", label: "Not interesting" },
  { id: "artifact", label: "Looks like an artifact" },
  { id: "flag", label: "Flag for review" },
  { id: "note", label: "Note" },
];

export function CommunityPanel({ targetId }: { targetId: string }) {
  const [items, setItems] = useState<Annotation[]>([]);
  const [author, setAuthor] = useState("");
  const [kind, setKind] = useState("interesting");
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => get<Annotation[]>(`/api/annotations?target_id=${encodeURIComponent(targetId)}`).then(setItems).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    try { setAuthor(localStorage.getItem("stm-author") || ""); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    try {
      const r = await post<Annotation>("/api/annotations", { target_type: "candidate", target_id: targetId, author, kind, body });
      try { localStorage.setItem("stm-author", author); } catch {}
      setBody("");
      setMsg(r.status === "pending" ? "Submitted — held for moderation because it contains a link." : "Thanks — recorded.");
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  const counts = KINDS.slice(0, 3).map((k) => ({ ...k, n: items.filter((i) => i.kind === k.id).length }));
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <p className="text-[11px] text-faint">Community classifications are recorded separately from the machine output and never change the scientific verification status.</p>
      <div className="flex gap-3 text-[12px] num text-muted">{counts.map((c) => <span key={c.id}>{c.label}: <span className="text-text">{c.n}</span></span>)}</div>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input aria-label="Your display name" required minLength={2} maxLength={64} value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Display name" className={`${inputCls} w-36`} />
          <select aria-label="Classification" value={kind} onChange={(e) => setKind(e.target.value)} className={`${inputCls} flex-1`}>
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </div>
        <textarea aria-label="Note" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} rows={3}
          placeholder={kind === "note" || kind === "flag" ? "Required for notes and flags" : "Optional comment"} className={`${inputCls} h-auto py-1.5`} />
        <Button type="submit" variant="primary" className="self-start">Submit</Button>
      </form>
      <ErrorNote error={err} />
      {msg && <p className="text-[12px] text-good" role="status">{msg}</p>}
      <ul className="divide-y divide-line">
        {items.map((a) => (
          <li key={a.id} className="py-2">
            <div className="flex gap-2 text-[11px] text-faint num"><span className="text-muted">{a.author}</span><span>{a.kind.replace("_", " ")}</span><span className="ml-auto">{a.created_at.slice(0, 16).replace("T", " ")}</span></div>
            {a.body && <p className="text-[13px] mt-0.5 whitespace-pre-wrap">{a.body}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
