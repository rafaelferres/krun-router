#!/usr/bin/env node
// Alias of `krun-router kimi`: same implementation, arguments passed through unchanged.
import { main } from "../src/cli/main.mjs";

process.exit(await main(["kimi", ...process.argv.slice(2)]));
