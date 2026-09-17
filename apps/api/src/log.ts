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
