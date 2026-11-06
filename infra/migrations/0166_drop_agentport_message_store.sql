-- Message bodies and attachments belong to channel providers, not AgentPort.
-- Migration 0164 already copied provider references and trust/routing metadata into the
-- metadata-only table, then redacted legacy body fields. Remove the obsolete content-capable
-- table now so the schema cannot accidentally become a conversation store again.
DROP TABLE IF EXISTS agentport_messages;
