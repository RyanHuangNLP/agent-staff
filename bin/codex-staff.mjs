#!/usr/bin/env node
import { main, reportError } from './entry.mjs';
main('codex').catch(reportError);
