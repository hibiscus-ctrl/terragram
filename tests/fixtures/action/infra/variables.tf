variable "db_username" {
  type        = string
  description = "Administrator login for the managed database."
  default     = "app"
}

variable "name_prefix" {
  type        = string
  description = "Short prefix applied to every resource name."
  default     = "infra-prod"
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnets (two or more) for tasks, caches and databases."
}

variable "public_subnet_ids" {
  type        = list(string)
  description = "Public subnets (two or more) for the load balancer and any public instance."
}

variable "region" {
  type        = string
  description = "AWS region every resource is created in."
  default     = "eu-west-2"
}

variable "tags" {
  type        = map(string)
  description = "Tags added to every resource — Owner and CostCentre are what a reviewer asks for first. Merged over the plan's own tags, so a key set here wins."
  default     = {}
}

variable "vpc_id" {
  type        = string
  description = "VPC the resources are placed in. Add a Virtual Network to the model to generate one."
}
