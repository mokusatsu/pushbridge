resource "cloudflare_queue" "delivery" {
  count = var.enable_queue ? 1 : 0

  account_id = var.account_id
  queue_name = local.queue_name

  settings = {
    delivery_delay           = 0
    delivery_paused          = false
    message_retention_period = var.queue_message_retention_seconds
  }
}

resource "cloudflare_queue" "dead_letter" {
  count = var.enable_queue ? 1 : 0

  account_id = var.account_id
  queue_name = local.dlq_name

  settings = {
    delivery_delay           = 0
    delivery_paused          = false
    message_retention_period = var.queue_message_retention_seconds
  }
}
