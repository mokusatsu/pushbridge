resource "cloudflare_workers_script" "app" {
  account_id         = var.account_id
  script_name        = local.worker_name
  content_file       = local.worker_entrypoint
  content_sha256     = filesha256(local.worker_entrypoint)
  main_module        = basename(local.worker_entrypoint)
  compatibility_date = var.compatibility_date

  annotations = {
    workers_message = "Managed by Terraform for ${local.name_prefix}"
    workers_tag     = "terraform-${var.environment}"
  }

  assets = {
    directory = local.assets_directory

    config = {
      headers            = file(local.assets_headers)
      html_handling      = "auto-trailing-slash"
      not_found_handling = "single-page-application"
      run_worker_first   = ["/api/*", "/auth/*", "/ws/*", "/realtime", "/mock-storage/*", "/health", "/healthz"]
    }
  }

  bindings = local.worker_bindings

  migrations = var.durable_object_migration

  observability = {
    enabled            = var.enable_observability
    head_sampling_rate = 1
    logs = {
      enabled            = var.enable_observability
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = false
      head_sampling_rate = 1
      persist            = true
    }
  }

  lifecycle {
    precondition {
      condition     = fileexists(local.worker_entrypoint)
      error_message = "Worker source file not found: ${local.worker_entrypoint}"
    }

    precondition {
      condition     = fileexists("${local.assets_directory}/index.html")
      error_message = "Static assets must contain index.html: ${local.assets_directory}/index.html"
    }

    precondition {
      condition = length(nonsensitive([
        for binding in local.worker_bindings : binding.name
        ])) == length(distinct(nonsensitive([
          for binding in local.worker_bindings : binding.name
      ])))
      error_message = "Worker binding names must be unique across resources, plain-text variables, and secrets."
    }
  }

  depends_on = [
    cloudflare_r2_bucket_lifecycle.files,
    cloudflare_r2_bucket_cors.files
  ]
}

resource "cloudflare_workers_cron_trigger" "cleanup" {
  account_id  = var.account_id
  script_name = cloudflare_workers_script.app.script_name

  schedules = [{
    cron = var.cleanup_cron
  }]
}

resource "cloudflare_queue_consumer" "delivery" {
  count = var.enable_queue ? 1 : 0

  account_id        = var.account_id
  queue_id          = cloudflare_queue.delivery[0].queue_id
  type              = "worker"
  script_name       = cloudflare_workers_script.app.script_name
  dead_letter_queue = cloudflare_queue.dead_letter[0].queue_name

  settings = {
    batch_size            = 10
    max_concurrency       = null
    max_retries           = 3
    max_wait_time_ms      = 1000
    retry_delay           = 30
    visibility_timeout_ms = 30000
  }
}
