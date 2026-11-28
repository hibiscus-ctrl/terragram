// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Google Cloud plans the emit gate (`validate-emit.ts`) generates Terraform from beside its briefs and
 * the templates. The briefs and templates reach no GKE cluster, BigQuery dataset, virtual machine or project,
 * and none of them has both a key store and the Pub/Sub topic or bucket it encrypts, so those paths were never
 * through `terraform validate` or the scanners. Together these plans use every Google Cloud kind, which
 * `tests/emit-gate.test.ts` holds, so a kind added to the registry has to land in one of them.
 */
export type GcpPlan = { id: string; label: string; kinds: readonly string[] };

export const GCP_PLANS: readonly GcpPlan[] = [
  {
    id: "gcp-data",
    label: "Every data store under the key store's key: a bucket, Pub/Sub topics, a BigQuery dataset, the databases and an App Engine service",
    kinds: ["key-vault", "queue", "object-storage", "data-warehouse", "nosql", "postgres", "mysql", "redis-cache", "monitoring"],
  },
  {
    id: "gcp-platform",
    label: "A project with a private network, a GKE cluster and a virtual machine, and a key store",
    kinds: ["project", "vnet", "kubernetes", "virtual-machine", "key-vault", "object-storage"],
  },
  {
    id: "gcp-site",
    label: "A CDN with Cloud Armor and its own DNS zone in front of a static site, with a key store",
    kinds: ["dns", "front-door", "static-site", "key-vault", "object-storage"],
  },
  {
    id: "gcp-serverless",
    label: "A load balancer in front of Cloud Run and Functions, with a queue and no key store",
    kinds: ["load-balancer", "containers", "functions", "queue", "entra-id", "monitoring"],
  },
];
