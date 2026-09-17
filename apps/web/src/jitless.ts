import { z } from 'zod';

/**
 * Imported first by `main.tsx`, before any module that builds a schema.
 *
 * zod decides whether it may compile parsers with `new Function` the first time
 * an object schema is built, which in this app is at import time. Under the
 * Content-Security-Policy in `public/_headers` the probe is refused; zod
 * catches that, but the browser still reports a violation for it. Turning JIT
 * off skips the probe. Parsing is interpreted either way under this policy.
 * (zod's `allowsEval` in `v4/core/util.ts`; `jitless` is not in its docs.)
 */
z.config({ jitless: true });
