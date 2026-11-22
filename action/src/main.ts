// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { run } from "./run.ts";
import { processHost } from "./workflow.ts";

process.exitCode = await run(processHost());
