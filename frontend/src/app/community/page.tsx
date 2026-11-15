"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, ErrorNote, inputCls, Panel } from "@/components/ui";
import { type Annotation, get, post } from "@/lib/api";

interface AuditEvent { id: number; created_at: string; target_type: string; target_id: string; action: string; actor: string; detail: Record<string, any> }

export default function Community() {
  const [feed, setFeed] = useState<Annotation[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [token, setToken] = useState("");
  const [queue, setQueue] = useState<Annotation[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    get<Annotation[]>("/api/annotations?limit=100").then(setFeed).catch((e) => setErr(e.message));
    get<AuditEvent[]>("/api/audit?limit=100").then(setAudit).catch(() => {});
  };
  useEffect(() => {
    load();
    try { setToken(sessionStorage.getItem("stm-mod") || ""); } catch {}
  }, []);

  async function loadQueue() {
    setErr(null);
    try {
      try { sessionStorage.setItem("stm-mod", token); } catch {}
      const r = await fetch(`${(process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000")}/api/moderation/queue`, { headers: { "X-Moderator-Token": token } });
      if (!r.ok) throw new Error((await r.json()).detail);
      setQueue(await r.json());
    } catch (e: any) {
      setErr(e.message);
    }
  }
  async function moderate(id: number, action: string) {
    const reason = prompt(`Reason for "${action}"?`);
    if (!reason) return;
    try {
      await post(`/api/annotations/${id}/moderate`, { action, reason }, { "X-Moderator-Token": token });
      loadQueue();
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <div className="px-4 sm:px-6 py-6 max-w-[1300px] w-full mx-auto flex flex-col gap-4">
      <div>
        <h1 className="serif text-[26px] leading-tight font-semibold tracking-[-0.01em]">Community</h1>
        <p className="text-[12px] text-muted">Citizen-science classifications and notes. Votes are opinions for reviewers; they never confirm a candidate. Machine and human classifications are stored separately, and every change is audited.</p>
      </div>
      <ErrorNote error={err} />
      <div className="grid lg:grid-cols-2 gap-4">
        <Panel title={`Recent annotations (${feed.length})`}>
          {feed.length === 0 && <p className="text-[12px] text-muted">No annotations yet. Open a candidate under Discoveries to add one.</p>}
          <ul className="divide-y divide-line text-[12px]">
            {feed.map((a) => (
              <li key={a.id} className="py-1.5">
                <div className="flex gap-2 num text-faint"><Link className="text-text underline decoration-line-strong hover:text-accent" href={`/discovery/${a.target_id}`}>{a.target_id}</Link><span>{a.kind.replace("_", " ")}</span><span className="text-muted">{a.author}</span><span className="ml-auto">{a.created_at.slice(0, 16).replace("T", " ")}</span></div>
                {a.body && <p className="mt-0.5 whitespace-pre-wrap">{a.body}</p>}
              </li>
            ))}
          </ul>
        </Panel>
        <div className="flex flex-col gap-4">
          <Panel title="Moderation">
            <form onSubmit={(e) => { e.preventDefault(); loadQueue(); }} className="flex gap-2">
              <label htmlFor="tok" className="sr-only">Moderator token</label>
              <input id="tok" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Moderator token" className={`${inputCls} flex-1`} autoComplete="off" />
              <Button type="submit">Open queue</Button>
            </form>
            <p className="text-[11px] text-faint mt-1">Moderation is enabled when the server sets STM_MODERATOR_TOKEN. Notes containing links are held automatically.</p>
            {queue && (
              <ul className="mt-2 divide-y divide-line text-[12px]">
                {queue.length === 0 && <li className="py-1 text-muted">Queue empty.</li>}
                {queue.map((a) => (
                  <li key={a.id} className="py-1.5 flex flex-col gap-1">
                    <div className="flex gap-2 num text-faint"><span>#{a.id}</span><span>{a.status}</span><span>{a.author}</span><span>{a.target_id}</span></div>
                    <p className="whitespace-pre-wrap">{a.body || <em className="text-muted">({a.kind})</em>}</p>
                    <div className="flex gap-2">
                      {a.status !== "visible" && <Button onClick={() => moderate(a.id, "approve")}>Approve</Button>}
                      {a.status !== "hidden" && <Button onClick={() => moderate(a.id, "hide")}>Hide</Button>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Audit history">
            <ul className="divide-y divide-line text-[11px] num max-h-[420px] overflow-y-auto">
              {audit.map((e) => (
                <li key={e.id} className="py-1 flex flex-wrap gap-x-3">
                  <span className="text-faint">{e.created_at.slice(0, 19).replace("T", " ")}</span>
                  <span>{e.action}</span><span className="text-muted">{e.target_type} {e.target_id}</span><span className="text-muted">by {e.actor}</span>
                  {e.detail?.reason && <span className="text-faint w-full">“{e.detail.reason}”</span>}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
