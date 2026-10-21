-- Preserve the source of a space suspension so reseller restoration cannot undo an
-- independent abuse suspension or an erasure hold.
ALTER TABLE spaces ADD COLUMN suspension_reason TEXT;
