# Generated from the diagram model
# Target: Google Cloud · London (europe-west2) · Terraform
# 0 module calls and 73 resources from 19 components
#
# Before you apply: www.orders.example.com is served over HTTPS on a certificate validated through
# the orders.example.com zone this plan creates, which works only once the zone is delegated.
# Create the zone first (terraform apply -target=google_dns_managed_zone.dns), set the domain's
# name servers at your registrar to the dns_name_servers output, then apply the rest.
# Until the zone is delegated, Google cannot provision the managed certificate, and the name does not serve HTTPS.

terraform {
  required_version = ">= 1.6, < 2.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.12"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.8"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 8.12"
    }
  }
}

locals {
  labels = merge({ managed_by = "diagram", environment = "dev" }, var.labels)
}

provider "google" {
  project        = var.project_id
  region         = var.region
  default_labels = local.labels
}

provider "google-beta" {
  project        = var.project_id
  region         = var.region
  default_labels = local.labels
}

resource "google_project" "project" {
  name                = var.project_id
  project_id          = var.project_id
  org_id              = var.org_id
  billing_account     = var.billing_account
  auto_create_network = false
}

resource "google_project_iam_audit_config" "project" {
  project = google_project.project.project_id
  service = "allServices"

  audit_log_config {
    log_type = "ADMIN_READ"
  }

  audit_log_config {
    log_type = "DATA_READ"
  }

  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

resource "google_compute_network" "vnet" {
  name                    = "vpc-${var.name_prefix}-vnet"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
  depends_on              = [google_project_service.enabled]
}

resource "google_compute_subnetwork" "vnet" {
  name                     = "subnet-${var.name_prefix}-vnet"
  network                  = google_compute_network.vnet.id
  region                   = var.region
  ip_cidr_range            = cidrsubnet("10.0.0.0/16", 8, 1)
  private_ip_google_access = true

  log_config {
    aggregation_interval = "INTERVAL_5_SEC"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

resource "google_compute_router" "vnet" {
  name    = "router-${var.name_prefix}-vnet"
  network = google_compute_network.vnet.id
  region  = var.region
}

resource "google_compute_router_nat" "vnet" {
  name                               = "nat-${var.name_prefix}-vnet"
  router                             = google_compute_router.vnet.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

resource "google_compute_firewall" "vnet_internal" {
  name          = "allow-internal-${var.name_prefix}-vnet"
  network       = google_compute_network.vnet.name
  direction     = "INGRESS"
  source_ranges = [google_compute_subnetwork.vnet.ip_cidr_range]

  allow {
    protocol = "tcp"
  }

  allow {
    protocol = "udp"
  }

  allow {
    protocol = "icmp"
  }

  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}

resource "google_compute_firewall" "vnet_iap_ssh" {
  name          = "allow-iap-ssh-${var.name_prefix}-vnet"
  network       = google_compute_network.vnet.name
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}

resource "google_dns_managed_zone" "dns" {
  name          = "zone-${var.name_prefix}-dns"
  dns_name      = "orders.example.com."
  visibility    = "public"
  force_destroy = false
  depends_on    = [google_project_service.enabled]

  dnssec_config {
    state = "on"
  }

  cloud_logging_config {
    enable_logging = true
  }
}

resource "google_compute_global_forwarding_rule" "load_balancer" {
  name                  = "lb-http-${var.name_prefix}-load-balancer"
  target                = google_compute_target_http_proxy.load_balancer.id
  ip_address            = google_compute_global_address.load_balancer.id
  port_range            = "80"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

resource "google_compute_url_map" "load_balancer" {
  name       = "lb-${var.name_prefix}-load-balancer"
  depends_on = [google_project_service.enabled]

  default_url_redirect {
    host_redirect          = var.origin_domain_name
    https_redirect         = true
    strip_query            = false
    redirect_response_code = "TEMPORARY_REDIRECT"
  }
}

resource "google_compute_target_http_proxy" "load_balancer" {
  name       = "lb-http-${var.name_prefix}-load-balancer"
  url_map    = google_compute_url_map.load_balancer_redirect.id
  depends_on = [google_project_service.enabled]
}

resource "google_compute_global_address" "load_balancer" {
  name       = "lb-${var.name_prefix}-load-balancer"
  ip_version = "IPV4"
  depends_on = [google_project_service.enabled]
}

resource "google_service_account" "entra_id" {
  account_id   = trim(substr("sa-${var.name_prefix}-entra-id", 0, 30), "-")
  display_name = "Identity for entra-id"
  depends_on   = [google_project_service.enabled]
}

resource "google_service_account" "entra_id_2" {
  account_id   = trim(substr("sa-${var.name_prefix}-entra-id-2", 0, 30), "-")
  display_name = "Identity for entra-id-2"
  depends_on   = [google_project_service.enabled]
}

resource "google_cloud_run_v2_service" "containers" {
  name                = "svc-${var.name_prefix}-containers"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account       = google_service_account.containers.email
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

    scaling {
      min_instance_count = 1
      max_instance_count = 10
    }

    containers {
      image = "us-docker.pkg.dev/cloudrun/container/hello"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1000m"
          memory = "1Gi"
        }
      }

      env {
        name  = "SERVICE_ACCOUNT"
        value = google_service_account.entra_id.email
      }

      env {
        name  = "DATABASE_HOST"
        value = google_sql_database_instance.postgres.private_ip_address
      }

      env {
        name  = "PUBSUB_TOPIC"
        value = google_pubsub_topic.queue.id
      }

      env {
        name  = "SECRET_ID"
        value = google_secret_manager_secret.key_vault.id
      }

      env {
        name  = "VPC_ID"
        value = google_compute_network.vnet.id
      }
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"

      network_interfaces {
        network    = google_compute_network.vnet.id
        subnetwork = google_compute_subnetwork.vnet.id
      }
    }
  }
}

resource "google_service_account" "containers" {
  account_id   = trim(substr("sa-${var.name_prefix}-containers", 0, 30), "-")
  display_name = "Runs the containers service"
  depends_on   = [google_project_service.enabled]
}

resource "google_project_iam_member" "containers_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.containers.email}"
}

resource "google_cloudfunctions2_function" "functions" {
  name     = "fn-${var.name_prefix}-functions"
  location = var.region

  build_config {
    runtime     = "python312"
    entry_point = "handler"

    source {
      storage_source {
        bucket = google_storage_bucket.functions_source.name
        object = google_storage_bucket_object.functions_source.name
      }
    }
  }

  service_config {
    available_memory      = "256M"
    timeout_seconds       = 60
    max_instance_count    = 10
    ingress_settings      = "ALLOW_INTERNAL_AND_GCLB"
    service_account_email = google_service_account.functions.email
    environment_variables = {
      STORAGE_BUCKET  = google_storage_bucket.object_storage_2.name
      SERVICE_ACCOUNT = google_service_account.entra_id_2.email
      PUBSUB_TOPIC    = google_pubsub_topic.queue.id
    }
  }
}

resource "google_service_account" "functions" {
  account_id   = trim(substr("sa-${var.name_prefix}-functions", 0, 30), "-")
  display_name = "Runs the functions function"
  depends_on   = [google_project_service.enabled]
}

resource "google_project_iam_member" "functions_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.functions.email}"
}

data "archive_file" "functions" {
  type        = "zip"
  source_dir  = "${path.module}/src/functions"
  output_path = "${path.module}/.terraform/functions.zip"
}

resource "google_storage_bucket" "functions_source" {
  name                        = "${var.project_id}-src-${var.name_prefix}-functions"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
  labels = {
    purpose = "function-source"
  }

  versioning {
    enabled = true
  }

  logging {
    log_bucket        = google_storage_bucket.functions_source_logs.name
    log_object_prefix = "access/"
  }
}

resource "google_storage_bucket" "functions_source_logs" {
  name                        = "${var.project_id}-logs-${var.name_prefix}-functions"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
  labels = {
    purpose = "access-logs"
  }
  depends_on = [google_project_service.enabled]

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      age = 365
    }

    action {
      type = "Delete"
    }
  }
}

resource "google_storage_bucket_iam_member" "functions_source_logs_delivery" {
  bucket = google_storage_bucket.functions_source_logs.name
  role   = "roles/storage.objectCreator"
  member = "group:cloud-storage-analytics@google.com"
}

resource "google_storage_bucket_object" "functions_source" {
  name   = "${data.archive_file.functions.output_md5}.zip"
  bucket = google_storage_bucket.functions_source.name
  source = data.archive_file.functions.output_path
}

resource "google_container_cluster" "kubernetes" {
  name                        = "gke-${var.name_prefix}-kubernetes"
  location                    = "${var.region}-a"
  network                     = google_compute_network.vnet.id
  subnetwork                  = google_compute_subnetwork.vnet.id
  networking_mode             = "VPC_NATIVE"
  initial_node_count          = 0
  enable_shielded_nodes       = true
  enable_intranode_visibility = true
  enable_legacy_abac          = false
  deletion_protection         = false
  resource_labels             = local.labels
  depends_on                  = [google_compute_network.vnet, google_service_account.entra_id_2, google_project_service.enabled]

  ip_allocation_policy {
  }

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }

  master_authorized_networks_config {
    cidr_blocks {
      cidr_block   = var.gke_authorized_cidr
      display_name = "administrators"
    }
  }

  master_auth {
    client_certificate_config {
      issue_client_certificate = false
    }
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  release_channel {
    channel = "REGULAR"
  }

  network_policy {
    enabled  = true
    provider = "CALICO"
  }

  addons_config {
    network_policy_config {
      disabled = false
    }
  }

  binary_authorization {
    evaluation_mode = "PROJECT_SINGLETON_POLICY_ENFORCE"
  }
}

resource "google_container_node_pool" "kubernetes_nodes" {
  name       = "default"
  cluster    = google_container_cluster.kubernetes.id
  location   = "${var.region}-a"
  node_count = 1

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type    = "e2-standard-2"
    image_type      = "COS_CONTAINERD"
    service_account = google_service_account.kubernetes_nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    metadata = {
      disable-legacy-endpoints = "true"
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }
  }
}

resource "google_service_account" "kubernetes_nodes" {
  account_id   = trim(substr("sa-${var.name_prefix}-kubernetes-nodes", 0, 30), "-")
  display_name = "Runs the kubernetes cluster's nodes"
  depends_on   = [google_project_service.enabled]
}

resource "google_project_iam_member" "kubernetes_nodes_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.kubernetes_nodes.email}"
}

resource "google_project_iam_member" "kubernetes_nodes_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.kubernetes_nodes.email}"
}

resource "google_project_iam_member" "kubernetes_nodes_monitoring_viewer" {
  project = var.project_id
  role    = "roles/monitoring.viewer"
  member  = "serviceAccount:${google_service_account.kubernetes_nodes.email}"
}

resource "google_project_iam_member" "kubernetes_nodes_artifact_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.kubernetes_nodes.email}"
}

resource "google_compute_instance" "virtual_machine" {
  name           = "vm-${var.name_prefix}-virtual-machine"
  machine_type   = "e2-medium"
  zone           = "${var.region}-a"
  can_ip_forward = false
  metadata = {
    block-project-ssh-keys = "true"
    enable-oslogin         = "TRUE"
    serial-port-enable     = "false"
  }
  depends_on = [google_compute_network.vnet, google_service_account.entra_id_2]

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 20
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.vnet.id
  }

  service_account {
    email  = google_service_account.virtual_machine.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
}

resource "google_service_account" "virtual_machine" {
  account_id   = trim(substr("sa-${var.name_prefix}-virtual-machine", 0, 30), "-")
  display_name = "Runs the virtual-machine instance"
  depends_on   = [google_project_service.enabled]
}

resource "google_project_iam_member" "virtual_machine_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.virtual_machine.email}"
}

resource "google_project_iam_member" "virtual_machine_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.virtual_machine.email}"
}

resource "google_sql_database_instance" "postgres" {
  name                = "pg-${var.name_prefix}-postgres"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = true
  depends_on          = [google_service_networking_connection.private_services, google_project_service.enabled]

  settings {
    tier                        = "db-custom-1-3840"
    edition                     = "ENTERPRISE"
    availability_type           = "ZONAL"
    disk_type                   = "PD_SSD"
    disk_autoresize             = true
    deletion_protection_enabled = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vnet.id
      ssl_mode        = "TRUSTED_CLIENT_CERTIFICATE_REQUIRED"
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = true

      backup_retention_settings {
        retained_backups = 7
      }
    }

    insights_config {
      query_insights_enabled = true
    }

    maintenance_window {
      day  = 7
      hour = 3
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    database_flags {
      name  = "log_checkpoints"
      value = "on"
    }

    database_flags {
      name  = "log_connections"
      value = "on"
    }

    database_flags {
      name  = "log_disconnections"
      value = "on"
    }

    database_flags {
      name  = "log_lock_waits"
      value = "on"
    }

    database_flags {
      name  = "log_min_messages"
      value = "error"
    }

    database_flags {
      name  = "log_temp_files"
      value = "0"
    }

    database_flags {
      name  = "log_min_duration_statement"
      value = "-1"
    }

    database_flags {
      name  = "log_min_error_statement"
      value = "error"
    }

    database_flags {
      name  = "log_hostname"
      value = "on"
    }

    database_flags {
      name  = "log_duration"
      value = "on"
    }

    database_flags {
      name  = "log_statement"
      value = "ddl"
    }

    database_flags {
      name  = "cloudsql.enable_pgaudit"
      value = "on"
    }

    database_flags {
      name  = "pgaudit.log"
      value = "ddl,write"
    }
  }
}

resource "google_service_account" "postgres_app" {
  account_id   = trim(substr("sa-${var.name_prefix}-postgres-app", 0, 30), "-")
  display_name = "Connects to the postgres database with IAM authentication"
  depends_on   = [google_project_service.enabled]
}

resource "google_project_iam_member" "postgres_app_instance_user" {
  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "serviceAccount:${google_service_account.postgres_app.email}"
}

resource "google_project_iam_member" "postgres_app_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.postgres_app.email}"
}

resource "google_sql_database" "postgres" {
  name     = "app"
  instance = google_sql_database_instance.postgres.name
}

resource "google_sql_user" "postgres" {
  name     = trimsuffix(google_service_account.postgres_app.email, ".gserviceaccount.com")
  instance = google_sql_database_instance.postgres.name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

resource "google_redis_instance" "redis_cache" {
  name                    = "redis-${var.name_prefix}-redis-cache"
  region                  = var.region
  tier                    = "STANDARD_HA"
  memory_size_gb          = 1
  redis_version           = "REDIS_7_2"
  authorized_network      = google_compute_network.vnet.id
  connect_mode            = "PRIVATE_SERVICE_ACCESS"
  auth_enabled            = true
  transit_encryption_mode = "SERVER_AUTHENTICATION"
  depends_on              = [google_service_networking_connection.private_services, google_compute_network.vnet, google_project_service.enabled]
}

resource "google_storage_bucket" "object_storage" {
  name                        = "${var.project_id}-data-${var.name_prefix}-object-storage"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true

  versioning {
    enabled = true
  }

  logging {
    log_bucket        = google_storage_bucket.object_storage_logs.name
    log_object_prefix = "access/"
  }
}

resource "google_storage_bucket" "object_storage_logs" {
  name                        = "${var.project_id}-logs-${var.name_prefix}-object-storage"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
  labels = {
    purpose = "access-logs"
  }
  depends_on = [google_project_service.enabled]

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      age = 365
    }

    action {
      type = "Delete"
    }
  }
}

resource "google_storage_bucket_iam_member" "object_storage_logs_delivery" {
  bucket = google_storage_bucket.object_storage_logs.name
  role   = "roles/storage.objectCreator"
  member = "group:cloud-storage-analytics@google.com"
}

resource "google_storage_bucket" "object_storage_2" {
  name                        = "${var.project_id}-data-${var.name_prefix}-object-storage-2"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true

  versioning {
    enabled = true
  }

  logging {
    log_bucket        = google_storage_bucket.object_storage_2_logs.name
    log_object_prefix = "access/"
  }
}

resource "google_storage_bucket" "object_storage_2_logs" {
  name                        = "${var.project_id}-logs-${var.name_prefix}-object-storage-2"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
  labels = {
    purpose = "access-logs"
  }
  depends_on = [google_project_service.enabled]

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      age = 365
    }

    action {
      type = "Delete"
    }
  }
}

resource "google_storage_bucket_iam_member" "object_storage_2_logs_delivery" {
  bucket = google_storage_bucket.object_storage_2_logs.name
  role   = "roles/storage.objectCreator"
  member = "group:cloud-storage-analytics@google.com"
}

resource "google_storage_bucket" "static_site" {
  name                        = "${var.project_id}-site-${var.name_prefix}-static-site"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true

  versioning {
    enabled = true
  }

  logging {
    log_bucket        = google_storage_bucket.static_site_logs.name
    log_object_prefix = "access/"
  }

  website {
    main_page_suffix = "index.html"
    not_found_page   = "error.html"
  }
}

resource "google_storage_bucket" "static_site_logs" {
  name                        = "${var.project_id}-logs-${var.name_prefix}-static-site"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
  labels = {
    purpose = "access-logs"
  }
  depends_on = [google_project_service.enabled]

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      age = 365
    }

    action {
      type = "Delete"
    }
  }
}

resource "google_storage_bucket_iam_member" "static_site_logs_delivery" {
  bucket = google_storage_bucket.static_site_logs.name
  role   = "roles/storage.objectCreator"
  member = "group:cloud-storage-analytics@google.com"
}

resource "google_pubsub_topic" "queue" {
  name                       = "topic-${var.name_prefix}-queue"
  message_retention_duration = "604800s"
  depends_on                 = [google_project_service.enabled]
}

resource "google_pubsub_topic" "queue_dead_letter" {
  name                       = "dlq-${var.name_prefix}-queue"
  message_retention_duration = "604800s"
  depends_on                 = [google_project_service.enabled]
}

resource "google_pubsub_subscription" "queue" {
  name                         = "sub-${var.name_prefix}-queue"
  topic                        = google_pubsub_topic.queue.id
  ack_deadline_seconds         = 30
  message_retention_duration   = "604800s"
  enable_message_ordering      = false
  enable_exactly_once_delivery = false

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.queue_dead_letter.id
    max_delivery_attempts = 5
  }

  expiration_policy {
    ttl = ""
  }
}

resource "google_secret_manager_secret" "key_vault" {
  secret_id = "secret-${var.name_prefix}-key-vault"

  replication {
    user_managed {
      replicas {
        location = var.region

        customer_managed_encryption {
          kms_key_name = google_kms_crypto_key.key_vault.id
        }
      }
    }
  }
}

resource "google_kms_key_ring" "key_vault" {
  name       = "keyring-${var.name_prefix}-key-vault"
  location   = var.region
  depends_on = [google_project_service.enabled]
}

resource "google_kms_crypto_key" "key_vault" {
  name            = "key-${var.name_prefix}-key-vault"
  key_ring        = google_kms_key_ring.key_vault.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "7776000s"

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }
}

resource "google_project_service_identity" "key_vault_secretmanager" {
  provider   = google-beta
  service    = "secretmanager.googleapis.com"
  depends_on = [google_project_service.enabled]
}

resource "google_kms_crypto_key_iam_member" "key_vault" {
  crypto_key_id = google_kms_crypto_key.key_vault.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_project_service_identity.key_vault_secretmanager.email}"
}

resource "google_bigquery_dataset" "data_warehouse" {
  dataset_id                 = replace("dw-${var.name_prefix}-data-warehouse", "-", "_")
  location                   = var.region
  delete_contents_on_destroy = true
  depends_on                 = [google_project_service.enabled]
}

resource "google_monitoring_notification_channel" "monitoring" {
  display_name = "alerts-${var.name_prefix}-monitoring"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
  depends_on = [google_project_service.enabled]
}

resource "google_monitoring_alert_policy" "monitoring" {
  display_name          = "errors-${var.name_prefix}-monitoring"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.monitoring.id]

  conditions {
    display_name = "Error logs"

    condition_matched_log {
      filter = "severity>=ERROR"
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
  }
}

resource "google_logging_project_bucket_config" "monitoring" {
  project        = var.project_id
  location       = "global"
  bucket_id      = "_Default"
  retention_days = 30
  depends_on     = [google_project_service.enabled]
}

resource "google_project_service" "enabled" {
  for_each           = toset(["artifactregistry.googleapis.com", "bigquery.googleapis.com", "cloudbuild.googleapis.com", "cloudfunctions.googleapis.com", "cloudkms.googleapis.com", "cloudresourcemanager.googleapis.com", "compute.googleapis.com", "container.googleapis.com", "dns.googleapis.com", "iam.googleapis.com", "logging.googleapis.com", "monitoring.googleapis.com", "pubsub.googleapis.com", "redis.googleapis.com", "run.googleapis.com", "secretmanager.googleapis.com", "servicenetworking.googleapis.com", "serviceusage.googleapis.com", "sqladmin.googleapis.com", "storage.googleapis.com"])
  project            = google_project.project.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_compute_global_address" "private_services" {
  name          = "private-services-${var.name_prefix}-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.vnet.id
  depends_on    = [google_project_service.enabled]
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.vnet.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
  deletion_policy         = "ABANDON"
}

resource "google_dns_record_set" "dns_to_load_balancer" {
  managed_zone = google_dns_managed_zone.dns.name
  name         = "www.${google_dns_managed_zone.dns.dns_name}"
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.load_balancer.address]
}

resource "google_compute_url_map" "load_balancer_redirect" {
  name = "lb-redirect-${var.name_prefix}-load-balancer"

  default_url_redirect {
    https_redirect         = true
    strip_query            = false
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
  }
}

resource "google_compute_managed_ssl_certificate" "dns_to_load_balancer" {
  name = "lb-cert-${var.name_prefix}-load-balancer"

  managed {
    domains = ["www.orders.example.com"]
  }
}

resource "google_compute_ssl_policy" "load_balancer" {
  name            = "lb-tls-${var.name_prefix}-load-balancer"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

resource "google_compute_target_https_proxy" "load_balancer" {
  name             = "lb-https-${var.name_prefix}-load-balancer"
  url_map          = google_compute_url_map.load_balancer.id
  ssl_certificates = [google_compute_managed_ssl_certificate.dns_to_load_balancer.id]
  ssl_policy       = google_compute_ssl_policy.load_balancer.id
}

resource "google_compute_global_forwarding_rule" "load_balancer_https" {
  name                  = "lb-https-${var.name_prefix}-load-balancer"
  target                = google_compute_target_https_proxy.load_balancer.id
  ip_address            = google_compute_global_address.load_balancer.id
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}
