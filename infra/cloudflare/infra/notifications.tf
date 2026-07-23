resource "cloudflare_notification_policy" "incidents" {
  count = var.notification_email == null ? 0 : 1

  account_id  = var.account_id
  name        = "${local.name_prefix} Cloudflare incidents"
  description = "Cloudflare incident notifications for the Pushbridge operator."
  enabled     = true
  alert_type  = "incident_alert"
  mechanisms = {
    email = [{
      id = var.notification_email
    }]
  }
}

resource "cloudflare_notification_policy" "service_token_expiration" {
  count = var.notification_email == null ? 0 : 1

  account_id  = var.account_id
  name        = "${local.name_prefix} Access Service Token expiration"
  description = "Expiration warning for Access Service Tokens used by Pushbridge automation."
  enabled     = true
  alert_type  = "expiring_service_token_alert"
  mechanisms = {
    email = [{
      id = var.notification_email
    }]
  }
}
