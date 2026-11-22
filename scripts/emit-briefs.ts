// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The briefs the emit gate (`validate-emit.ts`) generates Terraform from, kept apart so
 * the tests that hold the CLI to the same output read the same list.
 */
export const BRIEFS = [
  "create the infrastructure which allows me to deploy a lambda to AWS, powered by Python",
  "A web app with a Postgres database and Redis cache",
  "A containerised API behind a load balancer with a queue, MySQL and monitoring",
  "A static site on a CDN with its own DNS zone and object storage",
  "Serverless functions with a queue, a NoSQL store, identity and a secret store, in a private network",
  "A containerised API behind a load balancer with a cache and a Postgres database, in a private network",
];
