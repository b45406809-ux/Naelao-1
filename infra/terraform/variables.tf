variable "cloudflare_api_token" {
  description = "Cloudflare API token with Workers, D1, R2, KV, Queues, Vectorize permissions"
  type        = string
  sensitive   = true
}

variable "account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "environment" {
  description = "Deployment environment (staging or production)"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be 'staging' or 'production'."
  }
}

variable "project_name" {
  description = "Base project name for resource naming"
  type        = string
  default     = "naelao"
}

variable "stripe_api_key" {
  description = "Stripe secret API key for billing integration"
  type        = string
  sensitive   = true
  default     = ""
}

variable "platform_secret" {
  description = "Platform HMAC secret for DO name derivation and internal auth"
  type        = string
  sensitive   = true
}

variable "anthropic_api_key" {
  description = "Anthropic API key for Claude LLM calls"
  type        = string
  sensitive   = true
  default     = ""
}

variable "jwt_secret" {
  description = "JWT signing secret for builder authentication"
  type        = string
  sensitive   = true
}

variable "encrypt_kek" {
  description = "AES-256-GCM Key Encryption Key for credential vault"
  type        = string
  sensitive   = true
}
