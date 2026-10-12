-- Marketplace publication must retain the exact artifact and signed conformance receipt
-- that were checked during submission so the owner publish path can revalidate them.
ALTER TABLE marketplace_listings ADD COLUMN conformance_artifact_json TEXT;
ALTER TABLE marketplace_listings ADD COLUMN conformance_certificate_json TEXT;
