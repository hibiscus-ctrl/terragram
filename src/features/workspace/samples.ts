/** Starter prompts shown in the compose empty state. */
export const COMPOSE_SUGGESTIONS = [
  "A web app with a Postgres database and Redis cache",
  "A containerised API behind a load balancer with a queue and monitoring",
  "Add a CDN and WAF in front of the web tier",
  "Put identity behind Entra ID and store secrets in a vault",
];

/**
 * A pasteable Terraform sample for the Terraform → Diagram mode.
 *
 * It carries real references between resources — the web app's settings point at the
 * database and the cache — because that is what the parser reads to reconstruct the
 * topology. A sample without references would only exercise the fallback path.
 */
export const SAMPLE_TERRAFORM = `terraform {
  required_version = ">= 1.6, < 2.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.81"
    }
  }
}

provider "azurerm" {
  features {}
}

resource "azurerm_resource_group" "main" {
  name     = "rg-reference-app"
  location = "uksouth"
}

resource "azurerm_cdn_frontdoor_profile" "edge" {
  name                = "fd-reference-app"
  resource_group_name = azurerm_resource_group.main.name
  sku_name            = "Premium_AzureFrontDoor"
}

resource "azurerm_service_plan" "web" {
  name                = "asp-reference-app"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  os_type             = "Linux"
  sku_name            = "P1v3"
}

resource "azurerm_linux_web_app" "web" {
  name                = "app-reference-app"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  service_plan_id     = azurerm_service_plan.web.id

  app_settings = {
    DATABASE_HOST = azurerm_postgresql_flexible_server.db.fqdn
    REDIS_HOST    = azurerm_redis_cache.cache.hostname
  }

  site_config {}
}

resource "azurerm_postgresql_flexible_server" "db" {
  name                = "pg-reference-app"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  version             = "16"
  sku_name            = "GP_Standard_D2s_v3"
  storage_mb          = 32768
}

resource "azurerm_redis_cache" "cache" {
  name                = "redis-reference-app"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  capacity            = 1
  family              = "C"
  sku_name            = "Standard"
}
`;

/**
 * A file the parser can only partly translate: one mappable resource plus a module
 * call it cannot read. It should produce a diagram with the bucket on it and the
 * module shown as flagged and untranslated — not an error, and not a silent omission.
 */
export const SAMPLE_TERRAFORM_PARTIAL = `# Exported from a legacy tool
module "legacy_stack" {
  source = "./modules/legacy"
}

resource "aws_s3_bucket" "artifacts" {
  bucket = "legacy-artifacts"
}
`;

/**
 * A pasteable Mermaid flowchart for the Diagram → Terraform mode. The kind of thing
 * that lives in a README: labels a human wrote, arrows for the traffic, and one box
 * (`Legacy CRM`) that no cloud component matches — so the sample shows the flagged,
 * untranslated path as well as the happy one.
 */
export const SAMPLE_MERMAID = `flowchart LR
  users((Users)) --> waf[WAF / CDN]
  waf --> web[Web app]
  web --> db[(Postgres database)]
  web --> cache[Redis cache]
  web --> queue[Message queue]
  queue --> worker[Background functions]
  worker --> crm[Legacy CRM]
  web -.-> logs[Monitoring]
`;
