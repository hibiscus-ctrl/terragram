// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which cloud service a Terraform resource type belongs to: a stable service id (`aws.rds`, `azure.sql`,
 * `gcp.gke`), a name to show and a coarse category. The Services level merges the resources of one service
 * into one card, the cards take their colour and glyph from the category, and a web app maps the service id
 * to the icon it draws (the engine itself ships no vendor art; see {@link IconResolver}).
 *
 * The table is this project's own work: written from the Terraform provider's resource type names and the
 * clouds' own service names, with no copy of any other mapping. It is data, in one list per cloud. Each row is
 * a service id, its name, its category and the types it covers: an exact type, or a prefix ending in `*`. The
 * longest matching prefix wins, and an exact type beats any prefix, so a narrow rule (`aws_route53_resolver_*`)
 * can sit inside a wide one (`aws_route53_*`).
 *
 * A type the table does not know falls back to its provider plus a category read off the words of the type
 * (`aws.data`, `gcp.network`, `other.compute`), and says so (`known: false`). `tests/graph-services.test.ts` holds
 * every type infraharvest's catalogue can import to a row of this table.
 */

export const GRAPH_CATEGORIES = ["network", "compute", "storage", "identity", "data", "other"] as const;
export type GraphCategory = (typeof GRAPH_CATEGORIES)[number];

export type ServiceInfo = {
  /** `<cloud>.<service>`: `aws.rds`, `azure.sql`, `gcp.gke`. A fallback is `<cloud>.<category>`. */
  id: string;
  /** The name to show: `RDS`, `SQL Database`, `GKE`. */
  label: string;
  category: GraphCategory;
  /** False when no row of the table covers the type, so the service is only its provider and category. */
  known: boolean;
};

type Row = readonly [id: string, label: string, category: GraphCategory, types: readonly string[]];

const AWS: readonly Row[] = [
  // Networking and content delivery.
  ["aws.vpc", "VPC", "network", ["aws_vpc", "aws_vpc_*", "aws_subnet", "aws_subnet_*", "aws_route", "aws_route_table*", "aws_main_route_table_association", "aws_internet_gateway*", "aws_egress_only_internet_gateway", "aws_nat_gateway*", "aws_eip*", "aws_network_acl*", "aws_network_interface*", "aws_default_*", "aws_flow_log", "aws_ec2_managed_prefix_list*", "aws_ec2_network_insights_*", "aws_ec2_subnet_cidr_reservation", "aws_ec2_local_gateway*", "aws_ec2_traffic_mirror_*", "aws_vpc_peering_*"]],
  ["aws.securitygroup", "Security group", "network", ["aws_security_group*", "aws_vpc_security_group_*", "aws_default_security_group"]],
  ["aws.privatelink", "PrivateLink", "network", ["aws_vpc_endpoint*"]],
  ["aws.transitgateway", "Transit Gateway", "network", ["aws_ec2_transit_gateway*"]],
  ["aws.vpn", "Site-to-Site VPN", "network", ["aws_vpn_*", "aws_customer_gateway", "aws_ec2_client_vpn_*"]],
  ["aws.directconnect", "Direct Connect", "network", ["aws_dx_*"]],
  ["aws.route53", "Route 53", "network", ["aws_route53_*"]],
  ["aws.route53resolver", "Route 53 Resolver", "network", ["aws_route53_resolver_*"]],
  ["aws.cloudfront", "CloudFront", "network", ["aws_cloudfront_*"]],
  ["aws.elb", "Load Balancing", "network", ["aws_lb", "aws_lb_*", "aws_alb", "aws_alb_*", "aws_elb", "aws_elb_*", "aws_load_balancer_*", "aws_proxy_protocol_policy", "aws_app_cookie_stickiness_policy", "aws_lb_cookie_stickiness_policy"]],
  ["aws.apigateway", "API Gateway", "network", ["aws_api_gateway_*", "aws_apigatewayv2_*"]],
  ["aws.appsync", "AppSync", "network", ["aws_appsync_*"]],
  ["aws.globalaccelerator", "Global Accelerator", "network", ["aws_globalaccelerator_*"]],
  ["aws.networkfirewall", "Network Firewall", "network", ["aws_networkfirewall_*"]],
  ["aws.cloudmap", "Cloud Map", "network", ["aws_service_discovery_*"]],
  ["aws.vpclattice", "VPC Lattice", "network", ["aws_vpclattice_*"]],
  ["aws.appmesh", "App Mesh", "network", ["aws_appmesh_*"]],
  // Compute and containers.
  ["aws.ec2", "EC2", "compute", ["aws_instance", "aws_launch_template", "aws_launch_configuration", "aws_placement_group", "aws_ec2_*", "aws_key_pair", "aws_ami", "aws_ami_*", "aws_spot_*", "aws_imagebuilder_*"]],
  ["aws.autoscaling", "Auto Scaling", "compute", ["aws_autoscaling_*", "aws_appautoscaling_*"]],
  ["aws.lambda", "Lambda", "compute", ["aws_lambda_*"]],
  ["aws.ecs", "ECS", "compute", ["aws_ecs_*"]],
  ["aws.eks", "EKS", "compute", ["aws_eks_*"]],
  ["aws.batch", "Batch", "compute", ["aws_batch_*"]],
  ["aws.beanstalk", "Elastic Beanstalk", "compute", ["aws_elastic_beanstalk_*"]],
  ["aws.apprunner", "App Runner", "compute", ["aws_apprunner_*"]],
  ["aws.lightsail", "Lightsail", "compute", ["aws_lightsail_*"]],
  ["aws.sfn", "Step Functions", "compute", ["aws_sfn_*"]],
  ["aws.cloud9", "Cloud9", "compute", ["aws_cloud9_*"]],
  ["aws.sagemaker", "SageMaker", "compute", ["aws_sagemaker_*"]],
  ["aws.bedrock", "Bedrock", "compute", ["aws_bedrock_*", "aws_bedrockagent_*"]],
  // Storage.
  ["aws.s3", "S3", "storage", ["aws_s3_*", "aws_s3control_*", "aws_s3outposts_*"]],
  ["aws.ebs", "EBS", "storage", ["aws_ebs_*", "aws_volume_attachment"]],
  ["aws.efs", "EFS", "storage", ["aws_efs_*"]],
  ["aws.fsx", "FSx", "storage", ["aws_fsx_*"]],
  ["aws.backup", "Backup", "storage", ["aws_backup_*"]],
  ["aws.glacier", "S3 Glacier", "storage", ["aws_glacier_*"]],
  ["aws.storagegateway", "Storage Gateway", "storage", ["aws_storagegateway_*"]],
  ["aws.ecr", "ECR", "storage", ["aws_ecr_*", "aws_ecrpublic_*"]],
  ["aws.transfer", "Transfer Family", "storage", ["aws_transfer_*"]],
  ["aws.datasync", "DataSync", "storage", ["aws_datasync_*"]],
  // Security and identity.
  ["aws.iam", "IAM", "identity", ["aws_iam_*", "aws_account_*"]],
  ["aws.organizations", "Organizations", "identity", ["aws_organizations_*"]],
  ["aws.kms", "KMS", "identity", ["aws_kms_*"]],
  ["aws.secretsmanager", "Secrets Manager", "identity", ["aws_secretsmanager_*"]],
  ["aws.acm", "Certificate Manager", "identity", ["aws_acm_*", "aws_acmpca_*"]],
  ["aws.cognito", "Cognito", "identity", ["aws_cognito_*"]],
  ["aws.waf", "WAF", "identity", ["aws_wafv2_*", "aws_waf_*", "aws_wafregional_*"]],
  ["aws.guardduty", "GuardDuty", "identity", ["aws_guardduty_*"]],
  ["aws.securityhub", "Security Hub", "identity", ["aws_securityhub_*"]],
  ["aws.accessanalyzer", "IAM Access Analyzer", "identity", ["aws_accessanalyzer_*"]],
  ["aws.inspector", "Inspector", "identity", ["aws_inspector_*", "aws_inspector2_*"]],
  ["aws.macie", "Macie", "identity", ["aws_macie_*", "aws_macie2_*"]],
  ["aws.detective", "Detective", "identity", ["aws_detective_*"]],
  ["aws.shield", "Shield", "identity", ["aws_shield_*"]],
  ["aws.sso", "IAM Identity Center", "identity", ["aws_ssoadmin_*", "aws_identitystore_*"]],
  ["aws.directoryservice", "Directory Service", "identity", ["aws_directory_service_*"]],
  ["aws.ram", "RAM", "identity", ["aws_ram_*"]],
  ["aws.fms", "Firewall Manager", "identity", ["aws_fms_*"]],
  ["aws.cloudhsm", "CloudHSM", "identity", ["aws_cloudhsm_*"]],
  ["aws.signer", "Signer", "identity", ["aws_signer_*"]],
  // Databases, analytics and streaming.
  ["aws.rds", "RDS", "data", ["aws_db_*", "aws_rds_*"]],
  ["aws.dynamodb", "DynamoDB", "data", ["aws_dynamodb_*"]],
  ["aws.elasticache", "ElastiCache", "data", ["aws_elasticache_*"]],
  ["aws.docdb", "DocumentDB", "data", ["aws_docdb_*"]],
  ["aws.neptune", "Neptune", "data", ["aws_neptune_*"]],
  ["aws.redshift", "Redshift", "data", ["aws_redshift_*", "aws_redshiftserverless_*", "aws_redshiftdata_*"]],
  ["aws.opensearch", "OpenSearch Service", "data", ["aws_opensearch_*", "aws_opensearchserverless_*", "aws_elasticsearch_*"]],
  ["aws.memorydb", "MemoryDB", "data", ["aws_memorydb_*"]],
  ["aws.keyspaces", "Keyspaces", "data", ["aws_keyspaces_*"]],
  ["aws.timestream", "Timestream", "data", ["aws_timestreamwrite_*", "aws_timestreamquery_*"]],
  ["aws.dms", "DMS", "data", ["aws_dms_*"]],
  ["aws.kinesis", "Kinesis", "data", ["aws_kinesis_*", "aws_kinesisanalyticsv2_*"]],
  ["aws.firehose", "Firehose", "data", ["aws_kinesis_firehose_*"]],
  ["aws.msk", "MSK", "data", ["aws_msk_*", "aws_mskconnect_*"]],
  ["aws.emr", "EMR", "data", ["aws_emr_*", "aws_emrserverless_*", "aws_emrcontainers_*"]],
  ["aws.glue", "Glue", "data", ["aws_glue_*"]],
  ["aws.athena", "Athena", "data", ["aws_athena_*"]],
  ["aws.datapipeline", "Data Pipeline", "data", ["aws_datapipeline_*"]],
  ["aws.lakeformation", "Lake Formation", "data", ["aws_lakeformation_*"]],
  ["aws.quicksight", "QuickSight", "data", ["aws_quicksight_*"]],
  // Integration, management and developer tools.
  ["aws.cloudwatch", "CloudWatch", "other", ["aws_cloudwatch_*", "aws_synthetics_*", "aws_oam_*", "aws_rum_*"]],
  ["aws.eventbridge", "EventBridge", "other", ["aws_cloudwatch_event_*", "aws_pipes_*", "aws_scheduler_*", "aws_schemas_*"]],
  ["aws.sns", "SNS", "other", ["aws_sns_*"]],
  ["aws.sqs", "SQS", "other", ["aws_sqs_*"]],
  ["aws.mq", "Amazon MQ", "other", ["aws_mq_*"]],
  ["aws.ses", "SES", "other", ["aws_ses_*", "aws_sesv2_*"]],
  ["aws.pinpoint", "Pinpoint", "other", ["aws_pinpoint_*"]],
  ["aws.cloudtrail", "CloudTrail", "other", ["aws_cloudtrail*"]],
  ["aws.config", "Config", "other", ["aws_config_*"]],
  ["aws.xray", "X-Ray", "other", ["aws_xray_*"]],
  ["aws.cloudformation", "CloudFormation", "other", ["aws_cloudformation_*"]],
  ["aws.ssm", "Systems Manager", "other", ["aws_ssm_*"]],
  ["aws.appconfig", "AppConfig", "other", ["aws_appconfig_*"]],
  ["aws.budgets", "Budgets", "other", ["aws_budgets_*", "aws_ce_*"]],
  ["aws.resourcegroups", "Resource Groups", "other", ["aws_resourcegroups_*", "aws_resourcegroupstaggingapi_*"]],
  ["aws.servicecatalog", "Service Catalog", "other", ["aws_servicecatalog_*"]],
  ["aws.devicefarm", "Device Farm", "other", ["aws_devicefarm_*"]],
  ["aws.iot", "IoT Core", "other", ["aws_iot_*"]],
  ["aws.mediapackage", "MediaPackage", "other", ["aws_media_package_*"]],
  ["aws.mediastore", "MediaStore", "other", ["aws_media_store_*"]],
  ["aws.mediaconvert", "MediaConvert", "other", ["aws_media_convert_*"]],
  ["aws.codebuild", "CodeBuild", "other", ["aws_codebuild_*"]],
  ["aws.codecommit", "CodeCommit", "other", ["aws_codecommit_*"]],
  ["aws.codedeploy", "CodeDeploy", "other", ["aws_codedeploy_*"]],
  ["aws.codepipeline", "CodePipeline", "other", ["aws_codepipeline*"]],
  ["aws.codeartifact", "CodeArtifact", "other", ["aws_codeartifact_*"]],
  ["aws.codeconnections", "CodeConnections", "other", ["aws_codestarconnections_*", "aws_codeconnections_*"]],
  ["aws.amplify", "Amplify", "other", ["aws_amplify_*"]],
  ["aws.appflow", "AppFlow", "other", ["aws_appflow_*"]],
  ["aws.servicequotas", "Service Quotas", "other", ["aws_servicequotas_*"]],
];

const GCP: readonly Row[] = [
  ["gcp.compute", "Compute Engine", "compute", ["google_compute_instance", "google_compute_instance_*", "google_compute_region_instance_*", "google_compute_autoscaler", "google_compute_region_autoscaler", "google_compute_image", "google_compute_node_*", "google_compute_reservation", "google_compute_resource_policy", "google_compute_target_instance", "google_compute_machine_image", "google_compute_per_instance_config", "google_compute_region_per_instance_config", "google_compute_project_metadata*", "google_compute_instance_group*"]],
  ["gcp.disk", "Persistent Disk", "storage", ["google_compute_disk*", "google_compute_region_disk*", "google_compute_snapshot", "google_compute_snapshot_*"]],
  ["gcp.vpc", "VPC network", "network", ["google_compute_network", "google_compute_network_*", "google_compute_subnetwork", "google_compute_subnetwork_*", "google_compute_route", "google_compute_address", "google_compute_global_address", "google_compute_firewall*", "google_compute_packet_mirroring", "google_compute_network_peering*", "google_compute_shared_vpc_*", "google_service_networking_*", "google_vpc_access_connector"]],
  ["gcp.router", "Cloud Router", "network", ["google_compute_router", "google_compute_router_*"]],
  ["gcp.nat", "Cloud NAT", "network", ["google_compute_router_nat"]],
  ["gcp.loadbalancing", "Load Balancing", "network", ["google_compute_forwarding_rule", "google_compute_global_forwarding_rule", "google_compute_backend_*", "google_compute_region_backend_*", "google_compute_url_map", "google_compute_region_url_map", "google_compute_target_*", "google_compute_region_target_*", "google_compute_health_check", "google_compute_http_health_check", "google_compute_https_health_check", "google_compute_region_health_check", "google_compute_ssl_policy", "google_compute_region_ssl_policy", "google_compute_ssl_certificate", "google_compute_region_ssl_certificate", "google_compute_managed_ssl_certificate", "google_compute_network_endpoint_group", "google_compute_global_network_endpoint_group", "google_compute_region_network_endpoint_group", "google_compute_network_endpoint", "google_compute_global_network_endpoint"]],
  ["gcp.armor", "Cloud Armor", "identity", ["google_compute_security_policy*", "google_compute_region_security_policy*"]],
  ["gcp.vpn", "Cloud VPN", "network", ["google_compute_vpn_*", "google_compute_ha_vpn_gateway", "google_compute_external_vpn_gateway"]],
  ["gcp.interconnect", "Cloud Interconnect", "network", ["google_compute_interconnect*"]],
  ["gcp.dns", "Cloud DNS", "network", ["google_dns_*"]],
  ["gcp.cdn", "Cloud CDN", "network", ["google_compute_backend_bucket_*"]],
  ["gcp.gke", "GKE", "compute", ["google_container_*", "google_gke_*"]],
  ["gcp.run", "Cloud Run", "compute", ["google_cloud_run_*"]],
  ["gcp.functions", "Cloud Functions", "compute", ["google_cloudfunctions_*", "google_cloudfunctions2_*"]],
  ["gcp.appengine", "App Engine", "compute", ["google_app_engine_*"]],
  ["gcp.batch", "Batch", "compute", ["google_batch_*"]],
  ["gcp.vertexai", "Vertex AI", "compute", ["google_vertex_ai_*"]],
  ["gcp.storage", "Cloud Storage", "storage", ["google_storage_*"]],
  ["gcp.filestore", "Filestore", "storage", ["google_filestore_*"]],
  ["gcp.artifactregistry", "Artifact Registry", "storage", ["google_artifact_registry_*"]],
  ["gcp.backupdr", "Backup and DR", "storage", ["google_backup_dr_*"]],
  ["gcp.iam", "IAM", "identity", ["google_service_account", "google_service_account_*", "google_project_iam_*", "google_folder_iam_*", "google_organization_iam_*", "google_iam_*", "google_storage_bucket_iam_*"]],
  ["gcp.kms", "Cloud KMS", "identity", ["google_kms_*"]],
  ["gcp.secretmanager", "Secret Manager", "identity", ["google_secret_manager_*"]],
  ["gcp.scc", "SCC", "identity", ["google_scc_*"]],
  ["gcp.certificatemanager", "Certificate Manager", "identity", ["google_certificate_manager_*"]],
  ["gcp.sql", "Cloud SQL", "data", ["google_sql_*"]],
  ["gcp.bigquery", "BigQuery", "data", ["google_bigquery_*"]],
  ["gcp.redis", "Memorystore", "data", ["google_redis_*", "google_memcache_*"]],
  ["gcp.spanner", "Spanner", "data", ["google_spanner_*"]],
  ["gcp.bigtable", "Bigtable", "data", ["google_bigtable_*"]],
  ["gcp.firestore", "Firestore", "data", ["google_firestore_*"]],
  ["gcp.alloydb", "AlloyDB", "data", ["google_alloydb_*"]],
  ["gcp.dataproc", "Dataproc", "data", ["google_dataproc_*"]],
  ["gcp.dataflow", "Dataflow", "data", ["google_dataflow_*"]],
  ["gcp.composer", "Cloud Composer", "data", ["google_composer_*"]],
  ["gcp.pubsub", "Pub/Sub", "other", ["google_pubsub_*"]],
  ["gcp.tasks", "Cloud Tasks", "other", ["google_cloud_tasks_*"]],
  ["gcp.scheduler", "Cloud Scheduler", "other", ["google_cloud_scheduler_*"]],
  ["gcp.build", "Cloud Build", "other", ["google_cloudbuild_*"]],
  ["gcp.deploy", "Cloud Deploy", "other", ["google_clouddeploy_*"]],
  ["gcp.monitoring", "Cloud Monitoring", "other", ["google_monitoring_*"]],
  ["gcp.logging", "Cloud Logging", "other", ["google_logging_*"]],
  ["gcp.resourcemanager", "Resource Manager", "other", ["google_project", "google_project_*", "google_folder", "google_folder_*", "google_organization_*", "google_billing_*"]],
  ["gcp.apigateway", "API Gateway", "network", ["google_api_gateway_*", "google_apigee_*"]],
];

const AZURE: readonly Row[] = [
  // Compute and containers.
  ["azure.vm", "Virtual Machines", "compute", ["azurerm_linux_virtual_machine", "azurerm_windows_virtual_machine", "azurerm_virtual_machine", "azurerm_virtual_machine_*", "azurerm_availability_set", "azurerm_dedicated_host*", "azurerm_proximity_placement_group", "azurerm_ssh_public_key", "azurerm_image", "azurerm_shared_image*"]],
  ["azure.vmss", "VM Scale Sets", "compute", ["azurerm_linux_virtual_machine_scale_set", "azurerm_windows_virtual_machine_scale_set", "azurerm_virtual_machine_scale_set*", "azurerm_orchestrated_virtual_machine_scale_set", "azurerm_monitor_autoscale_setting"]],
  ["azure.aks", "AKS", "compute", ["azurerm_kubernetes_*"]],
  ["azure.aci", "Container Instances", "compute", ["azurerm_container_group"]],
  ["azure.containerapps", "Container Apps", "compute", ["azurerm_container_app*"]],
  ["azure.appservice", "App Service", "compute", ["azurerm_app_service*", "azurerm_service_plan", "azurerm_linux_web_app*", "azurerm_windows_web_app*", "azurerm_static_web_app*", "azurerm_static_site*"]],
  ["azure.functions", "Functions", "compute", ["azurerm_function_app*", "azurerm_linux_function_app*", "azurerm_windows_function_app*"]],
  ["azure.batch", "Batch", "compute", ["azurerm_batch_*"]],
  ["azure.logicapps", "Logic Apps", "compute", ["azurerm_logic_app_*", "azurerm_integration_service_environment"]],
  ["azure.ml", "Machine Learning", "compute", ["azurerm_machine_learning_*"]],
  ["azure.cognitive", "AI services", "compute", ["azurerm_cognitive_*", "azurerm_search_service", "azurerm_search_*"]],
  // Networking.
  ["azure.vnet", "Virtual Network", "network", ["azurerm_virtual_network", "azurerm_virtual_network_peering", "azurerm_virtual_network_dns_servers", "azurerm_subnet", "azurerm_subnet_*", "azurerm_virtual_hub*", "azurerm_virtual_wan"]],
  ["azure.nsg", "NSG", "network", ["azurerm_network_security_group", "azurerm_network_security_rule", "azurerm_application_security_group"]],
  ["azure.nic", "Network Interface", "network", ["azurerm_network_interface*"]],
  ["azure.routetable", "Route Table", "network", ["azurerm_route_table", "azurerm_route", "azurerm_route_*"]],
  ["azure.publicip", "Public IP", "network", ["azurerm_public_ip*"]],
  ["azure.natgateway", "NAT Gateway", "network", ["azurerm_nat_gateway*"]],
  ["azure.lb", "Load Balancer", "network", ["azurerm_lb", "azurerm_lb_*"]],
  ["azure.appgateway", "Application Gateway", "network", ["azurerm_application_gateway"]],
  ["azure.firewall", "Firewall", "network", ["azurerm_firewall*", "azurerm_ip_group*"]],
  ["azure.frontdoor", "Front Door and CDN", "network", ["azurerm_cdn_frontdoor_*", "azurerm_frontdoor*", "azurerm_cdn_*"]],
  ["azure.dns", "DNS", "network", ["azurerm_dns_*"]],
  ["azure.privatedns", "Private DNS", "network", ["azurerm_private_dns_*"]],
  ["azure.privatelink", "Private Link", "network", ["azurerm_private_endpoint*", "azurerm_private_link_service*"]],
  ["azure.vpngateway", "VPN Gateway", "network", ["azurerm_virtual_network_gateway*", "azurerm_local_network_gateway", "azurerm_vpn_*", "azurerm_point_to_site_vpn_gateway"]],
  ["azure.expressroute", "ExpressRoute", "network", ["azurerm_express_route_*"]],
  ["azure.bastion", "Bastion", "network", ["azurerm_bastion_host"]],
  ["azure.networkwatcher", "Network Watcher", "network", ["azurerm_network_watcher*", "azurerm_network_connection_monitor"]],
  ["azure.trafficmanager", "Traffic Manager", "network", ["azurerm_traffic_manager_*"]],
  ["azure.ddos", "DDoS Protection", "identity", ["azurerm_network_ddos_protection_plan"]],
  ["azure.apim", "API Management", "network", ["azurerm_api_management*"]],
  // Storage and backup.
  ["azure.storage", "Storage account", "storage", ["azurerm_storage_*"]],
  ["azure.disk", "Managed Disks", "storage", ["azurerm_managed_disk", "azurerm_disk_*", "azurerm_snapshot"]],
  ["azure.acr", "Container Registry", "storage", ["azurerm_container_registry*"]],
  ["azure.backup", "Backup", "storage", ["azurerm_recovery_services_*", "azurerm_backup_*", "azurerm_data_protection_*"]],
  ["azure.netapp", "NetApp Files", "storage", ["azurerm_netapp_*"]],
  // Identity and security.
  ["azure.keyvault", "Key Vault", "identity", ["azurerm_key_vault*"]],
  ["azure.rbac", "Role assignment", "identity", ["azurerm_role_assignment", "azurerm_role_definition", "azurerm_role_*"]],
  ["azure.managedidentity", "Managed Identity", "identity", ["azurerm_user_assigned_identity", "azurerm_federated_identity_credential"]],
  ["azure.entra", "Entra ID", "identity", ["azuread_*"]],
  ["azure.defender", "Defender for Cloud", "identity", ["azurerm_security_center_*", "azurerm_advanced_threat_protection", "azurerm_sentinel_*"]],
  // Databases and analytics.
  ["azure.sql", "SQL Database", "data", ["azurerm_mssql_*", "azurerm_sql_*"]],
  ["azure.sqlmi", "SQL MI", "data", ["azurerm_mssql_managed_*", "azurerm_sql_managed_*"]],
  ["azure.postgres", "PostgreSQL", "data", ["azurerm_postgresql_*"]],
  ["azure.mysql", "MySQL", "data", ["azurerm_mysql_*"]],
  ["azure.mariadb", "MariaDB", "data", ["azurerm_mariadb_*"]],
  ["azure.cosmosdb", "Cosmos DB", "data", ["azurerm_cosmosdb_*"]],
  ["azure.redis", "Cache for Redis", "data", ["azurerm_redis_*", "azurerm_managed_redis*"]],
  ["azure.synapse", "Synapse", "data", ["azurerm_synapse_*"]],
  ["azure.datafactory", "Data Factory", "data", ["azurerm_data_factory*"]],
  ["azure.databricks", "Databricks", "data", ["azurerm_databricks_*"]],
  ["azure.streamanalytics", "Stream Analytics", "data", ["azurerm_stream_analytics_*"]],
  ["azure.eventhub", "Event Hubs", "data", ["azurerm_eventhub*"]],
  ["azure.datalake", "Data Lake", "data", ["azurerm_data_lake_*"]],
  // Messaging, management and monitoring.
  ["azure.servicebus", "Service Bus", "other", ["azurerm_servicebus_*"]],
  ["azure.eventgrid", "Event Grid", "other", ["azurerm_eventgrid_*"]],
  ["azure.signalr", "SignalR", "other", ["azurerm_signalr_*", "azurerm_web_pubsub*"]],
  ["azure.resourcegroup", "Resource group", "other", ["azurerm_resource_group"]],
  ["azure.management", "Management", "other", ["azurerm_management_*", "azurerm_subscription*", "azurerm_resource_*", "azurerm_template_deployment", "azurerm_policy_*", "azurerm_maintenance_*", "azurerm_automation_*", "azurerm_consumption_*", "azurerm_portal_*", "azurerm_dashboard*", "azurerm_app_configuration*"]],
  ["azure.monitor", "Monitor", "other", ["azurerm_monitor_*", "azurerm_application_insights*", "azurerm_dashboard_grafana"]],
  ["azure.loganalytics", "Log Analytics", "other", ["azurerm_log_analytics_*"]],
  ["azure.arm", "Azure resource", "other", ["azapi_*"]],
];

/** What is drawn that is no cloud service: a module call's card and the summary card of a group. No Terraform type maps to them. */
const STRUCTURE: readonly Row[] = [
  ["terraform.module", "Module call", "other", []],
  ["terraform.group", "Group", "other", []],
];

const ROWS: readonly Row[] = [...AWS, ...GCP, ...AZURE, ...STRUCTURE];

const labels = new Map<string, ServiceInfo>();
const exact = new Map<string, ServiceInfo>();
const prefixes: { prefix: string; info: ServiceInfo }[] = [];
for (const [id, label, category, types] of ROWS) {
  const info: ServiceInfo = { id, label, category, known: true };
  labels.set(id, info);
  for (const type of types) {
    if (type.endsWith("*")) prefixes.push({ prefix: type.slice(0, -1), info });
    else exact.set(type, info);
  }
}
// Longest prefix first, so that a narrow rule beats the wide one it sits in; the sort is stable, so equal ones keep the table's order.
prefixes.sort((a, b) => b.prefix.length - a.prefix.length);

/** The cloud a resource type belongs to by its name (`aws_`, `azurerm_`, `google_`), or `other` for a type that is none of them. */
export function providerOfType(type: string): "aws" | "azure" | "gcp" | "other" {
  if (type.startsWith("aws_")) return "aws";
  if (type.startsWith("azurerm_") || type.startsWith("azapi_") || type.startsWith("azuread_")) return "azure";
  if (type.startsWith("google_")) return "gcp";
  return "other";
}

const PROVIDER_LABEL = { aws: "AWS", azure: "Azure", gcp: "Google Cloud", other: "Other" } as const;

const CATEGORY_TOKENS: readonly (readonly [GraphCategory, ReadonlySet<string>])[] = [
  ["identity", new Set(["iam", "role", "policy", "identity", "principal", "account", "kms", "key", "secret", "vault"])],
  ["data", new Set(["db", "rds", "dynamodb", "sql", "cosmosdb", "redis", "cache", "elasticache", "bigtable", "spanner", "bigquery", "dataset", "mysql", "postgresql", "database", "redshift"])],
  ["storage", new Set(["s3", "bucket", "storage", "disk", "volume", "ebs", "efs", "blob", "file", "backup", "snapshot"])],
  ["network", new Set(["vpc", "subnet", "subnetwork", "route", "gateway", "network", "nat", "vnet", "firewall", "dns", "lb", "elb", "alb", "nlb", "security", "nsg", "eip", "endpoint", "peering", "vpn", "cloudfront", "cdn", "nic", "ip"])],
  ["compute", new Set(["instance", "lambda", "function", "ecs", "eks", "container", "cluster", "kubernetes", "vm", "machine", "autoscaling", "launch", "app", "batch", "compute", "service"])],
];

/** A coarse kind read off the words of a Terraform resource type: what a type the table does not know is drawn as. */
export function categoryOfType(type: string): GraphCategory {
  const tokens = type.split("_");
  for (const [category, words] of CATEGORY_TOKENS) {
    if (tokens.some((token) => words.has(token))) return category;
  }
  return "other";
}

function fallback(provider: "aws" | "azure" | "gcp" | "other", category: GraphCategory): ServiceInfo {
  const label = provider === "other" ? (category === "other" ? "Other resources" : `Other ${category} resources`) : `${PROVIDER_LABEL[provider]} ${category} resources`;
  return { id: `${provider}.${category}`, label, category, known: false };
}

/** The service a resource type belongs to: its exact row, else the longest prefix row, else its provider and a category read off the type. */
export function serviceOf(type: string): ServiceInfo {
  const known = exact.get(type) ?? prefixes.find((p) => type.startsWith(p.prefix))?.info;
  if (known !== undefined) return known;
  return fallback(providerOfType(type), categoryOfType(type));
}

/** The service with this id, or undefined for an id that is not a row of the table (a fallback id, say). */
export function serviceById(id: string): ServiceInfo | undefined {
  return labels.get(id);
}

/** Every service of the table, in table order: what a web app walks to map each service id to an icon. */
export function listServices(): readonly ServiceInfo[] {
  return [...labels.values()];
}

/** The name to show for a service id: the table's, or for a fallback id its provider and category. */
export function serviceLabel(id: string): string {
  const row = labels.get(id);
  if (row !== undefined) return row.label;
  const [provider = "other", category = "other"] = id.split(".");
  const cloud = provider === "aws" || provider === "azure" || provider === "gcp" ? provider : "other";
  return fallback(cloud, GRAPH_CATEGORIES.find((c) => c === category) ?? "other").label;
}
