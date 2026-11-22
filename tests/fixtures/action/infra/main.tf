# Terragram — generated from the internal model
# Target: AWS · London (eu-west-2) · Terraform
# 3 module calls and 4 resources from 4 components

terraform {
  required_version = ">= 1.6, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.64"
    }
  }
}

locals {
  tags = merge({ ManagedBy = "terragram", Environment = "dev" }, var.tags)
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.tags
  }
}

resource "aws_wafv2_web_acl" "front_door" {
  provider = aws.us_east_1
  name     = "waf-${var.name_prefix}-front-door"
  scope    = "CLOUDFRONT"

  default_action {
    allow {
    }
  }

  rule {
    name     = "aws-common"
    priority = 1

    override_action {
      none {
      }
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "front-door-aws-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 2

    override_action {
      none {
      }
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "front-door-aws-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "front-door"
    sampled_requests_enabled   = true
  }
}

resource "aws_cloudfront_distribution" "front_door" {
  enabled    = true
  web_acl_id = aws_wafv2_web_acl.front_door.arn

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  origin {
    domain_name = module.app_service.public_dns
    origin_id   = "front_door_to_app_service"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "front_door_to_app_service"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.front_door_security_headers.id

    forwarded_values {
      query_string = false

      cookies {
        forward = "none"
      }
    }
  }
}

data "aws_cloudfront_response_headers_policy" "front_door_security_headers" {
  name = "Managed-SecurityHeadersPolicy"
}

resource "aws_cloudwatch_log_group" "front_door_waf" {
  provider          = aws.us_east_1
  name              = "aws-waf-logs-${var.name_prefix}-front-door"
  retention_in_days = 365
}

resource "aws_wafv2_web_acl_logging_configuration" "front_door" {
  provider                = aws.us_east_1
  resource_arn            = aws_wafv2_web_acl.front_door.arn
  log_destination_configs = [aws_cloudwatch_log_group.front_door_waf.arn]
}

module "app_service" {
  source                      = "terraform-aws-modules/ec2-instance/aws"
  version                     = "6.4.0"
  name                        = "web-${var.name_prefix}-app-service"
  instance_type               = "t3.medium"
  subnet_id                   = var.public_subnet_ids[0]
  associate_public_ip_address = true
  security_group_vpc_id       = var.vpc_id
  security_group_ingress_rules = {
    http = {
      from_port   = 80
      to_port     = 80
      ip_protocol = "tcp"
      cidr_ipv4   = "0.0.0.0/0"
    }
    https = {
      from_port   = 443
      to_port     = 443
      ip_protocol = "tcp"
      cidr_ipv4   = "0.0.0.0/0"
    }
  }
  security_group_egress_rules = {
    all = {
      ip_protocol = "-1"
      cidr_ipv4   = "0.0.0.0/0"
    }
  }
  monitoring = true
  metadata_options = {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }
  root_block_device = {
    encrypted = true
    type      = "gp3"
  }
  create_iam_instance_profile = true
  iam_role_policies = {
    ssm = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
  }
  tags = {
    Name      = "app-service"
    ManagedBy = "terragram"
  }
  depends_on = [module.redis_cache, module.postgres]
}

module "redis_cache" {
  source                     = "terraform-aws-modules/elasticache/aws"
  version                    = "1.11.1"
  replication_group_id       = "redis-${var.name_prefix}-redis-cache"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = "cache.t3.small"
  num_cache_clusters         = 1
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  vpc_id                     = var.vpc_id
  subnet_ids                 = var.private_subnet_ids
}

module "postgres" {
  source                                = "terraform-aws-modules/rds/aws"
  version                               = "7.2.1"
  identifier                            = "pg-${var.name_prefix}-postgres"
  engine                                = "postgres"
  engine_version                        = "16"
  family                                = "postgres16"
  instance_class                        = "db.t3.medium"
  allocated_storage                     = 20
  username                              = var.db_username
  manage_master_user_password           = true
  create_db_option_group                = false
  storage_encrypted                     = true
  iam_database_authentication_enabled   = true
  deletion_protection                   = true
  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  backup_retention_period               = 7
  skip_final_snapshot                   = true
  multi_az                              = false
}
