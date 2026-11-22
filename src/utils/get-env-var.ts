// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

export function getEnvVar(varValue: string | undefined, varName: string): string {
  if (varValue === undefined)
    throw new ReferenceError(`Reference to undefined env var: ${varName}`);
  return varValue;
}
