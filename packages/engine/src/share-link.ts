// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/** The stored fields of a share link that decide whether it still opens. */
export type StoredShareLink = {
  created_by: string;
  expires_at: string;
  revoked_at: string | null;
};

/**
 * Whether a stored share link may open its workspace. Revoked and expired links
 * are dead, and so is one its workspace's owner did not create: a row written
 * by anyone else is a planted link the owner can neither see nor revoke, whatever
 * the database's policies let through when it was written.
 */
export function shareLinkOpens(
  link: StoredShareLink,
  workspaceOwnerId: string,
  nowMs: number = Date.now(),
): boolean {
  if (link.revoked_at !== null) return false;
  if (new Date(link.expires_at).getTime() < nowMs) return false;
  return link.created_by === workspaceOwnerId;
}
