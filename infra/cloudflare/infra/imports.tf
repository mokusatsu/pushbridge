# The state backend was empty while the workers.dev bootstrap script already
# existed. Import these two non-destructive identities before any apply so the
# first managed deployment updates the existing Worker instead of treating it
# as an unrelated create. The state bucket itself is intentionally out of scope.
import {
  to = cloudflare_workers_script.app
  id = "${var.account_id}/${local.worker_name}"
}

import {
  to = cloudflare_workers_script_subdomain.app
  id = "${var.account_id}/${local.worker_name}"
}
