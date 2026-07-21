resource "cloudflare_workers_script_subdomain" "app" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.app.script_name
  enabled          = var.enable_workers_dev
  previews_enabled = var.enable_preview_urls
}

resource "cloudflare_workers_custom_domain" "app" {
  count = var.custom_domain == null ? 0 : 1

  account_id = var.account_id
  hostname   = try(var.custom_domain.hostname, null)
  service    = cloudflare_workers_script.app.script_name
  zone_id    = try(var.custom_domain.zone_id, null)
  zone_name  = try(var.custom_domain.zone_name, null)
}
