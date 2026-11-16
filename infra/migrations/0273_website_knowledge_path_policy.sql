-- Scope Knowledge page fetches to explicit owner-approved path prefixes.
ALTER TABLE website_connections ADD COLUMN knowledge_path_prefixes_json TEXT NOT NULL DEFAULT '["/"]';
