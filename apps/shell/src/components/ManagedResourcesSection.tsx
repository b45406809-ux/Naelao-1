"use client";

import * as React from "react";
import { assistantMailApi, type SessionCredentials } from "@/lib/api";
import { parseManagedResources, resourceModeLabel, resourceTitle, type ManagedResource } from "@/lib/managed-resources";

/** MS-42: provider-agnostic Resources list. Renders nothing while the server flag is off (404) or on any error. List only: no suspend or export yet. */
export function ManagedResourcesSection({ spaceId, session }: { spaceId: string; session: SessionCredentials }) {
  const [resources, setResources] = React.useState<ManagedResource[] | null>(null);
  React.useEffect(() => {
    let current = true;
    assistantMailApi<unknown>(spaceId, session, { action: "managed-resources" })
      .then((result) => { if (current) setResources(parseManagedResources(result)); })
      .catch(() => { if (current) setResources(null); });
    return () => { current = false; };
  }, [spaceId, session]);
  if (resources === null) return null;
  const date = (value: string) => new Date(value).toLocaleDateString();
  return (
    <div className="settings-block" data-testid="managed-resources">
      <div className="settings-row-label">Resources</div>
      <p className="settings-row-sub">Everything this Space uses from a provider, whether Naelao manages it or you brought your own account.</p>
      {resources.length === 0 ? <p className="settings-row-sub">No resources yet.</p> : (
        <ul style={{ display: "grid", gap: 8, listStyle: "none", padding: 0 }}>
          {resources.map((resource) => (
            <li key={resource.id} className="settings-row-sub">
              <strong>{resourceTitle(resource)}</strong> — {resourceModeLabel(resource.mode)}, {resource.status.replaceAll("_", " ")}
              {resource.region ? `, ${resource.region.toUpperCase()}` : ""}
              <div>Agents: {resource.assignedAgents.length ? resource.assignedAgents.join(", ") : "none assigned"}</div>
              <div>Usage this period: {resource.usage.operations} operations, {resource.usage.settledCredits} credits settled
                {resource.usage.heldCredits ? `, ${resource.usage.heldCredits} held` : ""}</div>
              {resource.price && <div>Price: {resource.price.credits} credits per month</div>}
              {resource.renewal && <div>{resource.renewal.cancelAtPeriodEnd ? "Ends" : "Renews"} {date(resource.renewal.currentPeriodEnd)}
                {resource.renewal.state !== "active" ? ` (${resource.renewal.state})` : ""}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
