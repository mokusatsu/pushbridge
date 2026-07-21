variable "account_id" {
  description = "Cloudflare account ID. Set with TF_VAR_account_id or a non-secret tfvars file."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{32}$", var.account_id))
    error_message = "account_id must be a 32-character hexadecimal Cloudflare account ID."
  }
}

variable "project_name" {
  description = "Lowercase DNS-style project name used as the resource-name prefix."
  type        = string
  default     = "relaypush"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$", var.project_name))
    error_message = "project_name must be 3-32 lowercase letters, numbers, or hyphens, and start/end with a letter or number."
  }
}

variable "environment" {
  description = "Deployment environment such as dev, staging, or prod."
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,14}[a-z0-9]$|^[a-z0-9]$", var.environment))
    error_message = "environment must be 1-16 lowercase letters, numbers, or hyphens, and start/end with a letter or number."
  }
}

variable "compatibility_date" {
  description = "Cloudflare Workers compatibility date. Review runtime changes before advancing it."
  type        = string
  default     = "2026-07-21"

  validation {
    condition     = can(regex("^20[0-9]{2}-[0-9]{2}-[0-9]{2}$", var.compatibility_date))
    error_message = "compatibility_date must be formatted as YYYY-MM-DD."
  }
}

variable "worker_source_file" {
  description = "Worker module path, relative to the infra directory unless absolute."
  type        = string
  default     = "../worker/index.mjs"
}

variable "assets_directory" {
  description = "Static PWA asset directory, relative to the infra directory unless absolute."
  type        = string
  default     = "../app/dist"
}

variable "enable_observability" {
  description = "Enable Workers observability."
  type        = bool
  default     = true
}

variable "durable_object_migration" {
  description = "One-shot Durable Object migration payload. Set only for the apply that advances the migration tag, then return to null because provider v5 does not persist this write-only payload in state."
  type = object({
    old_tag            = optional(string)
    new_tag            = string
    new_classes        = optional(list(string))
    new_sqlite_classes = optional(list(string))
    deleted_classes    = optional(list(string))
  })
  default  = null
  nullable = true
}

variable "enable_workers_dev" {
  description = "Expose the Worker on its workers.dev hostname. Disable for custom-domain-only production deployments."
  type        = bool
  default     = true
}

variable "enable_preview_urls" {
  description = "Enable workers.dev preview URLs. Keep disabled unless preview deployments are intentionally used."
  type        = bool
  default     = false
}

variable "access_ip_allowlist" {
  description = "Optional Cloudflare Access application that restricts the complete Worker hostname, including Static Assets, to source IP CIDRs. Set to null to disable."
  type = object({
    hostname = string
    cidrs    = set(string)
  })
  default = {
    hostname = "pushbridge-dev.mokusatsu.workers.dev"
    cidrs    = ["217.178.53.176/32"]
  }
  nullable = true

  validation {
    condition = var.access_ip_allowlist == null || can(
      regex("^[a-z0-9.-]+$", var.access_ip_allowlist.hostname)
    )
    error_message = "access_ip_allowlist.hostname must be a lowercase hostname without a URL scheme, port, or path."
  }

  validation {
    condition = var.access_ip_allowlist == null || (
      length(var.access_ip_allowlist.cidrs) > 0 && alltrue([
        for cidr in var.access_ip_allowlist.cidrs : can(cidrhost(cidr, 0))
      ])
    )
    error_message = "access_ip_allowlist.cidrs must contain at least one valid IPv4 or IPv6 CIDR."
  }
}

variable "custom_domain" {
  description = "Optional Worker custom domain. Supply either zone_id or zone_name."
  type = object({
    hostname  = string
    zone_id   = optional(string)
    zone_name = optional(string)
  })
  default = null

  validation {
    condition = var.custom_domain == null || try(
      (var.custom_domain.zone_id != null && var.custom_domain.zone_id != "") ||
      (var.custom_domain.zone_name != null && var.custom_domain.zone_name != ""),
      false
    )
    error_message = "custom_domain must contain either zone_id or zone_name."
  }

  validation {
    condition     = var.custom_domain == null || can(regex("^[a-z0-9.-]+$", var.custom_domain.hostname))
    error_message = "custom_domain.hostname must be a lowercase hostname without a URL scheme or path."
  }
}

variable "additional_app_hostnames" {
  description = "Additional hostnames accepted by Turnstile, without URL schemes; useful for a workers.dev hostname."
  type        = list(string)
  default     = ["localhost"]

  validation {
    condition = alltrue([
      for hostname in var.additional_app_hostnames :
      can(regex("^[a-zA-Z0-9.-]+$", hostname))
    ])
    error_message = "additional_app_hostnames entries must be hostnames without URL schemes, ports, or paths."
  }
}

variable "cors_allowed_origins" {
  description = "Additional browser origins allowed to use R2 presigned URLs. The custom-domain origin is added automatically."
  type        = list(string)
  default = [
    "http://localhost:5173",
    "http://localhost:8787"
  ]

  validation {
    condition = alltrue([
      for origin in var.cors_allowed_origins :
      can(regex("^https?://[^/]+$", origin))
    ])
    error_message = "cors_allowed_origins entries must be exact http(s) origins without a path."
  }
}

variable "d1_primary_location_hint" {
  description = "Best-effort D1 primary location hint. Ignored when d1_jurisdiction is set."
  type        = string
  default     = "apac"

  validation {
    condition     = contains(["wnam", "enam", "weur", "eeur", "apac", "oc"], var.d1_primary_location_hint)
    error_message = "d1_primary_location_hint must be one of wnam, enam, weur, eeur, apac, or oc."
  }
}

variable "d1_jurisdiction" {
  description = "Optional D1 jurisdiction restriction: eu or fedramp. Null uses the location hint instead."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.d1_jurisdiction == null || contains(["eu", "fedramp"], var.d1_jurisdiction)
    error_message = "d1_jurisdiction must be null, eu, or fedramp."
  }
}

variable "d1_read_replication_mode" {
  description = "D1 read replication mode. Disabled minimizes moving parts for the low-cost MVP."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["auto", "disabled"], var.d1_read_replication_mode)
    error_message = "d1_read_replication_mode must be auto or disabled."
  }
}

variable "r2_location" {
  description = "Best-effort initial R2 bucket location."
  type        = string
  default     = "apac"

  validation {
    condition     = contains(["apac", "eeur", "enam", "weur", "wnam", "oc"], var.r2_location)
    error_message = "r2_location must be one of apac, eeur, enam, weur, wnam, or oc."
  }
}

variable "r2_jurisdiction" {
  description = "R2 jurisdiction. Use default unless a regulatory restriction is required."
  type        = string
  default     = "default"

  validation {
    condition     = contains(["default", "eu", "fedramp"], var.r2_jurisdiction)
    error_message = "r2_jurisdiction must be default, eu, or fedramp."
  }
}

variable "file_retention_seconds" {
  description = "R2 object-key prefixes and their automatic deletion ages."
  type        = map(number)
  default = {
    # D1 expires access at 1/7/30 days. R2 gets one additional day as a
    # last-resort lifecycle safety net; pressure cleanup deletes directly.
    "ttl/1d/"  = 172800
    "ttl/7d/"  = 691200
    "ttl/30d/" = 2678400
  }

  validation {
    condition = alltrue([
      for prefix, seconds in var.file_retention_seconds :
      startswith(prefix, "ttl/") && endswith(prefix, "/") && seconds >= 3600
    ])
    error_message = "Every retention entry must use a ttl/.../ prefix and retain objects for at least 3600 seconds."
  }
}

variable "abort_multipart_after_seconds" {
  description = "Age after which incomplete multipart uploads are aborted."
  type        = number
  default     = 86400

  validation {
    condition     = var.abort_multipart_after_seconds >= 3600
    error_message = "abort_multipart_after_seconds must be at least 3600."
  }
}

variable "enable_queue" {
  description = "Provision a delivery Queue and dead-letter Queue. Keep false for the initial self-device MVP."
  type        = bool
  default     = false
}

variable "queue_message_retention_seconds" {
  description = "Queue message retention period."
  type        = number
  default     = 86400
}

variable "cleanup_cron" {
  description = "UTC cron expression for metadata cleanup."
  type        = string
  default     = "17 3 * * *"
}

variable "turnstile_mode" {
  description = "Turnstile widget mode."
  type        = string
  default     = "managed"

  validation {
    condition     = contains(["managed", "non-interactive", "invisible"], var.turnstile_mode)
    error_message = "turnstile_mode must be managed, non-interactive, or invisible."
  }
}

variable "worker_plain_text_vars" {
  description = "Additional non-sensitive Worker text bindings. Reserved built-in names take precedence."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for binding_name in keys(var.worker_plain_text_vars) :
      can(regex("^[A-Z][A-Z0-9_]*$", binding_name))
    ])
    error_message = "worker_plain_text_vars keys must be uppercase JavaScript binding names."
  }
}

variable "worker_secrets" {
  description = "Additional Worker secret_text bindings. Values are stored in Terraform state; use a protected remote backend."
  type        = map(string)
  default     = {}
  sensitive   = true

  validation {
    condition = alltrue([
      for binding_name in nonsensitive(keys(var.worker_secrets)) :
      can(regex("^[A-Z][A-Z0-9_]*$", binding_name))
    ])
    error_message = "worker_secrets keys must be uppercase JavaScript binding names."
  }
}
