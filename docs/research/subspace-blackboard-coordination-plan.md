# Subspace Blackboard Coordination

## Outcome

A subspace can coordinate directly with authorized sibling subspaces under the same parent Space.
Each subspace has its own blackboard view for sending updates, receiving handoffs, and replying.
The parent Space supplies the common scope and the routing rules. Its assistant can help set up or
monitor authorized routes, while routine messages go directly from the sending subspace to the
receiving subspace's board.

A handoff can go to one approved sibling or to several approved siblings. Each sees only the
entries and fields it can read. Siblings can share a parent without sharing any coordination data.
A shared service subspace can also offer specific playbooks or operations through separate grants.

## Existing foundations

- Naelao has SpaceDO logical subspaces with their own membership checks and assistant identities.
  It also has parent-linked Space records for supported creation paths. Resolve the participants
  and their common parent from the authoritative hierarchy for the actual product entry point.
  Audit both representations and use the existing identity path. The first version coordinates
  immediate siblings under one parent. Follow the current supported hierarchy depth.
  See [Product, Space and subspace](../product-space-subspace.md) and
  [Space creation](../../workers/spaces/src/create-space.ts).
- The existing task blackboard has typed messages, explicit directed recipient grants, bounded
  updates, authenticated sender identity, replies and retry keys. Its current authority is tied to
  an individual goal and worker identities. Reuse those messaging patterns where they fit, with
  sibling routes and durable subspace identities governing the new scope.
  See [task blackboard](../../workers/agents/src/script-engine/task-blackboard.ts) and
  [Agent DO entry point](../../workers/agents/src/do/NaelaoAgentDO.ts).
- Follow the existing ownership and disclosure rules for project privacy and template activation.
  Use this plan for sibling coordination and the linked plans for task coordination, member roles
  and project access. See [adaptive planner and worker coordination](adaptive-planner-worker-swarm-memory-plan.md)
  and [template business roles](template-business-roles-and-member-onboarding-plan.md).

## How siblings coordinate

| Case | What each board shows |
| --- | --- |
| Sales hands work off to Delivery | Sales posts an approved brief to Delivery. The message appears on Sales's board as sent and on Delivery's board as received. |
| Delivery replies | Delivery publishes a completion reference linked to that handoff. Sales sees it through the approved reply route. |
| Finance needs the completion reference | Delivery sends Finance the reference and permitted billing fields. Finance can open underlying records only through its own resource grants. |
| Several siblings need an update | The sender targets a bounded, authorized recipient set. Each recipient sees its permitted fields and only the audience information it may discover. |
| Private subspaces share a parent | With no routes between them, the boards reveal no entry, sender, recipient, or activity from the other subspace. |

Start with handoff, question, blocker, status and completion messages. Each route declares supported
message types, the fields allowed to leave the source, and eligible senders and readers. A reply
points at an entry the sender may see and follows an authorized route in the reverse direction.
A handoff grants only the ability to send its allowed information. If it references a project,
artifact, service or playbook, the recipient needs the corresponding resource grant to open or
use it. Put sensitive data behind scoped references when the receiver needs it.

Use one durable message identity and an authorized sent/received view for each subspace. The
underlying storage can share parent infrastructure where it fits the current SpaceDO layout.
The product surface is each subspace's own board. A parent-wide operational view, if enabled,
contains only entries separately permitted for the viewing principal.

## Who defines routes

- **Template builder.** Declare named, symbolic subspace roles, expected handoffs, allowed message
  types and fields, and optional resource links. Support layouts with private user subspaces,
  shared service subspaces, or a mix. Template installation resolves symbolic roles to actual
  subspaces and presents the proposed routes for approval. Template declarations carry no grants.
- **Parent owner or authorized administrator.** Approve actual source and destination subspaces,
  message types and fields, allowed senders and readers, reply direction, and any optional
  notification or assistant wake. Where the current privacy policy requires consent from a source
  or destination scope, obtain it before activating the route. The ability to configure a route
  alone does not confer the ability to disclose an underlying private record.
- **Space and subspace assistants.** Propose routes and publish or read through the authority
  already granted to their actual principal. A parent assistant can apply configuration only
  where it has the same explicit administration right as another caller. It cannot grant itself
  data access, approve consent for a member, or act as a required relay for sibling traffic.

Keep sharing off until a route is active. Membership, a shared parent, naming a subspace in a
message, or receiving a handoff confers no access to another subspace. Changing membership, routes
or resource grants should take effect in boards, assistant context and notifications through the
same authority checks.

## Delivery and privacy contract

Derive tenant, parent, sender and destination from current server-side identities. At publish,
read, list, reply, notification and wake, verify the relevant membership or agent delegation,
current route revision, message type, audience and field restrictions. Revalidate queued work
at delivery and keep non-siblings and cross-tenant targets out of route resolution. Where a
participant can no longer see an entry, exclude it from search, counts, activity summaries and
notifications as well. Use nondisclosing errors for unavailable or private destinations.

Use stable retry keys within the source scope. Identical retries return the existing accepted
message; reuse with a changed payload or destination is refused. Validate all selected routes
before accepting a multi-recipient message. Track recipients individually if durable delivery
can be interrupted. Use bounded message sizes, recipients and read windows. Record route revision,
sender, authorized recipients, message type, and delivery state under the existing audit policy.
Treat message text and references as untrusted inputs. Receiving one does not grant permission
to execute a tool or start a billable run.

On route revocation or participant removal, fence new sends and queued delivery, recheck reads,
and invalidate cached views and unread counts. Apply current retention and reassignment policy
to already delivered content. An optional notification or assistant wake is a separate effect
with current authorization, deduplication and budget checks. Start with boards users and agents
can read on demand.

## Queued implementation

- [ ] **Audit entry points and define the scope.** Trace logical subspace membership, parent-linked
  Space identity, assistant routing, and existing blackboard recipients from host entry to store.
  Record the authoritative immediate-sibling check and the exact permission path for private
  subspaces. Select a supported pair of sibling subspaces for the first fixture.
- [ ] **Implement one directed route.** Add a host-owned grant and a typed handoff with a visible
  entry on each participant's board. Support a separately permitted linked reply. Verify that
  transport does not require the parent assistant.
- [ ] **Add owner, assistant and template configuration.** Resolve template role bindings to real
  participants, present proposed routes for approval, and expose configuration and revocation
  through authorized UI and assistant actions. Add bounded multi-recipient updates and exposed
  resource links where supported.
- [ ] **Verify end-to-end behavior.** Cover the Sales-to-Delivery handoff and completion reply,
  optional Finance update, a shared playbook that stays separately scoped, private siblings,
  non-siblings, cross-tenant identities, wrong roles, forbidden fields, ambiguous IDs, duplicate
  delivery, incomplete fan-out and revocation during a queued handoff. Verify that parent and
  recipient views, metadata, and derived counts obey the same permissions. Record production
  acceptance separately from local and staging results.
