// CI NEGATIVE CONTROL — DO NOT MERGE.
//
// Faithful reproduction of the bb-server outage class: a module-scope
// createClient() that throws during ESM evaluation. index.js registers
// process.on('uncaughtException') on line 1, but ESM evaluates every import
// BEFORE that line runs, so this throw is never caught — the process exits
// without reaching server.listen().
//
// Expected: `server (node --test)` stays GREEN (no test imports index.js —
// see the comment at the top of index.test.js), while `container-boot` FAILS
// at "assert bb-server reaches listening / health-ready".
import { createClient } from '@supabase/supabase-js';

export const CI_NEGATIVE_CONTROL = createClient('not-a-valid-url', 'placeholder-key');
