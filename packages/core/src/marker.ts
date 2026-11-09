import { z } from 'zod';

import { PROVIDER_KINDS } from './config.js';
import type { MarkerSpec } from './folderSpec.js';
import { parseJson } from './json.js';

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
	/** The app it names, and the layout version it was written at. */
	marker: MarkerSpec;
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
	schemaVersion: input.marker.version,
	app: input.marker.app,
	createdAt: (input.now ?? new Date()).toISOString(),
	createdBy: {
		appVersion: input.appVersion,
		provider: input.provider,
		clientId: input.clientId,
		...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
	},
});

export const serializeMarker = (marker: Marker): string => `${JSON.stringify(marker, null, 2)}\n`;

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
 * Parse a marker against `spec`, the reading app's: one naming another app is not its.
 * Applies the read-only-on-newer-version rule from docs/ARCHITECTURE.md §3.
 */
export const parseMarker = (text: string, spec: MarkerSpec): MarkerParseResult => {
	const json = parseJson(text);
	if (json === undefined) return { status: 'invalid', reason: 'not valid JSON' };

	const parsed = markerSchema.safeParse(json);
	if (!parsed.success) {
		return {
			status: 'invalid',
			reason: parsed.error.issues[0]?.message ?? 'does not match marker schema',
		};
	}

	const marker = parsed.data;
	if (marker.app !== spec.app) {
		return { status: 'invalid', reason: `marker belongs to a different app: ${marker.app}` };
	}
	if (marker.schemaVersion > spec.version) {
		return { status: 'read-only', marker, reason: 'newer-schema' };
	}
	return { status: 'ok', marker };
};
