# Trading mentor student channel starter

This is a real starter for the current **channel-only** package installer. It is not a special project kind and does not install a Canvas, Gadget, planner worker, or member tool.

1. Create a generic project for the mentor.
2. In the project Knowledge page, publish only approved indexed files in a collection whose stable ID is `course_material`.
3. In Channels, install `manifest.json` and paste `student-answer.ts` into the handler source map under `./student-answer.ts`. The host stores uploaded source immutably by package ID and version, separate from the general Skill Library. Connect the host's WhatsApp channel using the available provider setup, then bind the installed handler to the project WhatsApp channel.
4. Test using a question supported by the published files. Search misses, revoked publication, or unavailable model/budget fail to human review.

The script has no provider transport, credentials, tools, planner, project ID, or SQL access. It requests one host-generated answer, grounded in the selected collection, and opts into bounded conversation state. Session state is isolated by project, installation, and opaque conversation ID; it is not a copy of the project Knowledge base.

The generic installer accepts only channel primitives and the `channel.invoke` grant. Canvas/Gadget composition, provider-specific OAuth configuration, cryptographic package signing, and version upgrade/rollback are separate gaps documented in `new plan/FDE-EXTENSIONS-AND-MICROAPPS-ARCHITECTURE.md`.
