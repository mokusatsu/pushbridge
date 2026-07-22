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
  default     = "pushbridge"

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

variable "enable_dev_bootstrap" {
  description = "Enable the temporary development-only bootstrap endpoint. Keep false outside an Access-protected dev environment."
  type        = bool
  default     = false
}

variable "require_dev_bootstrap_turnstile" {
  description = "Require a valid Turnstile token on the temporary development bootstrap endpoint."
  type        = bool
  default     = false
}

variable "dev_bootstrap_rate_limit" {
  description = "Maximum bootstrap attempts per source IP in a ten-minute window."
  type        = number
  default     = 20

  validation {
    condition     = var.dev_bootstrap_rate_limit >= 1 && var.dev_bootstrap_rate_limit <= 100
    error_message = "dev_bootstrap_rate_limit must be between 1 and 100."
  }
}

variable "passkey_rp_id" {
  description = "Explicit WebAuthn relying-party ID. Leave null until the production/custom hostname decision is made."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.passkey_rp_id == null || can(regex("^[A-Za-z0-9.-]+$", var.passkey_rp_id))
    error_message = "passkey_rp_id must be a hostname without a scheme, port, or path."
  }
}

variable "passkey_expected_origins" {
  description = "Exact HTTPS origins accepted for WebAuthn and cookie-session CSRF checks. Localhost HTTP is only for local development."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for origin in var.passkey_expected_origins : can(regex("^https://[^/]+$", origin))
    ])
    error_message = "passkey_expected_origins must contain exact HTTPS origins without a trailing slash."
  }
}

variable "passkey_rp_name" {
  description = "User-visible WebAuthn relying-party name."
  type        = string
  default     = "Pushbridge"
}

variable "require_passkey_turnstile" {
  description = "Require Turnstile before issuing public Passkey registration options. Production defaults to enforcement in Worker code unless explicitly disabled."
  type        = bool
  default     = true
}

variable "auth_rate_limit" {
  description = "Maximum Passkey option requests per source IP and action in a ten-minute window."
  type        = number
  default     = 20

  validation {
    condition     = var.auth_rate_limit >= 1 && var.auth_rate_limit <= 100
    error_message = "auth_rate_limit must be between 1 and 100."
  }
}

variable "account_auth_rate_limit" {
  description = "Maximum Passkey option requests per account in a ten-minute window."
  type        = number
  default     = 20

  validation {
    condition     = var.account_auth_rate_limit >= 1 && var.account_auth_rate_limit <= 100
    error_message = "account_auth_rate_limit must be between 1 and 100."
  }
}

variable "device_mutation_rate_limit" {
  description = "Maximum authenticated state-changing requests per device in a ten-minute window."
  type        = number
  default     = 300

  validation {
    condition     = var.device_mutation_rate_limit >= 10 && var.device_mutation_rate_limit <= 5000
    error_message = "device_mutation_rate_limit must be between 10 and 5000."
  }
}

variable "access_ip_allowlist" {
  description = "Optional Cloudflare Access application that restricts the complete Worker hostname, including Static Assets, to source IP CIDRs. Set to null to disable."
  type = object({
    hostname = string
    cidrs    = set(string)
  })
  default  = null
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

variable "access_service_token_ids" {
  description = "Cloudflare Access Service Token resource IDs allowed to call the Access-protected dev hostname. The client secret must remain outside Terraform."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for token_id in var.access_service_token_ids : can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", token_id))
    ])
    error_message = "access_service_token_ids must contain Cloudflare Service Token UUIDs."
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

variable "storage_budget_bytes" {
  description = "Operational R2 byte budget used by the application cleanup controller."
  type        = number
  default     = 8589934592

  validation {
    condition     = var.storage_budget_bytes >= 26214400
    error_message = "storage_budget_bytes must allow at least one maximum-size file."
  }
}

variable "storage_pressure_high_percent" {
  description = "Projected usage percentage that starts pressure cleanup."
  type        = number
  default     = 95

  validation {
    condition     = var.storage_pressure_high_percent >= 1 && var.storage_pressure_high_percent <= 100
    error_message = "storage_pressure_high_percent must be between 1 and 100."
  }
}

variable "storage_cleanup_target_percent" {
  description = "Usage percentage targeted after pressure cleanup."
  type        = number
  default     = 85

  validation {
    condition     = var.storage_cleanup_target_percent >= 1 && var.storage_cleanup_target_percent < var.storage_pressure_high_percent
    error_message = "storage_cleanup_target_percent must be positive and lower than storage_pressure_high_percent."
  }
}

variable "storage_monthly_byte_day_budget" {
  description = "Optional monthly byte-day allowance. Null disables allowance-based throttling while daily usage is still recorded."
  type        = number
  default     = null
  nullable    = true

  validation {
    condition     = var.storage_monthly_byte_day_budget == null || var.storage_monthly_byte_day_budget > 0
    error_message = "storage_monthly_byte_day_budget must be null or positive."
  }
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

variable "require_e2ee" {
  description = "Require version 2 encrypted Push payloads and encrypted File uploads. Enable only after the Phase 7 client passes E2E."
  type        = bool
  default     = false
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

variable "vapid_public_key" {
  description = "Base64url-encoded uncompressed P-256 VAPID public key exposed to the PWA."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.vapid_public_key == null || can(regex("^[A-Za-z0-9_-]{87}$", var.vapid_public_key))
    error_message = "vapid_public_key must be an unpadded base64url 65-byte P-256 public key."
  }
}

variable "vapid_private_key" {
  description = "Base64url-encoded 32-byte P-256 VAPID private key. Stored as a Worker secret_text binding."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true

  validation {
    condition     = var.vapid_private_key == null || can(regex("^[A-Za-z0-9_-]{43}$", var.vapid_private_key))
    error_message = "vapid_private_key must be an unpadded base64url 32-byte P-256 private key."
  }
}

variable "vapid_subject" {
  description = "VAPID contact URI. Use a mailto URI or an HTTPS URI controlled by the operator."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.vapid_subject == null || can(regex("^(mailto:|https://)", var.vapid_subject))
    error_message = "vapid_subject must be a mailto or HTTPS URI."
  }
}

variable "web_push_data_key" {
  description = "Base64url-encoded 32-byte AES key used to encrypt Web Push subscription fields at rest."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true

  validation {
    condition     = var.web_push_data_key == null || can(regex("^[A-Za-z0-9_-]{43}$", var.web_push_data_key))
    error_message = "web_push_data_key must be an unpadded base64url 32-byte key."
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
