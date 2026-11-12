-- Bind a cross-store main-runtime generation claim to a durable retry token. If a D1
-- acknowledgement is lost after the write, the Durable Object can safely recover the
-- same generation instead of starting another allocation or accepting a stale generation.
ALTER TABLE project_main_runtime_registry ADD COLUMN allocation_token TEXT;
