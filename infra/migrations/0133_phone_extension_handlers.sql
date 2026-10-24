CREATE TABLE assistant_phone_extension_handlers (
 binding_id TEXT PRIMARY KEY REFERENCES assistant_phone_bindings(id) ON DELETE CASCADE,
 installation_id TEXT NOT NULL, handler_sha256 TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','active')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
