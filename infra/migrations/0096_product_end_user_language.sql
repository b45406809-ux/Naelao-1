-- Saved response-language preference is product-scoped and owned by the end-user profile.
ALTER TABLE product_end_users ADD COLUMN preferred_language TEXT;
ALTER TABLE users ADD COLUMN preferred_language TEXT;
