#!/usr/bin/env node
import { main, reportError } from './entry.mjs';
main('cursor').catch(reportError);
