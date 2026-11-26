# AgentMail inventory listing — documentation evidence (2026-11-26)

Read from public docs (not verified live):
- https://agentmail.to/docs/api-reference/inboxes/list.md
- https://agentmail.to/docs/api-reference/pods/list.md
- https://agentmail.to/docs/api-reference/pods/inboxes/list.md
- https://agentmail.to/docs/documentation/core-concepts/pods.md

Findings:
- `GET /v0/inboxes` lists all inboxes in the organization. Query: `limit`, `page_token`, `ascending`.
  Response: `count` (items in this page), `inboxes` (newest first), `limit`, `next_page_token` (absent on last page).
- `GET /v0/pods` and `GET /v0/pods/{pod_id}/inboxes` have the same pagination shape.
- Inbox fields: `inbox_id`, `pod_id`, `email`, `created_at`, `updated_at`, optional `client_id`,
  `display_name`, `status` (`active` | `deactivated`, omitted when active), `deactivate_at`, `metadata`.
- Servers: `https://api.agentmail.to` (default) and `https://api.agentmail.eu` (EU). How accounts map to the EU host is not documented.
- Max `limit` and default page size are not documented; `page_token` is treated as opaque.

Implementation guidance for MS-50: use the org-level `GET /v0/inboxes` with the platform key per host in use,
follow `next_page_token` until absent, use a conservative `limit` (e.g. 100) and a page cap per sweep; treat a
missing `status` as active; never delete. Run the sweep per configured host only.
