/**
 * A value that changes, where `let` is not allowed: the one way to hold one
 * (#457). The functional rules refuse `let` and mutation, and before this the
 * code held a changing value five ways — a `{ current }` object, a `Map` keyed
 * by one literal, and others — each to be learned where it was met. A cell is
 * written and read through `current`, which the lint rules allow, and is the
 * same shape as a React ref, so either can stand for the other.
 *
 * An empty one is `cell<T | undefined>(undefined)`.
 */
export interface Cell<T> {
	current: T;
}

// The one object literal of this shape; everywhere else, ESLint asks for this.
// eslint-disable-next-line no-restricted-syntax
export const cell = <T>(initial: T): Cell<T> => ({ current: initial });
