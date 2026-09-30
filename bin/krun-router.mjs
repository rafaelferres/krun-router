#!/usr/bin/env node
// krun-router: see src/cli/main.mjs.
import { main } from "../src/cli/main.mjs";

process.exit(await main(process.argv.slice(2)));
