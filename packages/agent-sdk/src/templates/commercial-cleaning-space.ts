import type { SpaceBlueprint } from "../types.js";

/**
 * Private, simulation-only reference Blueprint for a commercial cleaning walkthrough. Its starter
 * files are fictional records; they are not connected to an operating company, crew or client.
 */
export const COMMERCIAL_CLEANING_OPERATIONS_SPACE_TEMPLATE: SpaceBlueprint = {
  id: "tpl_commercial_cleaning_operations_demo_v1",
  schemaVersion: "2.0",
  templateCategory: "operations",
  metadata: {
    name: "Commercial Cleaning Operations Demo",
    description: "A fictional office shift walkthrough from blocked work to a reviewed client update.",
    publisher: "naelao",
    templateVersion: "1.0.0",
    dogfood: true,
    demoMode: "simulation_only",
  },
  requiredExtensions: [],
  requiredCredentials: [],
  projects: [
    {
      id: "service-delivery-quality-demo",
      name: "Service Delivery and Quality Demo",
      kind: "DualPane",
      templateMode: "cowork_studio",
      viewports: { primary: "assistant", secondary: "canvas" },
      systemPrompt: [
        "This is a simulation-only commercial cleaning demonstration. Use only the fictional fixture files in this Project and cite their record IDs.",
        "Distinguish scheduled, acknowledged, completed, partial, blocked, inspected and verified. A proposed corrective action or client update is not a committed change.",
        "Do not claim that a shift, correction, client message, purchase or other action happened outside these fixtures. This Blueprint has no live connections, credentials, write operations or notification routes.",
        "Do not invent site details, staff assignments, contract scope, safety procedures, chemical advice, or client commitments. If the fixtures lack the answer, say what is missing.",
        "Treat access, product-label or safety concerns as requiring the employer's approved procedure and an identified human contact. No such procedure or contact is configured in this demo.",
      ].join("\n"),
      initialTasks: [
        { id: "inspect-fixtures", title: "Inspect the fictional site, scope and scheduled visit", status: "pending" },
        { id: "triage-blocked-work", title: "Trace the blocked task to the inspection exception", status: "pending", dependencies: ["inspect-fixtures"] },
        { id: "prepare-review", title: "Prepare a corrective-action and client-update review packet", status: "pending", dependencies: ["triage-blocked-work"] },
        { id: "record-demo-outcome", title: "Record only a simulated review outcome", status: "pending", dependencies: ["prepare-review"] },
      ],
      starterFiles: [
        {
          path: "README.md",
          content: "# Commercial cleaning operations demo\n\nAll records in `fixtures/` are fictional and marked `simulation_only`. Follow one scheduled office visit, an unfinished task, an inspection exception and a proposed review packet. Nothing here is connected to a customer, crew, provider or live operational system.\n",
        },
        {
          path: "fixtures/site.json",
          content: JSON.stringify({
            fixture_mode: "simulation_only",
            site_id: "SITE-DEMO-01",
            display_name: "Fictional Office North",
            client_id: "CLIENT-DEMO-01",
            timezone: "America/Chicago",
            service_window: { starts_local: "21:00", ends_local: "01:00" },
            access_instructions: null,
          }, null, 2) + "\n",
        },
        {
          path: "fixtures/approved-scope.json",
          content: JSON.stringify({
            fixture_mode: "simulation_only",
            site_id: "SITE-DEMO-01",
            scope_id: "SCOPE-DEMO-01",
            revision: 3,
            effective_for_demo_visit: true,
            areas: [
              { area_id: "AREA-DEMO-RESTROOM", name: "Restroom", tasks: [
                { task_id: "TASK-DEMO-SOAP", description: "Check and replenish the soap dispenser using the site's approved supply", frequency: "each visit" },
                { task_id: "TASK-DEMO-SURFACES", description: "Clean the listed high-touch surfaces", frequency: "each visit" },
              ] },
            ],
          }, null, 2) + "\n",
        },
        {
          path: "fixtures/visit.json",
          content: JSON.stringify({
            fixture_mode: "simulation_only",
            visit_id: "VISIT-DEMO-2026-02-02",
            site_id: "SITE-DEMO-01",
            scope_id: "SCOPE-DEMO-01",
            scope_revision: 3,
            service_date: "2026-02-02",
            assigned_crew_id: "CREW-DEMO-01",
            status: "acknowledged",
            task_outcomes: [
              { task_id: "TASK-DEMO-SOAP", status: "blocked", reason: "Approved supply was not available in the demo stock area" },
              { task_id: "TASK-DEMO-SURFACES", status: "completed", evidence_id: "EVIDENCE-DEMO-01" },
            ],
          }, null, 2) + "\n",
        },
        {
          path: "fixtures/inspection.json",
          content: JSON.stringify({
            fixture_mode: "simulation_only",
            inspection_id: "INSPECTION-DEMO-01",
            visit_id: "VISIT-DEMO-2026-02-02",
            result: "needs_review",
            findings: [
              { finding_id: "FINDING-DEMO-01", task_id: "TASK-DEMO-SOAP", status: "not_verified", note: "The fixture reports a blocked task; no replenishment evidence is recorded." },
            ],
          }, null, 2) + "\n",
        },
        {
          path: "fixtures/exception.json",
          content: JSON.stringify({
            fixture_mode: "simulation_only",
            exception_id: "EXCEPTION-DEMO-01",
            site_id: "SITE-DEMO-01",
            visit_id: "VISIT-DEMO-2026-02-02",
            source_finding_id: "FINDING-DEMO-01",
            status: "open_for_supervisor_review",
            proposed_next_step: "Confirm approved supply availability and schedule a follow-up if needed.",
            approved_action: null,
            client_update_status: "draft_not_sent",
          }, null, 2) + "\n",
        },
        {
          path: "WORKFLOW.md",
          content: "# Fictional shift exception walkthrough\n\n1. Read the site, scope revision and acknowledged visit fixtures.\n2. Link the blocked task to the inspection finding and open exception using their IDs.\n3. Separate recorded evidence from assumptions and missing information.\n4. Draft a corrective-action proposal for a supervisor to review. Do not mark work complete or verified.\n5. Prepare a client update draft from the recorded facts only. It remains unsent.\n6. If a reviewer decision is supplied for the simulation, record it in a copied fixture and label the result simulated.\n\nThis template does not create visits, assign crews, change scopes, send messages or perform purchases.\n",
        },
        {
          path: "review/client-update-packet.md",
          content: "# Proposed client update — simulation only\n\n- Site: `SITE-DEMO-01` (fictional)\n- Visit: `VISIT-DEMO-2026-02-02` (fictional)\n- Exception: `EXCEPTION-DEMO-01` (fictional)\n- Recorded status: the soap dispenser task is blocked; the inspection does not verify replenishment.\n- Proposed next step: a supervisor checks approved supply availability and decides whether a follow-up is needed.\n- Approval: not recorded\n- Delivery: not sent\n- Verified resolution: none in this fixture\n\nDo not turn this packet into a real client promise. The demonstration has no client connection or delivery route.\n",
        },
      ],
      configuration: {
        presentation_profile: "guided",
        reference_template: true,
        simulation_only: true,
        external_actions_enabled: false,
      },
      roles: [],
      capabilities: [],
      executionTier: 1,
    },
  ],
};
