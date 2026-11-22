import { assembleModel } from "./engine.ts";
import type { InfraModel } from "./model.ts";

/**
 * Starting points. Each template is a set of kinds run through the same assembler a
 * chat turn uses, so a template can never describe a graph the emitter would reject —
 * and adding a kind to the registry makes it available here for free.
 */

export type WorkspaceTemplate = {
  id: string;
  name: string;
  summary: string;
  kinds: string[];
};

export const WORKSPACE_TEMPLATES: readonly WorkspaceTemplate[] = [
  {
    id: "web-app",
    name: "Web app and database",
    summary: "A public web tier behind a CDN, with Postgres, a cache and a secret store.",
    kinds: ["front-door", "app-service", "postgres", "redis-cache", "key-vault"],
  },
  {
    id: "event-driven-api",
    name: "Event-driven API",
    summary: "Containers behind a load balancer, with a queue, a NoSQL store and monitoring.",
    kinds: ["load-balancer", "containers", "queue", "nosql", "monitoring"],
  },
  {
    id: "static-site",
    name: "Static site",
    summary: "A static front end on a CDN with its own DNS zone and object storage.",
    kinds: ["dns", "front-door", "static-site", "object-storage"],
  },
  {
    id: "serverless-backend",
    name: "Serverless backend",
    summary: "Functions behind an API edge, with a queue, NoSQL storage and identity.",
    kinds: ["front-door", "functions", "queue", "nosql", "entra-id", "monitoring"],
  },
];

/** Instantiate a template's model. Pure, so the picker can preview it without a round trip. */
export function templateModel(template: WorkspaceTemplate): InfraModel {
  return assembleModel(template.kinds, undefined, true).model;
}

export function templateById(id: string): WorkspaceTemplate | undefined {
  return WORKSPACE_TEMPLATES.find((t) => t.id === id);
}
