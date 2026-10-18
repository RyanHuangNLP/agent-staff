#!/usr/bin/env node
// Public AGY skill entry: a nested worker may inherit another backend's env.
process.env.AGENT_STAFF_BACKEND = 'agy';
await import('./agy-companion.mjs');
