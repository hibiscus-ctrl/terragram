output "front_door_domain" {
  value = aws_cloudfront_distribution.front_door.domain_name
}

output "app_service_public_dns" {
  value = module.app_service.public_dns
}

output "postgres_endpoint" {
  value = module.postgres.db_instance_endpoint
}
