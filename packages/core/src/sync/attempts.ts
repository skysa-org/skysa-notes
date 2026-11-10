import type { SyncOp } from './store.js';

/**
 * Whether an op has been given up on for now, and is holding up everything
 * queued behind it. The one statement of the rule: the engine stops a batch at
 * `attempts >= maxAttempts` (`drainOps` in `push/drain.ts`), a scheduler names
 * the op by it, and an app calls what it has not sent blocked by it.
 *
 * Never an `rmdir`, because the engine makes the same exception: one that is
 * out of attempts is completed as done and stepped over — it tidies an empty
 * directory away, nothing behind it depends on that, and it is not the user's
 * work. Calling it blocked would tell the user their documents cannot be sent
 * while the engine is about to send them.
 *
 * An `upload` is the other exception, and only half of one. The engine steps
 * over it too, so it holds nothing up — but it is the only copy of the file,
 * so it is kept, and the run ends `blocked` on its account (`drained` in the
 * engine). So it counts here: what a scheduler says and this rule must agree.
 */
export const outOfAttempts = (
	op: Readonly<{ op: SyncOp['op']; attempts: number }>,
	maxAttempts: number
): boolean => op.op !== 'rmdir' && op.attempts >= maxAttempts;
