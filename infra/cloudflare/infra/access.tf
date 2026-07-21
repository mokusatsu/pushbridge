resource "cloudflare_zero_trust_access_application" "app" {
  count = var.access_ip_allowlist == null ? 0 : 1

  account_id           = var.account_id
  name                 = "${local.name_prefix} source IP allowlist"
  domain               = var.access_ip_allowlist.hostname
  type                 = "self_hosted"
  session_duration     = "24h"
  app_launcher_visible = false

  policies = [{
    name       = "Allow configured source IPs"
    decision   = "allow"
    precedence = 1
    include = [
      for cidr in sort(tolist(var.access_ip_allowlist.cidrs)) : {
        ip = {
          ip = cidr
        }
      }
    ]
  }]
}
