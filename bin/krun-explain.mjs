#!/usr/bin/env node
// Alias of `krun-router explain`: same implementation, arguments passed through unchanged.
import { main } from "../src/cli/main.mjs";

process.exit(await main(["explain", ...process.argv.slice(2)]));
