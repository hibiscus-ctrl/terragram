output "project_number" {
  value = google_project.project.number
}

output "vnet_id" {
  value = google_compute_network.vnet.id
}

output "dns_name_servers" {
  value = google_dns_managed_zone.dns.name_servers
}

output "containers_url" {
  value = google_cloud_run_v2_service.containers.uri
}

output "functions_url" {
  value = google_cloudfunctions2_function.functions.service_config[0].uri
}

output "kubernetes_endpoint" {
  value = google_container_cluster.kubernetes.endpoint
}

output "virtual_machine_internal_ip" {
  value = google_compute_instance.virtual_machine.network_interface[0].network_ip
}

output "postgres_private_ip" {
  value = google_sql_database_instance.postgres.private_ip_address
}

output "postgres_app_account" {
  value = google_service_account.postgres_app.email
}

output "redis_cache_host" {
  value = google_redis_instance.redis_cache.host
}
