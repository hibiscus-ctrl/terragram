terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.12"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "europe-west2"
}

resource "google_project" "app" {
  name            = "Orders"
  project_id      = var.project_id
  billing_account = var.billing_account
}

resource "google_compute_network" "main" {
  name                    = "orders"
  project                 = google_project.app.project_id
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "private" {
  name                     = "orders-private"
  project                  = google_project.app.project_id
  region                   = var.region
  network                  = google_compute_network.main.id
  ip_cidr_range            = "10.10.0.0/20"
  private_ip_google_access = true
}

resource "google_dns_managed_zone" "public" {
  name     = "orders"
  project  = google_project.app.project_id
  dns_name = "orders.example.com."
}

resource "google_dns_record_set" "www" {
  name         = "www.${google_dns_managed_zone.public.dns_name}"
  project      = google_project.app.project_id
  managed_zone = google_dns_managed_zone.public.name
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_forwarding_rule.https.ip_address]
}

resource "google_compute_health_check" "api" {
  name    = "orders-api"
  project = google_project.app.project_id

  http_health_check {
    port = 8080
  }
}

resource "google_compute_backend_service" "api" {
  name                  = "orders-api"
  project               = google_project.app.project_id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  health_checks         = [google_compute_health_check.api.id]
}

resource "google_compute_url_map" "api" {
  name            = "orders-api"
  project         = google_project.app.project_id
  default_service = google_compute_backend_service.api.id
}

resource "google_compute_target_https_proxy" "api" {
  name             = "orders-api"
  project          = google_project.app.project_id
  url_map          = google_compute_url_map.api.id
  ssl_certificates = [var.certificate_id]
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "orders-https"
  project               = google_project.app.project_id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  port_range            = "443"
  target                = google_compute_target_https_proxy.api.id
}

resource "google_service_account" "api" {
  account_id   = "orders-api"
  project      = google_project.app.project_id
  display_name = "Orders API"
}

resource "google_service_account" "worker" {
  account_id   = "orders-worker"
  project      = google_project.app.project_id
  display_name = "Orders worker"
}

resource "google_cloud_run_v2_service" "api" {
  name     = "orders-api"
  project  = google_project.app.project_id
  location = var.region

  template {
    service_account = google_service_account.api.email

    containers {
      image = "europe-west2-docker.pkg.dev/${var.project_id}/orders/api:latest"

      env {
        name  = "DB_CONNECTION"
        value = google_sql_database_instance.orders.connection_name
      }
      env {
        name  = "EVENTS_TOPIC"
        value = google_pubsub_topic.events.id
      }
      env {
        name = "SESSION_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.session.secret_id
            version = "latest"
          }
        }
      }
    }

    vpc_access {
      network_interfaces {
        network    = google_compute_network.main.id
        subnetwork = google_compute_subnetwork.private.id
      }
    }
  }
}

resource "google_cloudfunctions2_function" "resize" {
  name     = "resize-images"
  project  = google_project.app.project_id
  location = var.region

  build_config {
    runtime     = "python312"
    entry_point = "resize"
    source {
      storage_source {
        bucket = google_storage_bucket.source.name
        object = "resize.zip"
      }
    }
  }

  service_config {
    service_account_email = google_service_account.worker.email
    environment_variables = {
      UPLOADS = google_storage_bucket.uploads.name
    }
  }

  event_trigger {
    event_type   = "google.cloud.storage.object.v1.finalized"
    pubsub_topic = google_pubsub_topic.events.id
  }
}

resource "google_container_cluster" "batch" {
  name             = "orders-batch"
  project          = google_project.app.project_id
  location         = var.region
  network          = google_compute_network.main.id
  subnetwork       = google_compute_subnetwork.private.id
  enable_autopilot = true
}

resource "google_container_node_pool" "batch" {
  name     = "batch"
  project  = google_project.app.project_id
  cluster  = google_container_cluster.batch.id
  location = var.region

  node_config {
    service_account = google_service_account.worker.email
  }
}

resource "google_compute_instance" "bastion" {
  name         = "orders-bastion"
  project      = google_project.app.project_id
  zone         = "${var.region}-a"
  machine_type = "e2-small"

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.private.id
  }

  service_account {
    email  = google_service_account.worker.email
    scopes = ["cloud-platform"]
  }
}

resource "google_sql_database_instance" "orders" {
  name             = "orders"
  project          = google_project.app.project_id
  region           = var.region
  database_version = "POSTGRES_16"

  settings {
    tier = "db-custom-2-7680"
  }
}

resource "google_redis_instance" "sessions" {
  name               = "sessions"
  project            = google_project.app.project_id
  region             = var.region
  memory_size_gb     = 1
  authorized_network = google_compute_network.main.id
}

resource "google_storage_bucket" "uploads" {
  name                        = "${var.project_id}-uploads"
  project                     = google_project.app.project_id
  location                    = "EUROPE-WEST2"
  uniform_bucket_level_access = true
}

resource "google_storage_bucket" "source" {
  name                        = "${var.project_id}-function-source"
  project                     = google_project.app.project_id
  location                    = "EUROPE-WEST2"
  uniform_bucket_level_access = true
}

resource "google_storage_bucket" "site" {
  name                        = "${var.project_id}-site"
  project                     = google_project.app.project_id
  location                    = "EUROPE-WEST2"
  uniform_bucket_level_access = true

  website {
    main_page_suffix = "index.html"
  }
}

resource "google_pubsub_topic" "events" {
  name    = "orders-events"
  project = google_project.app.project_id
}

resource "google_pubsub_subscription" "events" {
  name    = "orders-events-worker"
  project = google_project.app.project_id
  topic   = google_pubsub_topic.events.id
}

resource "google_secret_manager_secret" "session" {
  secret_id = "session-key"
  project   = google_project.app.project_id

  replication {
    auto {}
  }
}

resource "google_kms_key_ring" "orders" {
  name     = "orders"
  project  = google_project.app.project_id
  location = var.region
}

resource "google_kms_crypto_key" "data" {
  name     = "data"
  key_ring = google_kms_key_ring.orders.id
}

resource "google_bigquery_dataset" "analytics" {
  dataset_id = "orders_analytics"
  project    = google_project.app.project_id
  location   = "europe-west2"
}

resource "google_monitoring_alert_policy" "errors" {
  display_name = "Orders API errors"
  project      = google_project.app.project_id
  combiner     = "OR"

  conditions {
    display_name = "5xx rate"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "300s"
    }
  }
}
