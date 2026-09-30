#!/usr/bin/env node
// Alias of `krun-router claude`: same implementation, arguments passed through unchanged.
import { main } from "../src/cli/main.mjs";

process.exit(await main(["claude", ...process.argv.slice(2)]));
