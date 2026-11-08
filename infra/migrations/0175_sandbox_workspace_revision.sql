-- Pin sandbox snapshot diffs to the exact coordinator revision they observed.
ALTER TABLE sandbox_workspace_snapshots ADD COLUMN coordinator_revision INTEGER;
