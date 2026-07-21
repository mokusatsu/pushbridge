resource "cloudflare_d1_database" "app" {
  account_id            = var.account_id
  name                  = local.d1_name
  jurisdiction          = var.d1_jurisdiction
  primary_location_hint = var.d1_jurisdiction == null ? var.d1_primary_location_hint : null

  read_replication = {
    mode = var.d1_read_replication_mode
  }
}

resource "cloudflare_r2_bucket" "files" {
  account_id    = var.account_id
  name          = local.r2_name
  location      = var.r2_location
  jurisdiction  = var.r2_jurisdiction
  storage_class = "Standard"
}

resource "cloudflare_r2_bucket_lifecycle" "files" {
  account_id   = var.account_id
  bucket_name  = cloudflare_r2_bucket.files.name
  jurisdiction = var.r2_jurisdiction == "default" ? null : var.r2_jurisdiction

  rules = [
    for prefix, max_age in var.file_retention_seconds : {
      id      = "expire-${replace(trim(prefix, "/"), "/", "-")}"
      enabled = true

      conditions = {
        prefix = prefix
      }

      abort_multipart_uploads_transition = {
        condition = {
          max_age = var.abort_multipart_after_seconds
          type    = "Age"
        }
      }

      delete_objects_transition = {
        condition = {
          max_age = max_age
          type    = "Age"
        }
      }

      storage_class_transitions = []
    }
  ]
}

resource "cloudflare_r2_bucket_cors" "files" {
  account_id   = var.account_id
  bucket_name  = cloudflare_r2_bucket.files.name
  jurisdiction = var.r2_jurisdiction == "default" ? null : var.r2_jurisdiction

  rules = [{
    id = "browser-presigned-uploads-and-downloads"

    allowed = {
      methods = ["GET", "HEAD", "PUT"]
      origins = local.r2_cors_origins
      headers = ["*"]
    }

    expose_headers  = ["ETag", "Content-Length", "Content-Type"]
    max_age_seconds = 3600
  }]
}
