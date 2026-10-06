import { parentPath } from '@skysa/core';
import { type AnyRouter } from '@tanstack/react-router';

import { fragmentOf, heldPlace, type Place, placeHash } from '../src/routes/place.js';

/**
 * Where the history entry in front says the user is (`routes/place.ts`): the
 * notebook and the note, by id, less the source they are in.
 */
export const placeIn = (router: AnyRouter): Place => {
	const held = heldPlace(router.state.location.state);
	if (held === undefined) return {};
	const { connectionId: _source, ...place } = held;
	return place;
};

/** The hash of the entry in front, without its `#`, as it is written. */
export const hashIn = (router: AnyRouter): string => fragmentOf(router.state.location.href);

/** The address of a note in its own notebook, as a link to it would be. */
export const noteUrl = (note: { path: string }): string =>
	`/#${placeHash(parentPath(note.path), note.path)}`;
