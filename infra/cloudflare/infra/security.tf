resource "cloudflare_turnstile_widget" "registration" {
  account_id      = var.account_id
  name            = "${local.name_prefix} registration and recovery"
  domains         = local.app_hostnames
  mode            = var.turnstile_mode
  clearance_level = "no_clearance"
  region          = "world"

  lifecycle {
    precondition {
      condition     = length(local.app_hostnames) > 0
      error_message = "Turnstile requires at least one hostname. Configure custom_domain or additional_app_hostnames."
    }
  }
}

check "passkey_configuration" {
  assert {
    condition = (
      (var.passkey_rp_id == null && length(var.passkey_expected_origins) == 0) ||
      (var.passkey_rp_id != null && length(var.passkey_expected_origins) > 0)
    )
    error_message = "Passkeys require both passkey_rp_id and at least one exact passkey_expected_origin; leave both unset to keep the feature disabled."
  }
}
