#!/usr/bin/env node
import { main } from '../src/cli.mjs';
main().catch(error => { console.error(`ReMCP: ${error.message}`); process.exit(1); });
