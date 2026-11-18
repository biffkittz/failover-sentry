# Mock data for the Cloudflare provider. cloudflare_account_api_token_permission_groups_list isn't mocked: mocks can't
# return a list of permission groups (computed lists come back empty), so root runs override the alert-token module,
# and the module's own tests pass the catalogue as an input.

mock_data "cloudflare_zone" {
  defaults = {
    id = "0123456789abcdef0123456789abcdef"
    account = {
      id   = "abcdef0123456789abcdef0123456789"
      name = "Mock account"
    }
  }
}

mock_data "cloudflare_zero_trust_tunnel_cloudflared_token" {
  defaults = {
    token = "eyJhIjoibW9jayJ9"
  }
}

mock_resource "cloudflare_dns_record" {
  defaults = {
    id = "fedcba9876543210fedcba9876543210"
  }
}

mock_resource "cloudflare_zero_trust_tunnel_cloudflared" {
  defaults = {
    id = "c1744f8b-faa1-48a4-9e5c-02ac921467fa"
  }
}

mock_resource "cloudflare_zero_trust_tunnel_cloudflared_config" {
  defaults = {
    id = "c1744f8b-faa1-48a4-9e5c-02ac921467fa"
  }
}

mock_resource "cloudflare_workers_kv_namespace" {
  defaults = {
    id = "0f2ac74b498b48028cb68387c421e279"
  }
}

mock_resource "cloudflare_workers_script" {
  defaults = {
    id = "fsentry-demo-edge"
  }
}

mock_resource "cloudflare_workers_custom_domain" {
  defaults = {
    id = "9a7806061c88ada191ed06f989cc3dac"
  }
}

mock_resource "cloudflare_account_token" {
  defaults = {
    id    = "ed17574386854bf78a67040be0a770b0"
    value = "mock-email-sending-token"
  }
}
