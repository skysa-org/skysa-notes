/**
 * The Web Lock a sync of one connection runs under (`sync/scheduler.ts`), so
 * that one tab syncs a connection at a time. Web Locks are the origin's own,
 * so the name has only this app's tabs to agree with — but those include a tab
 * still running an older build, which takes the lock by the name that build
 * had: a different name here and the two would sync the same connection at
 * once. It is the scheduler's to be given rather than its own to choose, so
 * that the scheduler names no app (docs/decisions/0018-the-shared-kit.md).
 */
export const SYNC_LOCK = (connectionId: string): string => `skysa-notes:sync:${connectionId}`;
