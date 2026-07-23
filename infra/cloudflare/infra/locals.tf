locals {
  name_prefix = "${var.project_name}-${var.environment}"

  worker_name = local.name_prefix
  d1_name     = "${local.name_prefix}-db"
  r2_name     = "${local.name_prefix}-files"
  queue_name  = "${local.name_prefix}-delivery"
  dlq_name    = "${local.name_prefix}-delivery-dlq"

  worker_entrypoint = startswith(var.worker_source_file, "/") ? var.worker_source_file : abspath("${path.module}/${var.worker_source_file}")
  assets_directory  = startswith(var.assets_directory, "/") ? var.assets_directory : abspath("${path.module}/${var.assets_directory}")
  assets_headers    = abspath("${path.module}/../app/headers.conf")

  custom_hostname = var.custom_domain == null ? null : var.custom_domain.hostname
  custom_origin   = local.custom_hostname == null ? null : "https://${local.custom_hostname}"
  access_origin   = var.access_ip_allowlist == null ? null : "https://${var.access_ip_allowlist.hostname}"
  r2_direct       = var.r2_s3_access_key_id != null && var.r2_s3_secret_access_key != null

  app_hostnames = sort(distinct(compact(concat(
    var.additional_app_hostnames,
    [local.custom_hostname]
  ))))

  r2_cors_origins = distinct(compact(concat(
    var.cors_allowed_origins,
    [local.custom_origin, local.access_origin]
  )))

  reserved_plain_text_vars = {
    APP_ENVIRONMENT                 = var.environment
    APP_NAME                        = var.project_name
    ENABLE_DEV_BOOTSTRAP            = tostring(var.enable_dev_bootstrap)
    REQUIRE_DEV_BOOTSTRAP_TURNSTILE = tostring(var.require_dev_bootstrap_turnstile)
    DEV_BOOTSTRAP_RATE_LIMIT        = tostring(var.dev_bootstrap_rate_limit)
    R2_ACCOUNT_ID                   = var.account_id
    R2_BUCKET_NAME                  = local.r2_name
    R2_DIRECT_UPLOAD                = tostring(local.r2_direct)
    TURNSTILE_SITE_KEY              = cloudflare_turnstile_widget.registration.sitekey
    FILE_RETENTION_POLICY           = jsonencode(var.file_retention_seconds)
    STORAGE_BUDGET_BYTES            = tostring(var.storage_budget_bytes)
    STORAGE_PRESSURE_HIGH_PERCENT   = tostring(var.storage_pressure_high_percent)
    STORAGE_CLEANUP_TARGET_PERCENT  = tostring(var.storage_cleanup_target_percent)
    PASSKEY_RP_NAME                 = var.passkey_rp_name
    REQUIRE_PASSKEY_TURNSTILE       = tostring(var.require_passkey_turnstile)
    AUTH_RATE_LIMIT                 = tostring(var.auth_rate_limit)
    ACCOUNT_AUTH_RATE_LIMIT         = tostring(var.account_auth_rate_limit)
    DEVICE_MUTATION_RATE_LIMIT      = tostring(var.device_mutation_rate_limit)
    REQUIRE_E2EE                    = tostring(var.require_e2ee)
  }

  passkey_plain_text_vars = var.passkey_rp_id == null ? {} : {
    PASSKEY_RP_ID            = var.passkey_rp_id
    PASSKEY_EXPECTED_ORIGINS = jsonencode(sort(tolist(var.passkey_expected_origins)))
  }

  storage_allowance_vars = var.storage_monthly_byte_day_budget == null ? {} : {
    STORAGE_MONTHLY_BYTE_DAY_BUDGET = tostring(var.storage_monthly_byte_day_budget)
  }

  web_push_plain_text_vars = merge(
    var.vapid_public_key == null ? {} : { VAPID_PUBLIC_KEY = var.vapid_public_key },
    var.vapid_subject == null ? {} : { VAPID_SUBJECT = var.vapid_subject }
  )

  web_push_secret_values = merge(
    var.vapid_private_key == null ? {} : { VAPID_PRIVATE_KEY = var.vapid_private_key },
    var.web_push_data_key == null ? {} : { WEB_PUSH_DATA_KEY = var.web_push_data_key }
  )

  plain_text_vars = merge(
    var.worker_plain_text_vars,
    local.web_push_plain_text_vars,
    local.storage_allowance_vars,
    local.passkey_plain_text_vars,
    local.reserved_plain_text_vars
  )

  worker_secret_values = merge(
    var.worker_secrets,
    local.web_push_secret_values,
    local.r2_direct ? {
      R2_S3_ACCESS_KEY_ID     = var.r2_s3_access_key_id
      R2_S3_SECRET_ACCESS_KEY = var.r2_s3_secret_access_key
    } : {},
    {
      TURNSTILE_SECRET_KEY = cloudflare_turnstile_widget.registration.secret
    }
  )

  binding_defaults = {
    bucket_name  = null
    class_name   = null
    database_id  = null
    id           = null
    jurisdiction = null
    queue_name   = null
    script_name  = null
    text         = null
  }

  resource_bindings = [
    merge(local.binding_defaults, {
      name = "DB"
      type = "d1"
      id   = cloudflare_d1_database.app.id
    }),
    merge(local.binding_defaults, {
      name         = "FILES"
      type         = "r2_bucket"
      bucket_name  = cloudflare_r2_bucket.files.name
      jurisdiction = var.r2_jurisdiction == "default" ? null : var.r2_jurisdiction
    }),
    merge(local.binding_defaults, {
      name       = "USER_HUB"
      type       = "durable_object_namespace"
      class_name = "UserHub"
    })
  ]

  queue_bindings = var.enable_queue ? [
    merge(local.binding_defaults, {
      name       = "DELIVERY_QUEUE"
      type       = "queue"
      queue_name = cloudflare_queue.delivery[0].queue_name
    })
  ] : []

  plain_text_bindings = [
    for binding_name in sort(keys(local.plain_text_vars)) :
    merge(local.binding_defaults, {
      name = binding_name
      type = "plain_text"
      text = local.plain_text_vars[binding_name]
    })
  ]

  secret_text_bindings = [
    for binding_name in sort(nonsensitive(keys(local.worker_secret_values))) :
    merge(local.binding_defaults, {
      name = binding_name
      type = "secret_text"
      text = local.worker_secret_values[binding_name]
    })
  ]

  worker_bindings = concat(
    local.resource_bindings,
    local.queue_bindings,
    local.plain_text_bindings,
    local.secret_text_bindings
  )
}
