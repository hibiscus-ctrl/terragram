variable "db_password" {
  type        = string
  description = "Administrator password. Supply it from your secret store at plan time, never in VCS."
  sensitive   = true
}

variable "db_username" {
  type        = string
  description = "Administrator login for the managed database."
  default     = "app"
}

variable "location" {
  type        = string
  description = "Azure region every resource is created in."
  default     = "uksouth"
}

variable "name_prefix" {
  type        = string
  description = "Short prefix applied to every resource name."
  default     = "infra-prod"
}

variable "tags" {
  type        = map(string)
  description = "Tags added to every resource — Owner and CostCentre are what a reviewer asks for first. Merged over the plan's own tags, so a key set here wins."
  default     = {}
}
