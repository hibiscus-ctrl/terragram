variable "alert_email" {
  type        = string
  description = "Address the plan's alert policy emails when error logs appear."
}

variable "billing_account" {
  type        = string
  description = "Billing account the project is billed to, such as 012345-6789AB-CDEF01."
}

variable "gke_authorized_cidr" {
  type        = string
  description = "CIDR block allowed to reach the cluster's control plane: your office or VPN range."

  validation {
    condition     = can(cidrhost(var.gke_authorized_cidr, 0)) && try(tonumber(split("/", var.gke_authorized_cidr)[1]) >= 24, false) && !startswith(var.gke_authorized_cidr, "0.")
    error_message = "Give a CIDR block of a /24 or narrower that is not 0.0.0.0/x: the control plane is reachable from nowhere else."
  }
}

variable "kubernetes_master_cidr" {
  type        = string
  description = "The /28 of private address space the kubernetes control plane takes. It must not overlap the network or another cluster's range."
  default     = "172.16.0.0/28"

  validation {
    condition     = can(cidrhost(var.kubernetes_master_cidr, 0)) && endswith(var.kubernetes_master_cidr, "/28") && can(regex("^(10|172\\.(1[6-9]|2[0-9]|3[01])|192\\.168)\\.", var.kubernetes_master_cidr))
    error_message = "Give a /28 inside 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16."
  }
}

variable "labels" {
  type        = map(string)
  description = "Labels added to every resource — owner and cost_centre are what a reviewer asks for first. Merged over the plan's own labels, so a key set here wins. Keys start with a lowercase letter; keys and values are lowercase letters, digits, hyphens and underscores, at most 63 characters each."
  default     = {}

  validation {
    condition     = alltrue([for k, v in var.labels : can(regex("^[a-z][a-z0-9_-]{0,62}$", k)) && can(regex("^[a-z0-9_-]{0,63}$", v))])
    error_message = "Label keys start with a lowercase letter; keys and values hold only lowercase letters, digits, hyphens and underscores, and are at most 63 characters (a value may be empty)."
  }
}

variable "name_prefix" {
  type        = string
  description = "Short prefix applied to every resource name: 1 to 20 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen."
  default     = "infra-prod"

  validation {
    condition     = can(regex("^[a-z]([a-z0-9-]{0,18}[a-z0-9])?$", var.name_prefix))
    error_message = "Use 1 to 20 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen."
  }
}

variable "org_id" {
  type        = string
  description = "Organisation the project is created in; leave null for a project with no organisation."
  default     = null
}

variable "origin_domain_name" {
  type        = string
  description = "Hostname the load balancer sends traffic to: nothing in the model sits behind it yet."
  default     = "example.com"
}

variable "project_id" {
  type        = string
  description = "ID of the project every resource is created in."
}

variable "region" {
  type        = string
  description = "Google Cloud region every resource is created in."
  default     = "europe-west2"
}
