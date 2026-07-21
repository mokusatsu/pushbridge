output "account_id" {
  description = "Cloudflare account ID used by this stack."
  value       = var.account_id
}


output "compatibility_date" {
  description = "Workers compatibility date used by this stack."
  value       = var.compatibility_date
}

output "worker_name" {
  description = "Deployed Worker script name."
  value       = cloudflare_workers_script.app.script_name
}

output "custom_url" {
  description = "Custom-domain URL, when configured."
  value       = local.custom_origin
}

output "workers_dev_enabled" {
  description = "Whether workers.dev routing is enabled for the script."
  value       = var.enable_workers_dev
}

output "d1_database_id" {
  description = "D1 database UUID."
  value       = cloudflare_d1_database.app.id
}

output "d1_database_name" {
  description = "D1 database name."
  value       = cloudflare_d1_database.app.name
}

output "r2_bucket_name" {
  description = "Private R2 file bucket name."
  value       = cloudflare_r2_bucket.files.name
}

output "queue_name" {
  description = "Delivery Queue name, or null when Queue support is disabled."
  value       = var.enable_queue ? cloudflare_queue.delivery[0].queue_name : null
}

output "turnstile_site_key" {
  description = "Turnstile public site key."
  value       = cloudflare_turnstile_widget.registration.sitekey
}

output "turnstile_secret_key" {
  description = "Turnstile secret key. It is already bound to the Worker as TURNSTILE_SECRET_KEY."
  value       = cloudflare_turnstile_widget.registration.secret
  sensitive   = true
}

output "resource_names" {
  description = "Names useful for CI/CD and application configuration."
  value = {
    worker   = cloudflare_workers_script.app.script_name
    database = cloudflare_d1_database.app.name
    bucket   = cloudflare_r2_bucket.files.name
    queue    = var.enable_queue ? cloudflare_queue.delivery[0].queue_name : null
  }
}
