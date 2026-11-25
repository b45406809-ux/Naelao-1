"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useActiveSpace } from "@/lib/active-space-context";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import {
  createSubspaceBlackboardRoute,
  listDepartmentProjects,
  listDepartments,
  listSubspaceBlackboardMessages,
  listSubspaceBlackboardRoutes,
  openSubspaceResource,
  publishSubspaceBlackboardBroadcast,
  publishSubspaceBlackboardMessage,
  revokeSubspaceBlackboardRoute,
  type DepartmentOption,
  type Project,
  type SubspaceBlackboardMessage,
  type SubspaceBlackboardRoute,
  type SubspaceResourceDocument,
} from "@/lib/api";

export default function DepartmentProjectsPage() {
  const params = useParams<{ spaceId: string; departmentId: string }>();
  const product = useProduct();
  const { session } = useProductAuth();
  const { activeSpaceId, setActiveSpace } = useActiveSpace();
  const [departments, setDepartments] = React.useState<DepartmentOption[]>([]);
  const [department, setDepartment] = React.useState<DepartmentOption | null>(null);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [routes, setRoutes] = React.useState<SubspaceBlackboardRoute[]>([]);
  const [messagesByRoute, setMessagesByRoute] = React.useState<Record<string, SubspaceBlackboardMessage[]>>({});
  const [selectedPeer, setSelectedPeer] = React.useState("");
  const [draftByRoute, setDraftByRoute] = React.useState<Record<string, string>>({});
  const [replyToByRoute, setReplyToByRoute] = React.useState<Record<string, string>>({});
  const [broadcastRouteIds, setBroadcastRouteIds] = React.useState<string[]>([]);
  const [broadcastDraft, setBroadcastDraft] = React.useState("");
  const [resourceByMessage, setResourceByMessage] = React.useState<Record<string, { loading: boolean; document?: SubspaceResourceDocument; error?: string }>>({});
  const [boardBusy, setBoardBusy] = React.useState(false);
  const [boardNotice, setBoardNotice] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const creds = React.useMemo(() => session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null,
    [session?.session_token, session?.end_user_id]);

  React.useEffect(() => {
    if (!creds) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDepartment(null);
    setDepartments([]);
    setProjects([]);
    setRoutes([]);
    setMessagesByRoute({});
    if (activeSpaceId !== params.spaceId) setActiveSpace(params.spaceId);
    Promise.all([
      listDepartments(params.spaceId, creds),
      listDepartmentProjects(params.spaceId, params.departmentId, creds),
      listSubspaceBlackboardRoutes(params.spaceId, params.departmentId, creds),
    ]).then(async ([departments, items, boardRoutes]) => {
      if (cancelled) return;
      const selected = departments.find((item) => item.id === params.departmentId && item.parent_id === params.spaceId);
      if (!selected) throw new Error("Subspace not found in this Space");
      setDepartment(selected);
      setDepartments(departments);
      setProjects(items);
      setRoutes(boardRoutes);
      setSelectedPeer((current) => current || departments.find((item) => item.id !== selected.id && item.parent_id === params.spaceId && item.status === "active")?.id || "");
      const routeMessages = await Promise.all(boardRoutes.map(async (route) => [
        route.route_id,
        await listSubspaceBlackboardMessages(params.spaceId, params.departmentId, route.route_id, creds),
      ] as const));
      if (cancelled) return;
      setMessagesByRoute(Object.fromEntries(routeMessages));
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Couldn't load this subspace");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [activeSpaceId, params.spaceId, params.departmentId, creds, setActiveSpace]);

  const refreshBlackboard = React.useCallback(async () => {
    if (!creds) return;
    const nextRoutes = await listSubspaceBlackboardRoutes(params.spaceId, params.departmentId, creds);
    const routeMessages = await Promise.all(nextRoutes.map(async (route) => [
      route.route_id,
      await listSubspaceBlackboardMessages(params.spaceId, params.departmentId, route.route_id, creds),
    ] as const));
    setRoutes(nextRoutes);
    setMessagesByRoute(Object.fromEntries(routeMessages));
  }, [creds, params.spaceId, params.departmentId]);

  const addBlackboardRoute = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!creds || !department || !selectedPeer) return;
    setBoardBusy(true);
    setBoardNotice(null);
    try {
      await createSubspaceBlackboardRoute(params.spaceId, {
        id: crypto.randomUUID(), sourceSubspaceId: department.id, targetSubspaceId: selectedPeer,
        allowedKinds: ["question", "blocker", "finding", "completion", "verification"], allowReply: true,
      }, creds);
      await refreshBlackboard();
      setBoardNotice("Sibling route is active.");
    } catch (reason) {
      setBoardNotice(reason instanceof Error ? reason.message : "Could not create the route.");
    } finally {
      setBoardBusy(false);
    }
  };

  const removeBlackboardRoute = async (routeId: string) => {
    if (!creds) return;
    setBoardBusy(true);
    setBoardNotice(null);
    try {
      await revokeSubspaceBlackboardRoute(params.spaceId, routeId, creds);
      await refreshBlackboard();
      setBoardNotice("Sibling route revoked. Its board messages are no longer visible.");
    } catch (reason) {
      setBoardNotice(reason instanceof Error ? reason.message : "Could not revoke the route.");
    } finally {
      setBoardBusy(false);
    }
  };

  const openBoardResource = async (route: SubspaceBlackboardRoute, message: SubspaceBlackboardMessage) => {
    if (!creds) return;
    setResourceByMessage((current) => ({ ...current, [message.id]: { loading: true } }));
    try {
      const document = await openSubspaceResource(params.spaceId, route.route_id, message.id, creds);
      setResourceByMessage((current) => ({ ...current, [message.id]: { loading: false, document } }));
    } catch {
      setResourceByMessage((current) => ({ ...current, [message.id]: { loading: false, error: "You don't have access to this document. Ask its owner to share it with your department." } }));
    }
  };

  const submitBoardMessage = async (event: React.FormEvent, route: SubspaceBlackboardRoute) => {
    event.preventDefault();
    if (!creds || !department) return;
    const text = (draftByRoute[route.route_id] ?? "").trim();
    if (!text) return;
    const replyTo = route.target_subspace_id === department.id ? replyToByRoute[route.route_id] : undefined;
    if (route.target_subspace_id === department.id && !replyTo) {
      setBoardNotice("Select a question or blocker before replying.");
      return;
    }
    setBoardBusy(true);
    setBoardNotice(null);
    try {
      await publishSubspaceBlackboardMessage(params.spaceId, department.id, {
        routeId: route.route_id, id: crypto.randomUUID(), kind: replyTo ? "completion" : "question", text, ...(replyTo ? { replyTo } : {}),
      }, creds);
      setDraftByRoute((current) => ({ ...current, [route.route_id]: "" }));
      setReplyToByRoute((current) => ({ ...current, [route.route_id]: "" }));
      const messages = await listSubspaceBlackboardMessages(params.spaceId, department.id, route.route_id, creds);
      setMessagesByRoute((current) => ({ ...current, [route.route_id]: messages }));
    } catch (reason) {
      setBoardNotice(reason instanceof Error ? reason.message : "Could not send the update.");
    } finally {
      setBoardBusy(false);
    }
  };

  const submitBroadcast = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!creds || !department) return;
    const text = broadcastDraft.trim();
    const selectedRoutes = routes.filter((route) => route.source_subspace_id === department.id && broadcastRouteIds.includes(route.route_id));
    if (selectedRoutes.length < 2 || selectedRoutes.length > 10 || !text) return;
    setBoardBusy(true);
    setBoardNotice(null);
    try {
      await publishSubspaceBlackboardBroadcast(params.spaceId, department.id, {
        id: crypto.randomUUID(), routeIds: selectedRoutes.map((route) => route.route_id), kind: "finding", text,
      }, creds);
      setBroadcastDraft("");
      const routeMessages = await Promise.all(selectedRoutes.map(async (route) => [
        route.route_id, await listSubspaceBlackboardMessages(params.spaceId, department.id, route.route_id, creds),
      ] as const));
      setMessagesByRoute((current) => ({ ...current, ...Object.fromEntries(routeMessages) }));
      setBoardNotice(`Update delivered to ${selectedRoutes.length} authorized sibling routes.`);
    } catch (reason) {
      setBoardNotice(reason instanceof Error ? reason.message : "Could not deliver the multi-recipient update.");
    } finally {
      setBoardBusy(false);
    }
  };

  if (loading) return <div className="page-view">Loading subspace…</div>;
  if (error || !department) return <main className="page-view"><h1>Subspace unavailable</h1><output>{error ?? "This subspace is unavailable."}</output></main>;

  return (
    <main className="page-view">
      <nav aria-label="Breadcrumb" style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--text3)", fontSize: 12, marginBottom: 16 }}>
        <Link href={`/p/${product.slug}/spaces/${params.spaceId}`} style={{ color: "var(--text2)" }}>Space</Link>
        <span aria-hidden="true">›</span>
        <span aria-current="page">{department.name}</span>
      </nav>
      <header className="page-header">
        <h1 className="page-title">{department.name}</h1>
        <p className="page-subtitle">Projects associated with this subspace</p>
      </header>
      {projects.length === 0 ? (
        <p style={{ color: "var(--text3)" }}>No projects are linked to this subspace yet.</p>
      ) : (
        <div className="grid-2">
          {projects.map((project) => (
            <Link key={project.id} href={`/p/${product.slug}/projects/${encodeURIComponent(project.id)}?departmentId=${encodeURIComponent(department.id)}`} className="card" style={{ textDecoration: "none" }}>
              <div className="card-title">{project.name}</div>
              {project.description && <div className="card-desc">{project.description}</div>}
            </Link>
          ))}
        </div>
      )}

      <section aria-labelledby="subspace-blackboard-title" style={{ marginTop: 32 }}>
        <header className="page-header">
          <h2 id="subspace-blackboard-title" className="page-title">Sibling coordination</h2>
          <p className="page-subtitle">Share a bounded update with a sibling subspace after an authorized route is active.</p>
        </header>

        {departments.some((item) => item.id !== department.id && item.parent_id === params.spaceId && item.status === "active") && (
          <form onSubmit={addBlackboardRoute} className="card" style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
            <label style={{ display: "grid", gap: 6 }}>
              Send from {department.name} to
              <select value={selectedPeer} onChange={(event) => setSelectedPeer(event.target.value)}>
                {departments.filter((item) => item.id !== department.id && item.parent_id === params.spaceId && item.status === "active").map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={boardBusy || !selectedPeer}>Enable route</button>
            <span style={{ color: "var(--text3)", fontSize: 12 }}>Requires management access to both subspaces.</span>
          </form>
        )}

        {boardNotice && <p role="status" style={{ color: "var(--text2)" }}>{boardNotice}</p>}
        {routes.filter((route) => route.source_subspace_id === department.id).length >= 2 && (
          <form onSubmit={(event) => void submitBroadcast(event)} className="card" style={{ display: "grid", gap: 10, marginBottom: 16 }}>
            <strong>Send one update to several siblings</strong>
            <fieldset style={{ display: "flex", gap: 12, flexWrap: "wrap", border: 0, padding: 0, margin: 0 }}>
              <legend style={{ marginBottom: 6 }}>Choose 2–10 active routes</legend>
              {routes.filter((route) => route.source_subspace_id === department.id).map((route) => (
                <label key={route.route_id} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" checked={broadcastRouteIds.includes(route.route_id)} disabled={boardBusy}
                    onChange={(event) => setBroadcastRouteIds((current) => event.target.checked
                      ? [...current, route.route_id].slice(0, 10) : current.filter((id) => id !== route.route_id))} />
                  {departments.find((item) => item.id === route.target_subspace_id)?.name ?? "Sibling"}
                </label>
              ))}
            </fieldset>
            <textarea maxLength={4000} rows={3} value={broadcastDraft} onChange={(event) => setBroadcastDraft(event.target.value)}
              aria-label="Multi-recipient finding" placeholder="Share a bounded finding with each selected sibling" />
            <button type="submit" disabled={boardBusy || broadcastRouteIds.length < 2 || broadcastRouteIds.length > 10 || !broadcastDraft.trim()}>
              Send to {broadcastRouteIds.length} siblings
            </button>
            <span style={{ color: "var(--text3)", fontSize: 12 }}>All routes are checked before delivery. Each sibling sees only its own copy.</span>
          </form>
        )}
        {routes.length === 0 ? (
          <p style={{ color: "var(--text3)" }}>No active sibling routes are visible to this subspace.</p>
        ) : (
          <div style={{ display: "grid", gap: 16 }}>
            {routes.map((route) => {
              const source = departments.find((item) => item.id === route.source_subspace_id)?.name ?? "Sibling";
              const target = departments.find((item) => item.id === route.target_subspace_id)?.name ?? "Sibling";
              const isSource = route.source_subspace_id === department.id;
              const messages = messagesByRoute[route.route_id] ?? [];
              const repliedTo = new Set(messages.flatMap((message) => message.replyTo ? [message.replyTo] : []));
              return (
                <article key={route.route_id} className="card">
                  <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <strong>{source} → {target}</strong>
                    {route.can_manage && <button type="button" disabled={boardBusy} onClick={() => void removeBlackboardRoute(route.route_id)}>Revoke route</button>}
                  </header>
                  {messages.length === 0 ? <p style={{ color: "var(--text3)" }}>No updates on this route.</p> : (
                    <ol style={{ display: "grid", gap: 10, paddingLeft: 20 }}>
                      {messages.map((message) => (
                        <li key={message.id}>
                          <div style={{ color: "var(--text3)", fontSize: 12 }}>{message.kind} · {message.senderSubspaceId === route.source_subspace_id ? source : target} · {new Date(message.createdAt).toLocaleString()}</div>
                          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.text}</div>
                          {message.resource_ref && (message.senderSubspaceId === department.id ? (
                            <div style={{ color: "var(--text3)", fontSize: 12, marginTop: 6 }}>Linked document</div>
                          ) : (
                            <div style={{ marginTop: 6 }}>
                              <button type="button" disabled={resourceByMessage[message.id]?.loading} onClick={() => void openBoardResource(route, message)}>Open document</button>
                              {resourceByMessage[message.id]?.error && <p style={{ color: "var(--text2)", margin: "6px 0 0" }}>{resourceByMessage[message.id]?.error}</p>}
                              {resourceByMessage[message.id]?.document && (
                                <section aria-label="Linked document" className="card" style={{ marginTop: 8 }}>
                                  <strong>{resourceByMessage[message.id]?.document?.title}</strong>
                                  <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "8px 0 0" }}>{resourceByMessage[message.id]?.document?.content}</pre>
                                </section>
                              )}
                            </div>
                          ))}
                          {route.allow_reply && !isSource && ["question", "blocker"].includes(message.kind) && !repliedTo.has(message.id) && (
                            <button type="button" style={{ marginTop: 6 }} onClick={() => setReplyToByRoute((current) => ({ ...current, [route.route_id]: message.id }))}>Reply</button>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                  {(isSource || replyToByRoute[route.route_id]) && (
                    <form onSubmit={(event) => void submitBoardMessage(event, route)} style={{ display: "grid", gap: 8, marginTop: 12 }}>
                      {replyToByRoute[route.route_id] && <p style={{ color: "var(--text2)", margin: 0 }}>Replying to {replyToByRoute[route.route_id]}</p>}
                      <textarea maxLength={4000} rows={3} value={draftByRoute[route.route_id] ?? ""}
                        onChange={(event) => setDraftByRoute((current) => ({ ...current, [route.route_id]: event.target.value }))}
                        aria-label={replyToByRoute[route.route_id] ? "Reply text" : "Question for sibling subspace"}
                        placeholder={replyToByRoute[route.route_id] ? "Write a bounded reply" : "Ask a question or share a finding"} />
                      <div style={{ display: "flex", gap: 8 }}>
                        <button type="submit" disabled={boardBusy || !(draftByRoute[route.route_id] ?? "").trim()}>{replyToByRoute[route.route_id] ? "Send reply" : "Send update"}</button>
                        {replyToByRoute[route.route_id] && <button type="button" onClick={() => setReplyToByRoute((current) => ({ ...current, [route.route_id]: "" }))}>Cancel reply</button>}
                      </div>
                    </form>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
