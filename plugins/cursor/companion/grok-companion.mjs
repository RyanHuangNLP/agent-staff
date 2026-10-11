#!/usr/bin/env node
process.env.AGENT_STAFF_BACKEND = 'grok';
await import('./agy-companion.mjs');
