/**
 * The Worker log, for failures a request answers without throwing — a provider
 * refusing an exchange or a refresh, say. Nothing else would tell the operator,
 * and to the user an expired client secret looks like an ordinary failure.
 *
 * Only an error's name and first line go in. Provider errors carry their OAuth
 * code alone (`OAuthError`), never a token, a code or a description that quotes
 * the request back.
 */
export const logFailure = (context: string, error: unknown): void => {
	const detail =
		error instanceof Error
			? `${error.name}: ${error.message.split('\n')[0] ?? ''}`
			: 'non-error thrown';
	console.error(`${context}: ${detail}`);
};

/**
 * A deployment's configuration refused (`parseEnv`, or `createApp` on a bad
 * gate): the whole message, every line of it, since what is wrong is the
 * operator's to put right and this is the only place it is said.
 */
export const logMisconfiguration = (error: Error): void => {
	console.error(error.message);
};
