import { concatBytes } from '../../age/bytes.js';
import { asObject, parseJson } from '../../json.js';
import { basename, parentPath } from '../../paths.js';
import type { RequestParts } from '../http.js';
import { ConflictError, NotFoundError, ProviderResponseError, type RemoteEntry } from '../types.js';
import type { AppFolder } from './root.js';
import {
	API,
	type DriveClient,
	type DriveFile,
	earliest,
	FIELDS,
	MULTIPART_LIMIT,
	NOTE_TYPE,
	toEntry,
	UPLOADS,
} from './wire.js';

/**
 * Bytes up to Drive: in one multipart request, or resumable over the
 * multipart limit, or over a note's bytes in place (`update`).
 */

const encoder = new TextEncoder();

/**
 * A multipart upload: the metadata, then the bytes. Per RFC 2046 the line
 * break before a delimiter belongs to the delimiter, so the content goes up
 * exactly as it is, trailing newline or not. Built as bytes, since what is
 * between the delimiters need not be text.
 */
const multipart = (metadata: object, content: Uint8Array, type: string): RequestParts => {
	const boundary = `skysa-${crypto.randomUUID()}`;
	const head = [
		`--${boundary}`,
		'content-type: application/json; charset=UTF-8',
		'',
		JSON.stringify(metadata),
		`--${boundary}`,
		`content-type: ${type}`,
		'',
		'',
	].join('\r\n');
	return {
		headers: { 'content-type': `multipart/related; boundary=${boundary}` },
		body: concatBytes([
			encoder.encode(head),
			content,
			encoder.encode(`\r\n--${boundary}--\r\n`),
		]),
	};
};

/**
 * Where a resumable upload's bytes go: the `Location` Drive answers the
 * first request with. Taken only on Drive's own host, which is the one the
 * token is for and the one `connect-src` allows; anything else is refused
 * rather than sent the token. Whether the header is exposed to a page on
 * another origin at all is on the live-check list (docs/ARCHITECTURE.md §5.1).
 */
const sessionUri = (location: string | null): string => {
	// Told apart, because which it is answers the live check: a header the
	// page was not shown reads as `null`.
	if (location === null) {
		throw new ProviderResponseError(
			'gdrive started a resumable upload and did not say where it is'
		);
	}
	const url = ((): URL | undefined => {
		try {
			return new URL(location);
		} catch {
			return undefined;
		}
	})();
	if (url?.origin !== API) {
		throw new ProviderResponseError(
			'gdrive started a resumable upload somewhere it will not be sent'
		);
	}
	return url.toString();
};

export const createUploads = (client: DriveClient, appFolder: AppFolder) => {
	const { send, attempt, call, failureOf, raise, fileUrl, named, settleCreate } = client;
	const { folderIdAt, itemAt } = appFolder;

	/**
	 * A file over the multipart limit: the metadata to start a session, then
	 * every byte in one `PUT` to it. What the `PUT` answers with is the file,
	 * but not certainly with the fields the start asked for — and `create` reads
	 * every one of them: the revision is the version, and the time it was made
	 * is what settles it against a file another device made at the same name. So
	 * where any is missing, the file is asked for again.
	 */
	const resumable = async (
		metadata: object,
		content: Uint8Array<ArrayBuffer>,
		type: string,
		path: string
	): Promise<DriveFile> => {
		const started = await send('POST', `${UPLOADS}?uploadType=resumable&fields=${FIELDS}`, {
			headers: { 'content-type': 'application/json; charset=UTF-8' },
			body: JSON.stringify(metadata),
		});
		if (!started.ok) return raise(await failureOf(started), path);
		const sent = await send('PUT', sessionUri(started.headers.get('location')), {
			headers: { 'content-type': type },
			body: content,
		});
		if (!sent.ok) return raise(await failureOf(sent), path);
		// Not JSON reads as nothing made, which is what it tells us.
		const made = asObject(parseJson(await sent.text())) as DriveFile;
		if (made.id === undefined || made.id === '') {
			throw new ProviderResponseError(
				'gdrive finished a resumable upload and did not say what it made'
			);
		}
		const whole = [made.headRevisionId, made.createdTime, made.name, made.size].every(
			(field) => field !== undefined && field !== ''
		);
		return whole ? made : call<DriveFile>('GET', fileUrl(made.id), {}, path);
	};

	/**
	 * Create-only, which Drive has no word for: look, create, look again. A file
	 * already there is a conflict before anything is sent; one another device
	 * made in the moment between is a conflict after, with ours deleted.
	 *
	 * `mimeType` is what Drive records; `type` is the part's own header, which
	 * for a note says its charset.
	 */
	const create = async (
		path: string,
		content: Uint8Array<ArrayBuffer>,
		mimeType: string,
		type: string
	): Promise<RemoteEntry> => {
		const name = basename(path);
		const parentId = await folderIdAt(parentPath(path));
		const existing = earliest(await named(parentId, name));
		if (existing !== undefined) throw new ConflictError(toEntry(existing, path));

		const metadata = { name, mimeType, parents: [parentId] };
		const made =
			content.length <= MULTIPART_LIMIT
				? await call<DriveFile>(
						'POST',
						`${UPLOADS}?uploadType=multipart&fields=${FIELDS}`,
						multipart(metadata, content, type)
					)
				: await resumable(metadata, content, type, path);
		const winner = await settleCreate(parentId, made);
		if (winner.id !== made.id) throw new ConflictError(toEntry(winner, path));
		return toEntry(made, path);
	};

	const createNote = (path: string, content: string): Promise<RemoteEntry> =>
		create(
			path,
			// A copy, for the one `BodyInit` takes in every runtime: bytes over an
			// `ArrayBuffer`. A note is small; a file arrives as one already.
			new Uint8Array(encoder.encode(content)),
			NOTE_TYPE,
			`${NOTE_TYPE}; charset=UTF-8`
		);

	/**
	 * By id, never by path, so a file deleted since the caller saw it is not
	 * made again. Compared first, then uploaded: Drive offers nothing to make
	 * the two one step, and a write landing between them is overwritten. The
	 * next `changes` pass reports the result, and nothing the user wrote on this
	 * device is lost; what the other device wrote in that moment may be.
	 */
	const update = async (
		path: string,
		content: string,
		expected: string
	): Promise<RemoteEntry> => {
		const current = await itemAt(path);
		if (current === undefined) throw new NotFoundError(path);
		const entry = toEntry(current, path);
		if (entry.kind === 'folder' || entry.version !== expected) throw new ConflictError(entry);

		const result = await attempt<DriveFile>(
			'PATCH',
			`${UPLOADS}/${encodeURIComponent(entry.remoteId)}?uploadType=media&fields=${FIELDS}`,
			{ headers: { 'content-type': NOTE_TYPE }, body: content }
		);
		if (result.ok) return toEntry(result.value, path);
		if (result.failure.status === 404) throw new NotFoundError(path);
		return raise(result.failure, path);
	};

	return { create, createNote, update };
};
