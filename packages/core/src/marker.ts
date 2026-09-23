import { z } from 'zod';

import { APP_NAME, MARKER_SCHEMA_VERSION, PROVIDER_KINDS } from './config.js';

/**
 * Debug-only provenance: which install created this folder, with what version.
 * Deliberately carries no account identifiers. See docs/ARCHITECTURE.md §3.
 */
const createdBySchema = z.object({
	appVersion: z.string().min(1),
	provider: z.enum(PROVIDER_KINDS),
	/** Random UUID per browser install, from IndexedDB `syncState`. Not an account id. */
	clientId: z.string().min(1),
	userAgent: z.string().optional(),
});

const markerSchema = z.object({
	schemaVersion: z.number().int().positive(),
	app: z.string().min(1),
	createdAt: z.string().min(1),
	createdBy: createdBySchema,
});

export type MarkerCreatedBy = z.infer<typeof createdBySchema>;
export type Marker = z.infer<typeof markerSchema>;

export interface BuildMarkerInput {
	appVersion: string;
	provider: MarkerCreatedBy['provider'];
	clientId: string;
	userAgent?: string;
	/** Injectable for deterministic tests. */
	now?: Date;
}

/**
 * Build the marker written by `ensureRoot()` on first connect. The sync engine
 * never rewrites it afterward, so a second device does not overwrite the first
 * device's provenance.
 */
export const buildMarker = (input: BuildMarkerInput): Marker => ({
	schemaVersion: MARKER_SCHEMA_VERSION,
	app: APP_NAME,
	createdAt: (input.now ?? new Date()).toISOString(),
	createdBy: {
		appVersion: input.appVersion,
		provider: input.provider,
		clientId: input.clientId,
		...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
	},
});

export const serializeMarker = (marker: Marker): string => `${JSON.stringify(marker, null, 2)}\n`;

/** JSON.parse as a result rather than an exception, so callers stay expressions. */
const readJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
};

export type MarkerParseResult =
	/** Marker understood; the connection may sync normally. */
	| { status: 'ok'; marker: Marker }
	/**
	 * The folder was written by a newer client. Open read-only with a banner
	 * rather than risk writing a layout this version does not understand.
	 */
	| { status: 'read-only'; marker: Marker; reason: 'newer-schema' }
	/** Not a marker this app wrote, or not JSON at all. */
	| { status: 'invalid'; reason: string };

/**
 * Parse `.notesapp.json`. Applies the read-only-on-newer-version rule from
 * docs/ARCHITECTURE.md §3.
 */
export const parseMarker = (text: string): MarkerParseResult => {
	const json = readJson(text);
	if (!json.ok) return { status: 'invalid', reason: 'not valid JSON' };

	const parsed = markerSchema.safeParse(json.value);
	if (!parsed.success) {
		return {
			status: 'invalid',
			reason: parsed.error.issues[0]?.message ?? 'does not match marker schema',
		};
	}

	const marker = parsed.data;
	if (marker.app !== APP_NAME) {
		return { status: 'invalid', reason: `marker belongs to a different app: ${marker.app}` };
	}
	if (marker.schemaVersion > MARKER_SCHEMA_VERSION) {
		return { status: 'read-only', marker, reason: 'newer-schema' };
	}
	return { status: 'ok', marker };
};
