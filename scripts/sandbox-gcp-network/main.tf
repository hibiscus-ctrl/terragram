# The network the Cloud SQL and Memorystore plan (gcp-data) is placed in: it takes
# network_id and subnetwork_id as variables, and the sandbox project holds no network
# of its own. Applied and destroyed with that plan by scripts/sandbox-gcp.sh, never alone.

terraform {
  required_version = ">= 1.6, < 2.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.12"
    }
  }
}

variable "project_id" {
  type        = string
  description = "The sandbox project."
}

variable "region" {
  type        = string
  description = "The subnetwork's region."
}

variable "name" {
  type        = string
  description = "The network's and subnetwork's name, which the sandbox sweep finds them by (ih-sbx-tg-)."

  validation {
    condition     = startswith(var.name, "ih-sbx-tg-")
    error_message = "A name the sandbox sweep does not find would be left behind."
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_compute_network" "sandbox" {
  name                    = var.name
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "sandbox" {
  name                     = var.name
  network                  = google_compute_network.sandbox.id
  region                   = var.region
  ip_cidr_range            = "10.20.0.0/24"
  private_ip_google_access = true
}

output "network_id" {
  value = google_compute_network.sandbox.id
}

output "subnetwork_id" {
  value = google_compute_subnetwork.sandbox.id
}
