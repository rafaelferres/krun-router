#!/usr/bin/env node
// Alias of `krun-router opencode`: same implementation, arguments passed through unchanged.
import { main } from "../src/cli/main.mjs";

process.exit(await main(["opencode", ...process.argv.slice(2)]));
