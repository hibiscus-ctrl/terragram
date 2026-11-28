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
}

variable "labels" {
  type        = map(string)
  description = "Labels added to every resource — owner and cost_centre are what a reviewer asks for first. Merged over the plan's own labels, so a key set here wins. Keys and values are lowercase letters, digits, hyphens and underscores."
  default     = {}
}

variable "name_prefix" {
  type        = string
  description = "Short prefix applied to every resource name."
  default     = "infra-prod"
}

variable "org_id" {
  type        = string
  description = "Organisation the project is created in; leave null for a project with no organisation."
  default     = null
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
