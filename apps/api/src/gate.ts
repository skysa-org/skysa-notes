import {
	type ConnectCodeCheck,
	type ConnectGate,
	ENTITLEMENT_CODES,
	type EntitlementCode,
	MAX_CODE_HOLD_SECONDS,
	MAX_CODE_REASON,
	MAX_CONNECT_CODE,
} from '@skysa/core';
import { z } from 'zod';

/**
 * What an operator's policy may say to the app, checked on the way out.
 *
 * The policy is the operator's code, handed in through `createApp`, and it is
 * trusted to decide — not to be well-formed. What it says reaches a browser as
 * a link and as words in a URL, so it is held to the same standard as the
 * environment is in `env.ts`: checked, and refused loudly when it is wrong.
 */

const text = (max: number) =>
	z
		.string()
		.trim()
		.min(1, 'must not be blank')
		.max(max, `must be at most ${String(max)} characters`);

/**
 * `https:` and nothing else. The link is followed from the app, and a
 * `javascript:` URL there is script on the page — the property `script-src
 * 'self'` exists to protect (CLAUDE.md). `http:` is refused as well: a link out
 * of an app served over TLS has no reason to leave it.
 *
 * Served as the parser reads it (`normalize`), not as written. With a protocol
 * of its own zod no longer insists on `//`, so `https:example.com` parses — and
 * in an `href` a browser resolves that against the page, into a path inside
 * the app. Normalized, it is `https://example.com/`, which is what was meant.
 */
const gateSchema = z.object({
	message: text(500),
	action: z.object({
		label: text(40),
		url: z
			.url({ protocol: /^https$/, normalize: true, error: 'must be an absolute https: URL' })
			.max(2048, 'must be at most 2048 characters'),
	}),
	connectCode: z.object({ label: text(40), required: z.boolean().optional() }).optional(),
});

/**
 * The gate as it will be served, or nothing when there is none. Throws when
 * there is one and it is wrong, which `createApp` lets through: the default
 * `src/worker.ts` turns that into a logged `server_misconfigured`, and an
 * operator's own entry would copy it. A gate half set is a deployment that
 * does not do what its operator thinks, and saying so at the first request
 * beats rendering a link to nowhere for months.
 *
 * The message names the field and never repeats the value.
 */
export const checkGate = (
	gate: ConnectGate | undefined,
	checksCodes: boolean
): ConnectGate | undefined => {
	if (gate === undefined) return undefined;
	const result = gateSchema.safeParse(gate);
	const issues = [
		...(result.success
			? []
			: result.error.issues.map(
					(issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
				)),
		// The app asks as a code is used, and a gate that asks for one with
		// nothing to answer would refuse every code there is.
		...(result.success && result.data.connectCode !== undefined && !checksCodes
			? ['connectCode: needs the policy to have checkCode']
			: []),
	];
	if (!result.success || issues.length > 0) {
		throw new Error(`Invalid connect gate:\n${issues.map((issue) => `  ${issue}`).join('\n')}`);
	}
	return result.data;
};

/**
 * What `checkCode` said, as the app will be told it, or nothing when it said
 * something that is not a `ConnectCodeCheck`.
 *
 * Its reason is the policy's words in front of the person typing, so it is
 * held to what the gate's own text is: plain, printable and bounded. A reason
 * that is not is dropped rather than failing the answer, since the refusal is
 * still a refusal and the app has words of its own for one. A hold longer than
 * a year is cut to a year, and a fraction of a second is rounded up; a hold of
 * nothing, or of a number that is not one, is no answer at all.
 *
 * A value to hold in place of the code is held to what a code is, since the
 * app sends it as one (`connectCodeSchema`): bounded and printable. One that is
 * not fails the answer rather than being dropped, since dropping it would have
 * the app keep the typed code instead, which the policy just said it would
 * rather not.
 */
const codeCheckSchema = z.discriminatedUnion('accepted', [
	z.object({
		accepted: z.literal(true),
		expiresIn: z
			.number()
			.positive()
			.transform((seconds) => Math.min(Math.ceil(seconds), MAX_CODE_HOLD_SECONDS)),
		hold: z
			.string()
			.trim()
			.min(1)
			.max(MAX_CONNECT_CODE)
			.regex(/^\P{C}*$/u)
			.optional(),
	}),
	z.object({
		accepted: z.literal(false),
		reason: z
			.string()
			.trim()
			.min(1)
			.max(MAX_CODE_REASON)
			.regex(/^\P{C}*$/u)
			.optional()
			.catch(undefined),
	}),
]);

export const readCodeCheck = (answer: unknown): ConnectCodeCheck | undefined => {
	const result = codeCheckSchema.safeParse(answer);
	if (!result.success) return undefined;
	const check = result.data;
	if (check.accepted) {
		return check.hold === undefined
			? { accepted: true, expiresIn: check.expiresIn }
			: { accepted: true, expiresIn: check.expiresIn, hold: check.hold };
	}
	return check.reason === undefined
		? { accepted: false }
		: { accepted: false, reason: check.reason };
};

/**
 * What `/start` takes as the gate's code (`EntitlementContext.connectCode`),
 * on its way into the flow cookie and from there to the policy: typed, or
 * held in its place (`ConnectCodeCheck.hold`).
 *
 * Bounded (`MAX_CONNECT_CODE`), because it rides in the flow cookie. Printable,
 * because it is something a person typed or a policy issued as text, and a
 * policy should not have to wonder what a control character in it means. Blank is the same as none: a
 * field left empty is not a code.
 */
export const connectCodeSchema = z
	.string()
	.trim()
	.max(MAX_CONNECT_CODE)
	.regex(/^\P{C}*$/u, 'must be printable')
	.transform((code) => (code === '' ? undefined : code))
	.optional();

/**
 * A refusal's code, if it is one the app has words for. Anything else is
 * dropped rather than passed on: the callback puts it in a URL, and a value
 * outside the fixed list would be text the policy chose — which is what
 * `reason` is kept out of that URL for.
 */
export const knownCode = (code: unknown): EntitlementCode | undefined =>
	ENTITLEMENT_CODES.find((known) => known === code);
