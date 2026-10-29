/** Keys filled with zeros, and let go of. */
export const wipe = (identities: Set<Uint8Array>) => {
	identities.forEach((identity) => identity.fill(0));
	identities.clear();
};

export const sameIdentity = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((byte, at) => byte === b[at]);
