#!/usr/bin/env node
// Alias of `krun-router codex`: same implementation, arguments passed through unchanged.
import { main } from "../src/cli/main.mjs";

process.exit(await main(["codex", ...process.argv.slice(2)]));
