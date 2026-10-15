# Durable timekeeper and bounded container work

Keep waiting, polling schedules, and event waits in a Durable Workflow. Use a container only for a bounded unit of work, such as processing a batch or invoking an installed native binary. Container execution has a hard maximum of 60 seconds; a runtime profile may impose a shorter limit. A timeout stops the container and may leave workspace publication requiring reconciliation. It does not mean the work is free or guarantee a particular cost.

An FDE can create a workflow with the `dynamic-workflow` CLI and declare `code.execute_bash` as its only container-capable effect. The workflow effect journal makes each named step idempotent: an uncertain external effect is left for reconciliation instead of being silently retried. Each `code.execute_bash` call still passes the normal permission, native-execution, installation, project/Space, workspace, budget, and 60-second checks. Do not declare the raw `Bash` alias or use Python execution as a background-worker escape hatch.

```ts
export async function execute(step, ctx) {
  const result = await step.do("inspect-one-batch", () =>
    ctx.tools.call("inspect-batch-001", "code.execute_bash", {
      commands: "pdf-inspect /workspace/incoming/batch-001.pdf",
    })
  );
  return result;
}
```

Create/schedule the workflow through the installed `dynamic-workflow` operations. `workflow.schedule` is project-scoped and starts one bounded workflow run per cron tick; each run ends after its batch. For a finite multi-step task that must wait before its next step, use `step.sleep` or `step.sleepUntil`; the workflow checkpoint resumes without keeping a container alive. Prefer event-driven wakeups where available. The account remains responsible for workflow, container, storage and provider charges, so choose polling intervals and batch sizes deliberately.

When the same runtime is already installed in another project, Foundry may offer an explicit promotion to the dedicated Space-extension workspace. Promotion deactivates the project installations; it does not move files or guarantee compute savings. Space-extension state stays separate from the Space Assistant workspace. Choose the assistant workspace only when the runtime is meant to read/write the assistant's own shared files.
