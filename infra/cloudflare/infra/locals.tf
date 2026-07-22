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

  app_hostnames = sort(distinct(compact(concat(
    var.additional_app_hostnames,
    [local.custom_hostname]
  ))))

  r2_cors_origins = distinct(compact(concat(
    var.cors_allowed_origins,
    [local.custom_origin]
  )))

  reserved_plain_text_vars = {
    APP_ENVIRONMENT                 = var.environment
    APP_NAME                        = var.project_name
    ENABLE_DEV_BOOTSTRAP            = tostring(var.enable_dev_bootstrap)
    REQUIRE_DEV_BOOTSTRAP_TURNSTILE = tostring(var.require_dev_bootstrap_turnstile)
    DEV_BOOTSTRAP_RATE_LIMIT        = tostring(var.dev_bootstrap_rate_limit)
    R2_BUCKET_NAME                  = local.r2_name
    TURNSTILE_SITE_KEY              = cloudflare_turnstile_widget.registration.sitekey
    FILE_RETENTION_POLICY           = jsonencode(var.file_retention_seconds)
  }

  plain_text_vars = merge(
    var.worker_plain_text_vars,
    local.reserved_plain_text_vars
  )

  worker_secret_values = merge(
    var.worker_secrets,
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
