// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The emit gate's reviewed exceptions to its two policy scanners.
 *
 * checkov and trivy are blocking: a finding fails the document it is in. Some of
 * what they flag is not a defect in the emitter but a decision the plan's owner
 * makes, or a rule that cannot hold for the shape Terragram emits. Those, and
 * only those, are listed here — each with the reason it was accepted, which the
 * gate prints with every run so the list stays reviewable. Anything that is a
 * real gap is fixed in the emitter instead, and is NOT listed.
 *
 * An entry names a checkov id, a trivy id, or both when the two tools have the
 * same rule. `enforcedWith` narrows an entry: a document whose model holds that
 * kind is held to the rule, because for it the emitter does satisfy it.
 *
 * Adding an entry is a review decision, not a way to turn a red gate green.
 */
export type ScannerSkip = {
  checkov?: string;
  trivy?: string;
  reason: string;
  /** a model kind: documents that contain it are NOT exempt. */
  enforcedWith?: string;
};

export const SCANNER_SKIPS: readonly ScannerSkip[] = [
  {
    checkov: "CKV_TF_1",
    reason:
      "Module sources are Terraform Registry addresses pinned to one exact version (module-versions.ts), " +
      "and `npm run check:modules` verifies every pinned release's interface. A git commit hash is how a " +
      "git source is pinned; it does not apply to a registry module, which resolves by version.",
  },
  {
    checkov: "CKV_AWS_374",
    reason:
      "Restricting viewers by country is the plan owner's access policy, not a default the generator can " +
      "choose: the distribution starts open, and the web ACL filters by request rather than by geography.",
  },
  {
    checkov: "CKV2_AWS_42",
    enforcedWith: "dns",
    reason:
      "Enforced wherever the plan has a DNS zone: the zone's name is served on an ACM certificate of its " +
      "own (us-east-1, DNS-validated in that zone). A distribution with no zone in front of it has only " +
      "its *.cloudfront.net name, which no certificate but CloudFront's default one can cover.",
  },
  {
    checkov: "CKV_AWS_174",
    enforcedWith: "dns",
    reason:
      "Follows from CKV2_AWS_42 and is enforced with it: on its own certificate a distribution's viewer " +
      "floor is TLSv1.2_2021. On the default certificate CloudFront sets the viewer security policy itself " +
      "and `minimum_protocol_version` cannot be chosen. Viewers are still redirected to HTTPS, and origins " +
      "accept TLSv1.2 only.",
  },
  {
    checkov: "CKV_AWS_310",
    reason:
      "Each distribution fronts one origin, the serving tier the model holds. An origin group needs a " +
      "second, independent copy of that tier to fail over to, which the model does not have.",
  },
  {
    checkov: "CKV_AWS_305",
    enforcedWith: "static-site",
    reason:
      "Set to index.html, and enforced, whenever the distribution fronts a static site. Any other origin " +
      "is an application (app, containers, function) that routes \"/\" itself; a default root object " +
      "would rewrite its root request to a file it does not serve.",
  },
  {
    checkov: "CKV_AWS_86",
    trivy: "AWS-0010",
    reason:
      "Every request to the distribution passes its web ACL, whose logging configuration (CKV2_AWS_31, " +
      "enforced) records each one. CloudFront standard logs would need a further, ACL-enabled S3 bucket " +
      "the model does not have.",
  },
  {
    checkov: "CKV2_AWS_47",
    reason:
      "Checkov asks for AWSManagedRulesAnonymousIpList beside KnownBadInputs. KnownBadInputs is attached " +
      "and enforced through CKV_AWS_192 (the Log4j rule). The anonymous-IP list blocks VPN, Tor and " +
      "cloud-hosting addresses, which locks out API clients and corporate VPN users: an access policy for " +
      "the owner to choose.",
  },
  {
    checkov: "CKV_AWS_158",
    trivy: "AWS-0017",
    reason:
      "CloudWatch Logs encrypts every log group at rest. A customer-managed key for the WAF log group " +
      "would need its own key policy granting the CloudWatch Logs service in us-east-1; the plan's " +
      "monitoring log groups use the same service-side encryption.",
  },
  {
    checkov: "CKV2_AWS_57",
    reason:
      "Rotation needs a rotation Lambda that changes the credential at its source, and that depends on " +
      "what the secret is for: the plan creates the secret for the application to fill. It is encrypted " +
      "under its own rotating customer-managed key (CKV_AWS_149, enforced).",
  },

  // Inside the registry modules. trivy reads every module call through to the
  // resources it creates, and these are the findings there that are not a gap in
  // what the plan passes in.
  {
    trivy: "AWS-0053",
    reason:
      "The application load balancer is the plan's entry point from the internet; an internal one would " +
      "serve nobody. Its security group admits 80 and 443 only, and its egress reaches only the targets " +
      "registered behind it.",
  },
  {
    trivy: "AWS-0054",
    reason:
      "A load balancer the plan's DNS zone points at serves HTTPS on a certificate for that name, and " +
      "plain HTTP only redirects to it. Any other has only the *.elb.amazonaws.com name AWS assigns, which " +
      "no public certificate can be issued for, so its one listener is HTTP.",
  },
  {
    trivy: "AWS-0104",
    reason:
      "ECS tasks and EC2 instances reach the internet through the NAT gateway to pull images, ship logs and " +
      "call AWS APIs (SSM, CloudWatch, ECR), none of which has a VPC endpoint in the plan, so their egress " +
      "is open; their ingress is only what the edges admit. The load balancer, which needs no internet, " +
      "has egress to its targets only.",
  },
  {
    trivy: "AWS-0089",
    reason:
      "Every bucket logs its access to a log bucket of its own. The log bucket is the one that is not " +
      "logged: logging it would need a further bucket, and that one another, without end.",
  },
  {
    trivy: "AZU-0022",
    enforcedWith: "postgres",
    reason:
      "Every Azure database is closed to public access and reached through a private endpoint in the plan's " +
      "network. trivy 0.74 reads a MySQL Flexible Server's public access only from public_network_access_enabled " +
      "and assumes true when it is absent; the module sets the argument azurerm 4.x takes, public_network_access " +
      "= \"Disabled\", so every MySQL server reads as public. Enforced wherever the plan has PostgreSQL, whose " +
      "setting trivy does read.",
  },

  // Google Cloud.
  {
    checkov: "CKV_GCP_79",
    reason:
      "The PostgreSQL major is the reviewer's choice among the supported versions the model offers (15 to 18), " +
      "and Cloud SQL runs each of them. checkov accepts only the newest major, 18, so a plan on an older " +
      "supported major is flagged for being one; MySQL 8.4, the only MySQL the model offers, passes. Versions " +
      "past end of life are not offered at all.",
  },
  {
    checkov: "CKV_GCP_62",
    reason:
      "Every bucket logs its access to a log bucket of its own. The log bucket is the one that is not " +
      "logged: logging it would need a further bucket, and that one another, without end.",
  },
  {
    checkov: "CKV_GCP_83",
    enforcedWith: "key-vault",
    reason:
      "Enforced wherever the plan has a secret store: every topic is then encrypted under its key, with a grant " +
      "to the Pub/Sub service agent. Without one there is no key to name, and Pub/Sub encrypts every topic at " +
      "rest under a Google-managed key.",
  },
  {
    checkov: "CKV_GCP_81",
    enforcedWith: "key-vault",
    reason:
      "Enforced wherever the plan has a secret store: every dataset is then encrypted under its key, with a " +
      "grant to BigQuery's encryption service account. Without one there is no key to name, and BigQuery " +
      "encrypts every dataset at rest under a Google-managed key.",
  },
  {
    checkov: "CKV_GCP_38",
    trivy: "GCP-0033",
    reason:
      "Compute Engine encrypts every disk at rest under a Google-managed key. checkov asks for a " +
      "customer-supplied key, whose raw key would be written into the plan and its state: no secret goes " +
      "into the output. A customer-managed key needs a key and a grant to the Compute Engine service " +
      "agent, which the plan's secret store provides only when the model draws one.",
  },
  {
    trivy: "GCP-0066",
    enforcedWith: "key-vault",
    reason:
      "Enforced wherever the plan has a secret store: every bucket, the log and source buckets the plan adds " +
      "too, is then encrypted under its key, with a grant to the Cloud Storage service agent. Without one " +
      "there is no key to name, and buckets are encrypted at rest under a Google-managed key.",
  },
  {
    checkov: "CKV_GCP_82",
    reason:
      "A Cloud KMS key is never deleted, only its versions are scheduled for destruction, and a trial has " +
      "to be destroyable: lifecycle.prevent_destroy would stop `terraform destroy` for the whole plan.",
  },
  {
    checkov: "CKV_GCP_65",
    reason:
      "RBAC by Google Group needs a Google Workspace group the plan cannot create, in a domain only the " +
      "owner knows. Cluster access follows IAM until the owner adds `authenticator_groups_config`.",
  },
  {
    checkov: "CKV_GCP_69",
    reason:
      "The node pool sets workload_metadata_config.mode = GKE_METADATA, which turns the metadata server on " +
      "for every node the cluster runs, and checkov passes that resource. It also reads the cluster, which " +
      "has no node_config of its own: it sets remove_default_node_pool, so the pool it is created with is " +
      "deleted before any workload runs, and a node_config written only for that pool would configure " +
      "nodes that never serve.",
  },
  {
    trivy: "GCP-0072",
    reason:
      "The one rule that admits traffic inside the network, from the subnetwork's own ip_cidr_range and nothing else " +
      "(the address space is validated as private space, RFC 1918 or 100.64.0.0/10, so the source can never be public), as Google's " +
      "default network does: instances of one plan reach each other on any port. A rule that named ports could not " +
      "know what the plan's workloads listen on. A source from the internet is a different finding (GCP-0027, " +
      "GCP-0070, GCP-0071), which is not skipped.",
  },
  {
    trivy: "GCP-0074",
    reason:
      "The same internal rule: its source is the subnetwork's own private range, so the port range is the plan's own " +
      "traffic. Ingress from the internet on a wide range is still GCP-0027, which is not skipped.",
  },
];

/** The entries that exempt a document holding these kinds from `tool`. */
export function skipsFor(tool: "checkov" | "trivy", kinds: ReadonlySet<string>): ScannerSkip[] {
  return SCANNER_SKIPS.filter(
    (skip) => skip[tool] !== undefined && !(skip.enforcedWith && kinds.has(skip.enforcedWith)),
  );
}
