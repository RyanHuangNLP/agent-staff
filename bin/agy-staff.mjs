#!/usr/bin/env node
import { main, reportError } from './entry.mjs';
main('agy').catch(reportError);
