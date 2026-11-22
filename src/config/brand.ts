// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The product name and the domain its email is sent from, for the server code
 * that has to spell them out (transactional email). `terragram.dev` is the domain
 * the marketing pages already publish their contact addresses on.
 */

/** Display name — transactional email copy. */
export const APP_NAME = "Terragram";

const PRIMARY_DOMAIN = "terragram.dev";

/** Default sender for member-invite emails (overridable via `EMAIL_FROM`). */
export const INVITES_EMAIL = `invites@${PRIMARY_DOMAIN}`;
