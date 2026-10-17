# Trading mentor composed project extension

This example shows how one versioned extension can ship related project UI, project data, an external student channel, and an internal durable worker without changing the planner or execution topology.

## How the parts belong together

`manifest.json` is the shared identity and release boundary. Every primitive has a stable ID and the same bundle version. `workerRoles` binds `order_worker` to the `place_order` workflow primitive and its entry file, and declares `project_member` as the principal. Its `toolNames` includes the broker operation and the explicit `extension.gadget.insert` grant. The worker can persist its completed order into the `trade_journal` Gadget through `ctx.gadgets.insert`; the host verifies that both parts belong to the same active installation and project. The WhatsApp channel references its own handler artifact and published Knowledge collection under a separate `channel_only` external context and receives no Gadget API. The Canvas and Gadget are project scoped. The host hashes and installs the declared artifacts as one immutable release. Multiple installed Canvas parts are selectable from the project Canvas selector, and the selected resource is kept in the URL.

The public channel handler receives only its restricted channel context. It cannot use the internal workflow tools, read project membership, or see member conversations. The member side remains the normal project planner. When a member asks to place an order, the planner may discover the installed workflow and delegate it with `workflow.run`; the Durable Workflow worker executes under the requesting member and active project. The worker is not another planner and does not inherit chat history.

The workflow start key is idempotent within the exact installed extension instance and workflow ID. Installing two named instances of the same extension creates separate instance IDs; they can run independent sessions and effects. Workflow run IDs and host grants include actor, project, installation and definition scope. Reusing a request key in one bot will not collapse a run in another bot.

## Install and use

1. Create a generic project. Publish only approved indexed files in the project Knowledge collection `course_material`.
2. An owner or admin installs this manifest and the three declared source artifacts through the project extension installer, choosing an instance key when they need a second copy.
3. Connect the WhatsApp provider through the host-managed connection flow. Provider transport and credentials stay in the host.
4. A project member uses the regular planner to ask for an action. The planner can inspect `workflow.extensions`, then delegate `place_order` with `workflow.run`, passing the exact `installation_id`, `extension_id`, workflow ID, parameters and a stable `start_key`.
5. The worker requires explicit confirmation and bounded order parameters. Its `orders.place` effect still has to be available and authorized by the host's current operation surface. The manifest's `toolNames` documents/reviews the intended operation; it does not grant that operation by itself. The owner also reviews the `extension.gadget.insert` grant, which enables the worker to write its accepted order to this extension's Gadget after rechecking the active project installation.

The included order operation is an integration example, not a broker connection or a claim that `orders.place` is implemented in every deployment. A deployment must provide the operation with its own authorization, idempotency, audit and settlement rules before this worker can place a real order. The trade journal is an isolated project Gadget database, and its insert API is not exposed to the public student handler.

The external handler answers only from `course_material` after the owner publishes it. Its bounded channel session state is separate from project Knowledge and internal workflow state.

## Current product boundary

The bundle-to-role relationship, project install, Canvas/Gadget mounts, public channel handler, and Durable Workflow execution are implemented. The existing planner topology and workspace execution tiers are unchanged.

Several broader product parts remain open: end-user OAuth consent and per-user credential references, external channel identity/session routing across multiple bot instances, an end-to-end workflow composition editor, Gadget actions from Canvas and Gadget update/delete operations, publisher identity signatures, and provider-independent inbox reply/assignment. Provider OAuth must be completed in host-owned credential services; extension artifacts must never receive raw provider secrets. These items are tracked in `new plan/FDE-EXTENSIONS-AND-MICROAPPS-ARCHITECTURE.md` and `new plan/CONTINUATION-IMPLEMENTATION-PROGRESS.md`.
