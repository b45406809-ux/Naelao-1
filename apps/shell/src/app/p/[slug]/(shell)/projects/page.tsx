"use client";


// /projects (bare, no id) is no longer a list — it lands you straight in the space's default
// "General" project, the way opening a folder takes you into it rather than showing you every
// folder that exists first. The full list (and "New project") moved to /projects/all, reachable
// from inside General's own header.
//
// Every space provisioned after this shipped gets a real General project seeded automatically
// (see seedGeneralProject in workers/agents/src/launchpad/bootstrap.ts) — but an older space,
// or one whose seed genuinely failed, might not have one yet. Falling back to the list in that
// case (rather than a dead end) is what makes this safe to ship without a data migration.

import * as React from "react";
import { useRouter } from "next/navigation";
import { useProduct } from "@/lib/product-context";
import { useSessionCredentials } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import { listProjects } from "@/lib/api";

const GENERAL_PROJECT_NAME = "General";

export default function ProjectsRootPage() {
  const product = useProduct();
  const { activeSpaceId } = useActiveSpace();
  const creds = useSessionCredentials();
  const router = useRouter();

  React.useEffect(() => {
    if (!creds) return;
    listProjects(activeSpaceId, creds)
      .then((projects) => {
        const general = projects.find((p) => p.name === GENERAL_PROJECT_NAME);
        router.replace(`/p/${product.slug}/projects/${general ? general.id : "all"}`);
      })
      .catch(() => router.replace(`/p/${product.slug}/projects/all`));
  }, [activeSpaceId, creds, product.slug, router]);

  return (
    <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span style={{ color: "var(--text3)", fontSize: 13 }}>Loading…</span>
    </div>
  );
}
