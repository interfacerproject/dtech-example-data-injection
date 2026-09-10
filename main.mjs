#!/usr/bin/env node

/**
 * Backward-compatible entry point.
 *
 * The old direct GraphQL/REST implementation was removed so every supported
 * entry point uses the current @dyne/interfacer-client SDK.
 */

import { main } from "./init-data-sdk.mjs";

main().catch(error => {
  console.error("\n✗ Data injection failed:", error);
  process.exitCode = 1;
});
