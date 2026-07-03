-- F: Launchpad core agents (spec §11) are installed as R2 configs by the provisioner but
-- nothing ever reads LaunchpadAgentDefinition.trigger — every dispatcher hardcodes
-- "naelao-agent", so the Content agent's `cron: "0 9 * * *"` schedule trigger never actually
-- runs the specialist. scheduled_jobs (0041) only supported firing a named prebuilt script
-- op DIRECTLY (fireScriptDirectly/handleTriggerFire — no reasoner, no OBSERVE/FIND/GATE loop,
-- by design, same as event_triggers), which can't "draft this week's content" — that needs a
-- real reasoning session. Two nullable columns add a second, opt-in dispatch mode without
-- touching the existing script_name behavior any existing row relies on:
--   agent_id  — which agent's own R2 config (system prompt, approval gates, prebuilt scripts)
--               to wake. NULL keeps today's implicit "naelao-agent" default.
--   goal      — when set, the dispatcher (workers/agents/src/index.ts handleAgentTick) wakes
--               the FULL reasoning loop (POST .../script/run) with this goal instead of firing
--               script_name directly. NULL preserves the exact pre-existing direct-fire path.
-- A row has exactly one of script_name or goal meaningful for firing; the app layer enforces
-- "at least one of the two" at write time (see workers/spaces/src/index.ts). script_name stays
-- NOT NULL (0041) — a goal-based row stores '' there (SQLite can't drop a NOT NULL constraint
-- without a full table rebuild, and '' is an unambiguous "no direct script" sentinel the app
-- layer checks for, same pattern as project_id NULL meaning "space-wide").
ALTER TABLE scheduled_jobs ADD COLUMN agent_id TEXT;
ALTER TABLE scheduled_jobs ADD COLUMN goal TEXT;
