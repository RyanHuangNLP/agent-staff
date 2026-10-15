#!/usr/bin/env node
process.env.AGENT_STAFF_BACKEND = 'codex';
await import('./agy-companion.mjs');
