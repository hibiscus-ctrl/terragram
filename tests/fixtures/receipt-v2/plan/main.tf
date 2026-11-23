# Generated from the diagram model
# Target: Azure · UK South · Terraform
# 7 module calls and 0 resources from 4 components
#
# Private network: PostgreSQL accept connections only through private endpoints in
# module.network, and the apps reach them through VNet integration. Anything that administers
# them from elsewhere (a pipeline writing secrets, psql from a workstation) needs a route
# into that network first: a VPN, a bastion host or a runner inside it.

terraform {
  required_version = ">= 1.11, < 2.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.81"
    }
  }
}

locals {
  tags = merge({ ManagedBy = "diagram", Environment = "dev" }, var.tags)
}

provider "azurerm" {
  features {
  }
}

module "resource_group" {
  source           = "Azure/avm-res-resources-resourcegroup/azurerm"
  version          = "0.4.0"
  name             = "rg-${var.name_prefix}"
  location         = var.location
  enable_telemetry = false
  tags             = local.tags
}

module "network" {
  source           = "Azure/avm-res-network-virtualnetwork/azurerm"
  version          = "0.22.2"
  name             = "vnet-${var.name_prefix}"
  parent_id        = module.resource_group.resource_id
  location         = module.resource_group.location
  address_space    = ["10.0.0.0/16"]
  enable_telemetry = false
  tags             = local.tags
  subnets = {
    app-service = {
      name           = "snet-app-service"
      address_prefix = "10.0.1.0/24"
      delegations    = [{ name = "delegation", service_delegation = { name = "Microsoft.Web/serverFarms" } }]
    }
    private-endpoints = {
      name           = "snet-private-endpoints"
      address_prefix = "10.0.2.0/24"
    }
  }
}

module "private_dns_postgres" {
  source      = "Azure/avm-res-network-privatednszone/azurerm"
  version     = "0.5.0"
  domain_name = "privatelink.postgres.database.azure.com"
  parent_id   = module.resource_group.resource_id
  virtual_network_links = {
    network = {
      name               = "private-dns-postgres-link"
      virtual_network_id = module.network.resource_id
      autoregistration   = false
    }
  }
  enable_telemetry = false
  tags             = local.tags
}

module "front_door" {
  source              = "Azure/avm-res-cdn-profile/azurerm"
  version             = "0.1.9"
  name                = "fd-${var.name_prefix}-front-door"
  resource_group_name = module.resource_group.name
  location            = module.resource_group.location
  sku                 = "Premium_AzureFrontDoor"
  front_door_endpoints = {
    default = {
      name = "fde-${var.name_prefix}-front-door"
    }
  }
  front_door_firewall_policies = {
    default = {
      name                = replace("waf-${var.name_prefix}-front-door", "-", "")
      resource_group_name = module.resource_group.name
      sku_name            = "Premium_AzureFrontDoor"
      mode                = "Prevention"
      managed_rules = {
        default = {
          type    = "Microsoft_DefaultRuleSet"
          version = "2.1"
          action  = "Block"
        }
      }
    }
  }
  front_door_security_policies = {
    default = {
      name = "fdsp-${var.name_prefix}-front-door"
      firewall = {
        front_door_firewall_policy_key = "default"
        association = {
          endpoint_keys     = ["default"]
          patterns_to_match = ["/*"]
        }
      }
    }
  }
  enable_telemetry = false
  tags             = local.tags
  front_door_origin_groups = {
    front-door-to-app-service = {
      name = "front-door-to-app-service"
      load_balancing = {
        default = {}
      }
    }
  }
  front_door_origins = {
    front-door-to-app-service = {
      name                           = "front-door-to-app-service"
      origin_group_key               = "front-door-to-app-service"
      host_name                      = module.app_service.resource_uri
      certificate_name_check_enabled = true
    }
  }
  front_door_routes = {
    front-door-to-app-service = {
      name                = "front-door-to-app-service"
      origin_group_key    = "front-door-to-app-service"
      origin_keys         = ["front-door-to-app-service"]
      endpoint_key        = "default"
      forwarding_protocol = "HttpsOnly"
      supported_protocols = ["Http", "Https"]
      patterns_to_match   = ["/*"]
    }
  }
}

module "app_service_plan" {
  source                 = "Azure/avm-res-web-serverfarm/azurerm"
  version                = "2.0.8"
  name                   = "asp-${var.name_prefix}-app-service"
  parent_id              = module.resource_group.resource_id
  location               = module.resource_group.location
  os_type                = "Linux"
  sku_name               = "P1v3"
  worker_count           = 3
  zone_balancing_enabled = true
  enable_telemetry       = false
  tags                   = local.tags
}

module "app_service" {
  source                        = "Azure/avm-res-web-site/azurerm"
  version                       = "0.22.0"
  name                          = "app-${var.name_prefix}-app-service"
  parent_id                     = module.resource_group.resource_id
  location                      = module.resource_group.location
  kind                          = "webapp"
  os_type                       = "Linux"
  service_plan_resource_id      = module.app_service_plan.resource_id
  https_only                    = true
  public_network_access_enabled = true
  virtual_network_subnet_id     = module.network.subnets["app-service"].resource_id
  managed_identities = {
    system_assigned = true
  }
  site_config = {
    minimum_tls_version = "1.3"
    ftps_state          = "Disabled"
    http2_enabled       = true
  }
  enable_telemetry = false
  tags             = local.tags
  app_settings = {
    REDIS_HOST    = module.redis_cache.resource.hostname
    DATABASE_HOST = module.postgres.fqdn
  }
}

module "redis_cache" {
  source              = "Azure/avm-res-cache-redis/azurerm"
  version             = "0.4.0"
  name                = "redis-${var.name_prefix}-redis-cache"
  resource_group_name = module.resource_group.name
  location            = module.resource_group.location
  sku_name            = "Standard"
  capacity            = 1
  minimum_tls_version = "1.2"
  enable_non_ssl_port = false
  zones               = null
  enable_telemetry    = false
  tags                = local.tags
}

module "postgres" {
  source                        = "Azure/avm-res-dbforpostgresql-flexibleserver/azurerm"
  version                       = "0.2.3"
  name                          = "pg-${var.name_prefix}-postgres"
  resource_group_name           = module.resource_group.name
  location                      = module.resource_group.location
  server_version                = "16"
  sku_name                      = "GP_Standard_D2s_v3"
  storage_mb                    = 32768
  administrator_login           = var.db_username
  administrator_password        = var.db_password
  public_network_access_enabled = false
  firewall_rules                = {}
  private_endpoints = {
    primary = {
      subnet_resource_id            = module.network.subnets["private-endpoints"].resource_id
      private_dns_zone_resource_ids = [module.private_dns_postgres.resource_id]
    }
  }
  backup_retention_days        = 7
  geo_redundant_backup_enabled = false
  high_availability            = null
  server_configuration = {
    log_connections = {
      name   = "log_connections"
      config = "on"
    }
    log_checkpoints = {
      name   = "log_checkpoints"
      config = "on"
    }
    connection_throttle = {
      name   = "connection_throttle.enable"
      config = "on"
    }
  }
  enable_telemetry = false
  tags             = local.tags
}
