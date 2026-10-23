# Task-scoped email replies

Naelao can issue an opaque, expiring Reply-To address for the active agent run. Replies delivered to that address go through the Agents Worker's Cloudflare Email Routing `email()` handler, are attached to the initiating task in the routed agent's email inbox, and wake that agent. It can also provision a stable inbound alias for a Space assistant and distinct aliases for project assistants. Project mailbox rows carry their project ID so inbound mail is dispatched into the matching project context. These features are disabled until an operator configures an ingress domain.

This uses Cloudflare **Email Routing**, which delivers inbound mail to a Worker, separately from Cloudflare **Email Service**, which sends outbound mail. See [Email Workers](https://developers.cloudflare.com/email-routing/email-workers/) and [Email Routing](https://developers.cloudflare.com/email-routing/).

## Operator setup

1. Own a domain or subdomain managed by Cloudflare and enable Email Routing for it. Configure a catch-all route (or the required wildcard route) whose destination action is the `naelao-agents` Worker. The Worker entry point exports the `email(message, env)` handler.
2. Set the `EMAIL_INGRESS_DOMAIN` GitHub Actions environment variable in both the `staging` and `production` GitHub Environments to the exact receiving domain. The deployment workflows pass that value into the Agents Worker. Leave it unset until the matching Email Routing Worker action is active; an address derived by Naelao does not prove that Cloudflare accepted the route configuration. An unset variable keeps the feature disabled.
3. Apply the D1 migrations that create `email_reply_routes`, `email_inbound_attachments`, `agent_email_addresses`, and `project_agent_email_addresses` before enabling the Worker route. The deployment workflows apply and check the project-scoped table before deploying the Agents Worker.
4. Configure outbound delivery through the Notifications Worker with a verified sender domain. `email.send` accepts a `reply_to` address only when it was created for the current task run. It uses the Resend Notifications path for this case because the existing AgentMail send contract does not document Reply-To support.

Provisioning also requires the Agents Worker to have its existing D1 (`PLATFORM_DB`), R2 (`SCRIPTS_R2`) and Durable Object bindings. Email Routing DNS, account configuration, and a live provider send are deployment setup and cannot be proven by local tests.

## Safety and lifecycle

- `email.reply_address` derives a stable opaque local part from the platform secret and the tenant, Space and run IDs. The database stores only its SHA-256 address digest and the scoped route. Addresses expire after 30 days; a Space can have at most 100 active routes.
- The route lookup supplies the destination tenant, Space, worker and task; incoming mail cannot select those identities. Unknown, expired or malformed email is rejected.
- MIME parsing is bounded to 20 MiB per message, 10 attachments, 5 MiB per attachment and 15 MiB total attachment content. Attachments are written under a task-specific R2 prefix and referenced from the inbound email text. During that same task, `email.attachment.read_text` can read a D1-verified attachment if it is UTF-8 plain text, CSV, Markdown, JSON or XML up to 64 KiB, or a PDF up to 1 MiB. PDF extraction is limited to 10 pages and 64 KiB of extracted text; encrypted, malformed and over-limit PDFs are rejected. HTML and all other binary/archive formats remain unsupported. Extracted content includes the original R2 key and is labeled untrusted. Parsing is local to the Worker and does not fetch links or upload the attachment to an OCR service. The Worker platform's CPU budget remains the hard execution limit; account plan settings determine the available budget.
- Attachment objects and route rows are removed by the existing five-minute Agents retention sweep after 30 days. Email content is untrusted input and receives the normal inbound-channel handling; no automated payment or other privileged action is authorized by receiving it.
- Customer-owned domains need their own Cloudflare Email Routing configuration and are not provisioned automatically. The current release accepts one operator-configured platform ingress domain.
- A project assistant with no configured ingress domain is rejected rather than being given the Space assistant's shared AgentMail inbox or a send-only address. Configure the ingress domain before provisioning project email.

Local tests cover stable address derivation, MIME parsing, attachment bounds/filename handling, Reply-To ownership checks, task-scoped attachment lookup and real PDF parsing (including encrypted, malformed and over-limit input). They do not test live DNS, Email Routing delivery, the customer domain path or external deliverability.
