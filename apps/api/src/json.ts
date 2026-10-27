import type { z } from 'zod';

/**
 * JSON from outside this module's own code — a provider's answer, a cookie, a
 * relay frame, a stored secret — read and checked in one step (#450): `text`
 * as `schema` says it is, or nothing when it is not JSON or not that shape.
 * Never a cast, so nothing downstream reads a field that was never there. A
 * schema whose output can itself be `undefined` cannot be told from a refusal
 * here, so none is passed one.
 */
export const parseJson = <T>(text: string, schema: z.ZodType<T>): T | undefined => {
	try {
		const parsed = schema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
};

/**
 * Each issue zod found, as a line naming the field and what was wrong with it,
 * for a refusal at boot. The message never repeats the value, which can be a
 * secret.
 */
export const formatIssues = (
	issues: readonly Readonly<{ path: readonly PropertyKey[]; message: string }>[]
): string[] =>
	issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
