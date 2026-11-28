// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the AWS managed policies most often attached in Terraform grant, so an attachment by
 * ARN can be typed instead of left `unscoped`. A small table, bundled and versioned: it holds
 * a level and the services it applies to, never a policy's text.
 *
 * How the rows were made. Each row is read from the policy's own document in the AWS managed
 * policy reference (the default version at the date below), not from its name or description:
 * every Allow action is levelled by the same rule that levels an action in a policy written in
 * the file (`actionLevel` in iam.ts), and a service gets the strongest level any of its
 * actions has. A Condition on every action at that level is kept as `conditional`; the level
 * itself is never lowered for one. Three reviewed adjustments, nothing else:
 *   - A policy published as read-only (ReadOnly*, ViewOnlyAccess, SecurityAudit) is `read`.
 *     Its actions that are not named like a read verb are queries, validations, simulations,
 *     tests, report and trace starts, generators, downloads and delivery to a log
 *     (`logs:StartQuery`, `iam:SimulatePrincipalPolicy`, `iam:Generate*`, `dynamodb:PartiQLSelect`,
 *     `ecr:BatchCheckLayerAvailability`, `config:Deliver*`, `elasticbeanstalk:Request*`,
 *     `servicequotas:StartQuotaUtilizationReport`, `xray:StartTraceRetrieval`, `rds:Download*`,
 *     `eks:AccessKubernetesApi`), none of which changes a permission. A few start work or reach
 *     a cluster's own API, so for them the level is a review of the names, not a proof.
 *   - `iam:CreateServiceLinkedRole` and `iam:DeleteServiceLinkedRole` are not counted, nor the
 *     reads of one named AWS service-linked role (`iam:GetRole` on `.../aws-service-role/...`,
 *     `iam:GetServiceLinkedRoleDeletionStatus`): they are about the AWS-owned role for a service,
 *     which is never one of the roles a file draws.
 *   - `logs:PutRetentionPolicy` and `elasticloadbalancing:CreateLoadBalancerPolicy` are
 *     `write`: their names say "policy", but they set a log retention and a listener policy,
 *     not a permission.
 * IAM reads are kept: the `iam:Get*`, `iam:List*` and console reads (`iam:GetRole`, `iam:ListRoles`,
 * `iam:GetPolicy`) of a policy are `["iam", "read"]`, beside any conditional `iam:PassRole` row, so
 * IAM shows as read wherever a policy grants it. A policy that grants `*` (ReadOnlyAccess,
 * SecurityAudit, ViewOnlyAccess) already covers IAM in its row.
 * PowerUserAccess is `admin` over every service: it allows everything outside IAM,
 * Organizations and Account, including the actions on the other services that change who can
 * use a resource (`s3:PutBucketPolicy`, `kms:PutKeyPolicy`, `lambda:AddPermission`).
 *
 * What a row says. Every service the policy grants on is listed, drawn or not: a grant on a
 * service the picture has no resource for (`schemas`, `pi`, `wafv2`, `cognito-sync`) is
 * still a grant, so it ends at "Any resource (*)" at its own level. A managed policy is
 * attached to every resource of a service in the account (its Resource is `*`), so each
 * grant always has an "Any resource (*)" edge, and also an edge to each drawn resource of the
 * service (see `SERVICE_RESOURCE_TYPES`) unless there are none, more than `MAX_MANAGED_TARGETS`,
 * or the attachment already has `MAX_MANAGED_EDGES`. AWS may widen a
 * managed policy later: an ARN in the table is typed by the version above, and a policy that is
 * not in the table stays `unscoped`. A row should be regenerated, not edited, when AWS changes
 * the policy.
 */

type ManagedLevel = "read" | "write" | "admin";

/** A service prefix (or `*` for every service), the level the policy grants there, and `true` when every action at that level has a Condition. */
export type ManagedGrant = readonly [service: string, level: ManagedLevel, conditional?: true];

/** The date the rows were read from the AWS managed policy reference. */
export const AWS_MANAGED_POLICIES_VERSION = "2026-11-27";

/** More drawn resources of a service than this and a grant ends at "Any resource (*)" rather than adding an edge each. */
export const MAX_MANAGED_TARGETS = 25;

/** One attachment adds at most this many edges to drawn resources; a grant past it ends at "Any resource (*)" too. */
export const MAX_MANAGED_EDGES = 50;

/** Terraform resource types, by prefix, whose drawn node is a resource of each service. */
export const SERVICE_RESOURCE_TYPES: Readonly<Record<string, readonly string[]>> = {
  "apigateway": ["aws_api_gateway_", "aws_apigatewayv2_"],
  "autoscaling": ["aws_autoscaling_"],
  "cloudformation": ["aws_cloudformation_"],
  "cloudfront": ["aws_cloudfront_"],
  "cloudwatch": ["aws_cloudwatch_metric_alarm", "aws_cloudwatch_dashboard", "aws_cloudwatch_composite_alarm"],
  "cognito-identity": ["aws_cognito_identity_"],
  "cognito-idp": ["aws_cognito_user_"],
  "dax": ["aws_dax_"],
  "dynamodb": ["aws_dynamodb_"],
  "ec2": ["aws_instance", "aws_launch_template", "aws_ebs_volume", "aws_vpc", "aws_subnet", "aws_security_group", "aws_network_interface", "aws_eip", "aws_nat_gateway", "aws_internet_gateway"],
  "ecr": ["aws_ecr_"],
  "ecs": ["aws_ecs_"],
  "eks": ["aws_eks_"],
  "elasticfilesystem": ["aws_efs_"],
  "elasticloadbalancing": ["aws_lb", "aws_alb", "aws_elb"],
  "es": ["aws_elasticsearch_domain", "aws_opensearch_domain"],
  "events": ["aws_cloudwatch_event_"],
  "execute-api": ["aws_api_gateway_", "aws_apigatewayv2_"],
  "iam": ["aws_iam_role", "aws_iam_policy"],
  "kinesis": ["aws_kinesis_"],
  "kms": ["aws_kms_"],
  "lambda": ["aws_lambda_"],
  "logs": ["aws_cloudwatch_log_"],
  "rds": ["aws_db_", "aws_rds_"],
  "route53": ["aws_route53_"],
  "s3": ["aws_s3_"],
  "s3-object-lambda": ["aws_s3_"],
  "secretsmanager": ["aws_secretsmanager_"],
  "sns": ["aws_sns_"],
  "sqs": ["aws_sqs_"],
  "ssm": ["aws_ssm_"],
  "states": ["aws_sfn_"],
  "xray": ["aws_xray_"],
};

/** The managed policies, by the part of the ARN after `:policy/` (a path such as `service-role/` is part of it). */
const POLICIES: ReadonlyMap<string, readonly ManagedGrant[]> = new Map<string, readonly ManagedGrant[]>(Object.entries({
  "AWSKeyManagementServicePowerUser": [["kms", "write"], ["iam", "read"]],
  "service-role/AWSLambdaBasicExecutionRole": [["logs", "write"]],
  "service-role/AWSLambdaDynamoDBExecutionRole": [["dynamodb", "read"], ["logs", "write"]],
  "service-role/AWSLambdaKinesisExecutionRole": [["kinesis", "write"], ["logs", "write"]],
  "service-role/AWSLambdaSQSQueueExecutionRole": [["sqs", "write"], ["logs", "write"]],
  "service-role/AWSLambdaVPCAccessExecutionRole": [["logs", "write"], ["ec2", "write"]],
  "AWSLambda_FullAccess": [["cloudformation", "read"], ["cloudwatch", "read"], ["ec2", "read"], ["kms", "read"], ["iam", "admin", true], ["lambda", "admin"], ["logs", "write"], ["states", "read"], ["xray", "read"], ["tag", "read"], ["iam", "read"]],
  "AWSLambda_ReadOnlyAccess": [["cloudformation", "read"], ["cloudwatch", "read"], ["ec2", "read"], ["kms", "read"], ["logs", "read"], ["lambda", "read"], ["states", "read"], ["xray", "read"], ["tag", "read"], ["iam", "read"]],
  "AWSStepFunctionsFullAccess": [["states", "admin"]],
  "AWSXRayDaemonWriteAccess": [["xray", "write"]],
  "AdministratorAccess": [["*", "admin"]],
  "AmazonAPIGatewayAdministrator": [["apigateway", "admin"]],
  "AmazonAPIGatewayInvokeFullAccess": [["execute-api", "write"]],
  "AmazonCognitoPowerUser": [["cognito-identity", "admin"], ["cognito-idp", "admin"], ["kinesis", "read"], ["lambda", "read"], ["sns", "read"], ["cognito-sync", "admin"], ["ses", "read"], ["mobiletargeting", "read"], ["acm", "read"], ["sms-voice", "read"], ["iam", "read"]],
  "AmazonDynamoDBFullAccess": [["dynamodb", "admin"], ["dax", "admin"], ["cloudwatch", "write"], ["ec2", "read"], ["iam", "admin", true], ["kms", "read"], ["sns", "write"], ["lambda", "write"], ["kinesis", "read"], ["application-autoscaling", "admin"], ["datapipeline", "write"], ["resource-groups", "write"], ["tag", "read"], ["iam", "read"]],
  "AmazonDynamoDBReadOnlyAccess": [["cloudwatch", "read"], ["dynamodb", "read"], ["dax", "read"], ["ec2", "read"], ["kms", "read"], ["sns", "read"], ["lambda", "read"], ["kinesis", "read"], ["application-autoscaling", "read"], ["datapipeline", "read"], ["resource-groups", "read"], ["tag", "read"], ["iam", "read"]],
  "AmazonEC2ContainerRegistryFullAccess": [["ecr", "admin"], ["cloudtrail", "read"], ["signin", "write"]],
  "AmazonEC2ContainerRegistryPowerUser": [["ecr", "write"], ["signin", "write"]],
  "AmazonEC2ContainerRegistryReadOnly": [["ecr", "read"]],
  "AmazonEC2FullAccess": [["ec2", "admin"], ["elasticloadbalancing", "admin"], ["cloudwatch", "admin"], ["autoscaling", "admin"]],
  "AmazonEC2ReadOnlyAccess": [["ec2", "read"], ["elasticloadbalancing", "read"], ["cloudwatch", "read"], ["autoscaling", "read"]],
  "service-role/AmazonECSTaskExecutionRolePolicy": [["ecr", "write"], ["logs", "write"]],
  "AmazonEKSClusterPolicy": [["autoscaling", "write"], ["ec2", "write"], ["elasticloadbalancing", "write"], ["kms", "read"]],
  "AmazonEKSWorkerNodePolicy": [["ec2", "read"], ["eks", "read"], ["eks-auth", "admin"]],
  "AmazonEKS_CNI_Policy": [["ec2", "write"]],
  "AmazonElasticFileSystemFullAccess": [["cloudwatch", "read"], ["ec2", "write"], ["elasticfilesystem", "admin"], ["kms", "read"], ["iam", "admin", true]],
  "AmazonEventBridgeFullAccess": [["events", "admin"], ["secretsmanager", "write"], ["iam", "admin", true], ["schemas", "admin"], ["scheduler", "admin"], ["pipes", "admin"]],
  "AmazonKinesisFullAccess": [["kinesis", "admin"]],
  "AmazonKinesisReadOnlyAccess": [["kinesis", "read"]],
  "AmazonRDSFullAccess": [["rds", "admin"], ["cloudwatch", "write"], ["ec2", "read"], ["sns", "write"], ["logs", "read"], ["application-autoscaling", "admin"], ["outposts", "read"], ["devops-guru", "read"], ["pi", "admin"]],
  "AmazonRDSReadOnlyAccess": [["rds", "read"], ["ec2", "read"], ["cloudwatch", "read"], ["logs", "read"], ["devops-guru", "read"]],
  "AmazonRoute53FullAccess": [["route53", "admin"], ["cloudfront", "read"], ["cloudwatch", "read"], ["ec2", "read"], ["elasticloadbalancing", "read"], ["es", "read"], ["s3", "read"], ["sns", "read"], ["apigateway", "read"], ["route53domains", "admin"], ["elasticbeanstalk", "read"], ["lightsail", "read"], ["tag", "read"]],
  "AmazonRoute53ReadOnlyAccess": [["route53", "read"]],
  "AmazonS3FullAccess": [["s3", "admin"], ["s3-object-lambda", "admin"]],
  "AmazonS3ReadOnlyAccess": [["s3", "read"], ["s3-object-lambda", "read"]],
  "AmazonSNSFullAccess": [["sns", "admin"], ["sms-voice", "write", true]],
  "AmazonSNSReadOnlyAccess": [["sns", "read"], ["sms-voice", "read", true]],
  "AmazonSQSFullAccess": [["sqs", "admin"]],
  "AmazonSQSReadOnlyAccess": [["sqs", "read"]],
  "AmazonSSMFullAccess": [["cloudwatch", "write"], ["ec2", "read"], ["logs", "admin"], ["ssm", "admin"], ["ds", "write"], ["ec2messages", "admin"], ["ssmmessages", "write"]],
  "AmazonSSMManagedInstanceCore": [["ssm", "write"], ["ssmmessages", "write"], ["ec2messages", "write"]],
  "AmazonSSMReadOnlyAccess": [["ssm", "read"]],
  "CloudFrontFullAccess": [["s3", "read"], ["cloudfront", "admin"], ["kinesis", "read"], ["ec2", "read"], ["elasticloadbalancing", "read"], ["cloudwatch", "read"], ["acm", "write", true], ["cloudfront-keyvaluestore", "admin"], ["waf", "read"], ["wafv2", "admin"], ["pricingplanmanager", "write"], ["freetier", "read"], ["shield", "read"], ["iam", "read"]],
  "CloudWatchAgentServerPolicy": [["cloudwatch", "write"], ["ec2", "read"], ["logs", "write"], ["xray", "write"], ["ssm", "read"]],
  "CloudWatchFullAccess": [["autoscaling", "read"], ["cloudwatch", "admin"], ["logs", "admin"], ["sns", "admin"], ["oam", "read"], ["iam", "read"]],
  "CloudWatchLogsFullAccess": [["logs", "admin"], ["cloudwatch", "write"], ["observabilityadmin", "read"]],
  "CloudWatchLogsReadOnlyAccess": [["logs", "read"], ["cloudwatch", "read"], ["observabilityadmin", "read"]],
  "CloudWatchReadOnlyAccess": [["autoscaling", "read"], ["cloudwatch", "read"], ["logs", "read"], ["sns", "read"], ["xray", "read"], ["application-autoscaling", "read"], ["application-signals", "read"], ["cloudtrail", "read"], ["oam", "read"], ["observabilityadmin", "read"], ["rum", "read"], ["synthetics", "read"], ["servicequotas", "read"], ["resource-explorer-2", "read"], ["aidevops", "read"]],
  "IAMFullAccess": [["iam", "admin"], ["organizations", "read"]],
  "IAMReadOnlyAccess": [["iam", "read"]],
  "PowerUserAccess": [["*", "admin"]],
  "ReadOnlyAccess": [["*", "read"]],
  "SecretsManagerReadWrite": [["secretsmanager", "admin"], ["cloudformation", "write"], ["ec2", "read"], ["kms", "read"], ["lambda", "admin"], ["rds", "read"], ["s3", "read"], ["docdb-elastic", "read"], ["redshift", "read"], ["redshift-serverless", "read"], ["tag", "read"], ["serverlessrepo", "write"]],
  "SecurityAudit": [["*", "read"]],
  "job-function/ViewOnlyAccess": [["*", "read"]],
}));

const ARN_PREFIX = "arn:aws:iam::aws:policy/";

/** The policies whose `*` row does not cover IAM: PowerUserAccess allows everything outside IAM, Organizations and Account, so it cannot rewrite the role it is attached to. */
export const MANAGED_WITHOUT_IAM_WRITE: ReadonlySet<string> = new Set([`${ARN_PREFIX}PowerUserAccess`]);

/** Longer than any managed policy ARN: anything past it is not looked up. */
const MAX_ARN_LENGTH = 200;

/**
 * The grants of a managed policy named by a literal ARN in the `aws` partition, or undefined
 * for any ARN the table does not hold (another partition, another account, a customer-managed
 * policy, a typo). Undefined is never "grants nothing": the caller types it `unscoped`.
 */
export function managedPolicyGrants(arn: string): readonly ManagedGrant[] | undefined {
  if (arn.length > MAX_ARN_LENGTH || !arn.startsWith(ARN_PREFIX)) return undefined;
  return POLICIES.get(arn.slice(ARN_PREFIX.length));
}

/** Every ARN key in the table, for tests. */
export function managedPolicyKeys(): string[] {
  return [...POLICIES.keys()];
}
