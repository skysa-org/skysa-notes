/**
 * The age code, as a chunk of its own (`secrets/age.ts`), loaded the first time
 * a secret needs it and kept from then on.
 */
export const loadAge = () => import('./age.js');

export type Age = Awaited<ReturnType<typeof loadAge>>;
