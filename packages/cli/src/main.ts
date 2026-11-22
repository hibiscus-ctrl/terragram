// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { run } from "./cli.ts";

process.exitCode = await run(process.argv.slice(2));
