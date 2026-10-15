#!/usr/bin/env node
process.env.AGENT_STAFF_BACKEND = 'cursor';
await import('./agy-companion.mjs');
