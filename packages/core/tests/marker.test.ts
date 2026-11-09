import { describe, expect, it } from 'vitest';

import { buildMarker, parseMarker, serializeMarker } from '../src/marker.js';
import { TEST_FOLDER } from '../src/providers/fake.js';

const SPEC = TEST_FOLDER.marker;

const input = {
	marker: SPEC,
	appVersion: '0.1.0',
	provider: 'dropbox' as const,
	clientId: '018f3c4e-0000-7000-8000-000000000000',
	userAgent: 'Mozilla/5.0 (test)',
	now: new Date('2026-09-14T13:02:11.000Z'),
};

describe('buildMarker', () => {
	it('stamps the current schema version, app name, and ISO createdAt', () => {
		const marker = buildMarker(input);
		expect(marker).toEqual({
			schemaVersion: 1,
			app: 'test-app',
			createdAt: '2026-09-14T13:02:11.000Z',
			createdBy: {
				appVersion: '0.1.0',
				provider: 'dropbox',
				clientId: '018f3c4e-0000-7000-8000-000000000000',
				userAgent: 'Mozilla/5.0 (test)',
			},
		});
	});

	it('omits userAgent when not supplied', () => {
		const { userAgent: _userAgent, ...rest } = input;
		expect(buildMarker(rest).createdBy).not.toHaveProperty('userAgent');
	});

	it('carries no account identifiers', () => {
		const keys = Object.keys(buildMarker(input).createdBy);
		expect(keys).toEqual(['appVersion', 'provider', 'clientId', 'userAgent']);
	});
});

describe('serializeMarker', () => {
	it('round-trips through parseMarker', () => {
		const marker = buildMarker(input);
		const result = parseMarker(serializeMarker(marker), SPEC);
		expect(result).toEqual({ status: 'ok', marker });
	});

	it('writes pretty JSON with a trailing newline', () => {
		const text = serializeMarker(buildMarker(input));
		expect(text.endsWith('\n')).toBe(true);
		expect(text).toContain('\n  "app": "test-app"');
	});
});

describe('parseMarker', () => {
	it('rejects text that is not JSON', () => {
		expect(parseMarker('not json', SPEC)).toEqual({
			status: 'invalid',
			reason: 'not valid JSON',
		});
	});

	it('rejects JSON that is not a marker', () => {
		const result = parseMarker('{"hello":"world"}', SPEC);
		expect(result.status).toBe('invalid');
	});

	it('rejects a marker written by a different app', () => {
		const marker = { ...buildMarker(input), app: 'some-other-notes-app' };
		const result = parseMarker(JSON.stringify(marker), SPEC);
		expect(result.status).toBe('invalid');
		if (result.status === 'invalid') {
			expect(result.reason).toContain('some-other-notes-app');
		}
	});

	it('opens read-only when the folder was written by a newer client', () => {
		const marker = { ...buildMarker(input), schemaVersion: SPEC.version + 1 };
		const result = parseMarker(JSON.stringify(marker), SPEC);
		expect(result.status).toBe('read-only');
		if (result.status === 'read-only') {
			expect(result.reason).toBe('newer-schema');
			expect(result.marker.schemaVersion).toBe(SPEC.version + 1);
		}
	});

	it('reads by the spec it is given, so another app’s marker is that app’s alone', () => {
		const other = { file: '.otherapp.json', app: 'other-app', version: 1 };
		const theirs = serializeMarker(buildMarker({ ...input, marker: other }));
		expect(parseMarker(theirs, other).status).toBe('ok');
		expect(parseMarker(theirs, SPEC)).toEqual({
			status: 'invalid',
			reason: 'marker belongs to a different app: other-app',
		});
	});

	it('accepts an older schema version', () => {
		const marker = { ...buildMarker(input), schemaVersion: 1 };
		expect(parseMarker(JSON.stringify(marker), SPEC).status).toBe('ok');
	});
});
