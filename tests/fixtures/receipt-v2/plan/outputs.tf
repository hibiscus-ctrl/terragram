output "front_door_hostname" {
  value = module.front_door.frontdoor_endpoints["default"].host_name
}

output "app_service_hostname" {
  value = module.app_service.resource_uri
}

output "postgres_fqdn" {
  value = module.postgres.fqdn
}
