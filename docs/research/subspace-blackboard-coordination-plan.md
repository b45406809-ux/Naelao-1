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

- [x] **Audit entry points and define the scope.** Trace logical subspace membership, parent-linked
  Space identity, assistant routing, and existing blackboard recipients from host entry to store.
  Record the authoritative immediate-sibling check and the exact permission path for private
  subspaces. Select a supported pair of sibling subspaces for the first fixture.
- [x] **Implement one directed route.** Add a host-owned grant and a typed handoff with a visible
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

## SBB01 source audit — 2026-11-25

The selected runtime model is the **logical department hierarchy inside one parent SpaceDO**.
`docs/product-space-subspace.md` says a Space owns projects and may contain logical subspaces in
its SpaceDO; this is distinct from a D1 Space row's `parent_space_id`, which is used by supported
root/child Space creation paths. Do not infer blackboard siblings from a D1 parent link alone.

The authoritative immediate-sibling predicate for the selected entry point is: resolve both
participant rows from the same parent SpaceDO; require the parent row to be active, depth 0 and
rooted (`parent_id IS NULL`); require each participant to be a distinct active depth-1 row whose
`parent_id` equals that root. Derive tenant and parent from the authenticated server route and
DO binding; never accept a sender, recipient, or parent identity from message content.

The existing member path is `GET /spaces/:spaceId/sub-spaces/:subId/members` in
`workers/spaces/src/index.ts`: it resolves the actor, uses the parent SpaceDO, and calls
`authorizeDepartmentMember(..., "read")`, which asks `/hierarchy-authorize` for the target. The
SpaceDO grants direct target membership; for a department it also grants a direct parent owner or
admin. It does not inherit a sibling's membership. Management uses the same authoritative check
with `action=manage`. Existing `cross_space_grants` are resource-scoped and are not a blackboard
grant. The private Project checks remain separate and must still run when a message links to a
Project or artifact.

`space_assistants` binds exactly `assistant:space:<id>` to each hierarchy row; a root assistant is
a `DIRECTOR`, and a department assistant is a `DEPARTMENT_LEAD` with the parent assistant ID.
Agent dispatch is addressed to a server-selected `(tenant, space, agent)`; no reachable sibling
blackboard router or assistant relay was found. The parent assistant therefore need not relay a
message. The task blackboard is a useful pattern for typed bounded messages, signed worker
identity, explicit directed grants, idempotency and current actor access, but its current scope is
one goal/DAG (`tenant`, `Space`, optional Project, root run, parent Agent DO), not departments.

**Supported fixture pair:** the existing
`workers/spaces/src/do/project-subspace-migration-preflight.test.ts` fixture creates `dept-a`
(Sales) and `dept-b` (Research) as active depth-1 children of `root`; it also creates `other-dept`
under `other-root` as a non-sibling control. These stable fixture IDs will be used for the first
directed-route tests. Source audit found no ambiguity in the selected logical-department path.
Any separate D1 child-Space journey remains outside this first route until an entry point maps it
to the same authoritative parent SpaceDO hierarchy.

**Next implementation action:** define the parent-owned route/message tables and the host API
that revalidates both child memberships and active sibling relationship at configuration,
publish, read and reply. Start with one explicit directed grant for `dept-a` → `dept-b`; keep
sharing off until the grant is active.

**SBB02 verified checkpoint:** SpaceDO migration 159 adds parent-owned directed route and message
records. The Spaces Worker derives actor and parent identities from authenticated routing, checks
management/read access, and forwards only an allowlisted message shape. SpaceDO revalidates active
immediate siblings and current roles at grant, publish, read and revoke. Messages are limited to
4,000 characters; one directed reply is permitted only to an earlier source question/blocker; a
route accepts at most 500 entries and board reads return at most 100. Stable IDs return the prior
route/message for identical retries and reject changed payload reuse. Revoked routes stop reads.
The route and board APIs operate through Spaces/SpaceDO; they do not depend on parent-assistant
relay. The focused helper, DO and worker-route suites pass **8/8**, Spaces typecheck and
`git diff --check` pass. Evidence is local only; no deployment or live acceptance ran.

**Next task:** add owner/assistant/template route configuration and scoped handoff integration;
the direct route remains opt-in and no route is created by default.

**SBB03.1 verified checkpoint:** Active routes are discoverable only from a subspace board after
current membership is checked. The department page exposes explicit route creation and revocation
for users who can manage both siblings, with source-board questions, target-board linked replies,
and messages visible on each permitted board. `can_manage` is derived by SpaceDO; the page does not
infer authorization. Sharing remains opt-in. Focused Spaces tests pass **9/9**, Router
product-session path tests pass **92/92**, Shell typecheck and `git diff --check` pass. Local only;
no deployment or live acceptance ran.

**SBB03.2 verified checkpoint:** The `subspace-blackboard` prebuilt exposes only bounded read and
publish operations. It sends the host runtime's agent ID over a tenant-HMAC-signed internal Spaces
call. SpaceDO checks that actor against the current immutable assistant row for the exact active
logical subspace, then rechecks the active sibling route on every operation. Assistant identities
cannot create or revoke routes; those controls remain on the human owner/admin path. The focused
SpaceDO and worker route suites pass **7/7**, prebuilt operations tests pass **3/3**, Spaces and
Agents typechecks and `git diff --check` pass. Local only; no deployment or live acceptance ran.

**Next implementation action:** inspect signed blueprint declarations, activation and review flows.
Resolve only unambiguous symbolic department roles to current logical subspace IDs, stage proposed
routes inactive, and require an explicit owner approval before creating an active route.
