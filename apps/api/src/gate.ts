import {
	type ConnectGate,
	ENTITLEMENT_CODES,
	type EntitlementCode,
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
	connectCode: z.object({ label: text(40) }).optional(),
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
export const checkGate = (gate: ConnectGate | undefined): ConnectGate | undefined => {
	if (gate === undefined) return undefined;
	const result = gateSchema.safeParse(gate);
	if (!result.success) {
		const issues = result.error.issues.map(
			(issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
		);
		throw new Error(`Invalid connect gate:\n${issues.map((issue) => `  ${issue}`).join('\n')}`);
	}
	return result.data;
};

/**
 * What `/start` takes as the gate's code (`EntitlementContext.connectCode`),
 * on its way into the flow cookie and from there to the policy.
 *
 * Bounded (`MAX_CONNECT_CODE`), because it rides in the flow cookie. Printable,
 * because it is something a person typed, and a policy should not have to
 * wonder what a control character in it means. Blank is the same as none: a
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
