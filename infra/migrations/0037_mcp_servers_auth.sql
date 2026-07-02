-- Connector layer: reconcile mcp_servers with the mcp-hub worker.
--
-- The hub code reads auth_type + auth_secret_name (a reference to a space_credentials NAME),
-- but 0012 never defined them — the hub would throw at runtime. Add the columns. The secret is
-- NEVER stored here; auth_secret_name points at the encrypted vault (space_credentials), which
-- the hub resolves through the credentials worker at call time so the agent never sees it.
ALTER TABLE mcp_servers ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'none';
ALTER TABLE mcp_servers ADD COLUMN auth_secret_name TEXT;
