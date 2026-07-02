-- G-M01..M10: Marketplace listings, reviews, forks
CREATE TABLE IF NOT EXISTS marketplace_listings (
  id TEXT PRIMARY KEY,
  space_type_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  long_description TEXT,
  category TEXT NOT NULL DEFAULT 'other',
  tags_json TEXT NOT NULL DEFAULT '[]',
  pricing TEXT NOT NULL DEFAULT 'free',      -- 'free', 'paid'
  preview_config_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',    -- 'pending', 'published', 'rejected'
  reviewed_by TEXT,
  review_note TEXT,
  install_count INTEGER NOT NULL DEFAULT 0,
  avg_rating REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  embedding_json TEXT,                       -- Vectorize index vector (stored for re-indexing)
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS marketplace_reviews (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  reviewer_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (listing_id) REFERENCES marketplace_listings (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ml_status ON marketplace_listings (status, category, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_installs ON marketplace_listings (status, install_count DESC);
CREATE INDEX IF NOT EXISTS idx_ml_rating ON marketplace_listings (status, avg_rating DESC);
CREATE INDEX IF NOT EXISTS idx_ml_tenant ON marketplace_listings (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mr_unique ON marketplace_reviews (listing_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_mr_listing ON marketplace_reviews (listing_id, created_at DESC);
