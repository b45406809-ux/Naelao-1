locals {
  name_prefix = "${var.project_name}-${var.environment}"
  tags        = { project = var.project_name, environment = var.environment, managed_by = "terraform" }
}

# ── D1 Databases ──────────────────────────────────────────────────────────────

resource "cloudflare_d1_database" "platform" {
  account_id = var.account_id
  name       = "${local.name_prefix}-platform-db"
}

# ── KV Namespaces ─────────────────────────────────────────────────────────────

resource "cloudflare_workers_kv_namespace" "config" {
  account_id = var.account_id
  title      = "${local.name_prefix}-config"
}

resource "cloudflare_workers_kv_namespace" "sessions" {
  account_id = var.account_id
  title      = "${local.name_prefix}-sessions"
}

resource "cloudflare_workers_kv_namespace" "rate_limits" {
  account_id = var.account_id
  title      = "${local.name_prefix}-rate-limits"
}

resource "cloudflare_workers_kv_namespace" "circuit_breakers" {
  account_id = var.account_id
  title      = "${local.name_prefix}-circuit-breakers"
}

resource "cloudflare_workers_kv_namespace" "portal_routes" {
  account_id = var.account_id
  title      = "${local.name_prefix}-portal-routes"
}

resource "cloudflare_workers_kv_namespace" "feature_flags" {
  account_id = var.account_id
  title      = "${local.name_prefix}-feature-flags"
}

# ── R2 Buckets ────────────────────────────────────────────────────────────────

resource "cloudflare_r2_bucket" "kb_documents" {
  account_id = var.account_id
  name       = "${local.name_prefix}-kb-documents"
  location   = "WNAM"
}

resource "cloudflare_r2_bucket" "exports" {
  account_id = var.account_id
  name       = "${local.name_prefix}-exports"
  location   = "WNAM"
}

resource "cloudflare_r2_bucket" "artifacts" {
  account_id = var.account_id
  name       = "${local.name_prefix}-artifacts"
  location   = "WNAM"
}

resource "cloudflare_r2_bucket" "backups" {
  account_id = var.account_id
  name       = "${local.name_prefix}-backups"
  location   = "WNAM"
}

resource "cloudflare_r2_bucket" "static" {
  account_id = var.account_id
  name       = "${local.name_prefix}-static"
  location   = "WNAM"
}

# ── Queues ────────────────────────────────────────────────────────────────────

resource "cloudflare_queue" "events" {
  account_id = var.account_id
  name       = "${local.name_prefix}-events"
}

resource "cloudflare_queue" "webhooks" {
  account_id = var.account_id
  name       = "${local.name_prefix}-webhooks"
}

resource "cloudflare_queue" "analytics" {
  account_id = var.account_id
  name       = "${local.name_prefix}-analytics"
}

resource "cloudflare_queue" "notifications" {
  account_id = var.account_id
  name       = "${local.name_prefix}-notifications"
}

resource "cloudflare_queue" "kb_ingestion" {
  account_id = var.account_id
  name       = "${local.name_prefix}-kb-ingestion"
}

resource "cloudflare_queue" "sessions" {
  account_id = var.account_id
  name       = "${local.name_prefix}-sessions"
}

# ── Vectorize Indexes ─────────────────────────────────────────────────────────

resource "cloudflare_vectorize_index" "kb" {
  account_id = var.account_id
  name       = "${local.name_prefix}-kb"

  config = {
    dimensions = 1536
    metric     = "cosine"
  }
}

resource "cloudflare_vectorize_index" "platform_docs" {
  account_id = var.account_id
  name       = "${local.name_prefix}-platform-docs"

  config = {
    dimensions = 1536
    metric     = "cosine"
  }
}

resource "cloudflare_vectorize_index" "marketplace" {
  account_id = var.account_id
  name       = "${local.name_prefix}-marketplace"

  config = {
    dimensions = 1536
    metric     = "cosine"
  }
}

# ── CF Pages Projects ─────────────────────────────────────────────────────────

resource "cloudflare_pages_project" "dashboard" {
  account_id        = var.account_id
  name              = "${local.name_prefix}-dashboard"
  production_branch = "main"

  build_config {
    build_command   = "pnpm --filter @naelao/dashboard build"
    destination_dir = "apps/dashboard/.vercel/output/static"
  }

  source {
    type = "github"
    config {
      owner                         = "b45406809-ux"
      repo_name                     = "Naelao-1"
      production_branch             = "main"
      pr_comments_enabled           = true
      deployments_enabled           = true
      production_deployment_enabled = true
    }
  }
}

resource "cloudflare_pages_project" "portal" {
  account_id        = var.account_id
  name              = "${local.name_prefix}-portal"
  production_branch = "main"

  build_config {
    build_command   = "pnpm --filter @naelao/portal build"
    destination_dir = "apps/portal/.vercel/output/static"
  }

  source {
    type = "github"
    config {
      owner                         = "b45406809-ux"
      repo_name                     = "Naelao-1"
      production_branch             = "main"
      pr_comments_enabled           = false
      deployments_enabled           = true
      production_deployment_enabled = true
    }
  }
}

resource "cloudflare_pages_project" "marketplace" {
  account_id        = var.account_id
  name              = "${local.name_prefix}-marketplace"
  production_branch = "main"

  build_config {
    build_command   = "pnpm --filter @naelao/marketplace-web build"
    destination_dir = "apps/marketplace-web/.vercel/output/static"
  }

  source {
    type = "github"
    config {
      owner                         = "b45406809-ux"
      repo_name                     = "Naelao-1"
      production_branch             = "main"
      pr_comments_enabled           = false
      deployments_enabled           = true
      production_deployment_enabled = true
    }
  }
}
