terraform {
  required_version = ">= 1.6.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.45"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state in Cloudflare R2 (via S3-compatible backend)
  # Uncomment and configure for production use:
  # backend "s3" {
  #   bucket                      = "naelao-terraform-state"
  #   key                         = "platform/terraform.tfstate"
  #   region                      = "auto"
  #   endpoint                    = "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
  #   skip_credentials_validation = true
  #   skip_metadata_api_check     = true
  #   skip_region_validation      = true
  #   force_path_style            = true
  # }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
