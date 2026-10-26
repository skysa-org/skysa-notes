export {
	APP_FOLDER_NAME,
	APP_NAME,
	MARKER_FILE,
	MARKER_SCHEMA_VERSION,
	PROVIDER_KINDS,
	NOTE_EXTENSION,
	HIDDEN_PREFIX,
	CLIPBOARD_FOLDER,
	CLIPBOARD_ITEMS,
	ENCRYPTION_FILE,
	ENCRYPTION_SCHEMA_VERSION,
	SCRATCHPAD_FOLDER,
	VAULT_FOLDER,
	type ProviderKind,
} from './config.js';

export { SCRATCH_COLORS, scratchColor, type ScratchColor } from './scratchpad.js';

export {
	clipName,
	clipPath,
	clipStamp,
	isClipPath,
	readClipName,
	type ClipKind,
	type ClipName,
} from './clipboard.js';

export {
	buildMarker,
	parseMarker,
	serializeMarker,
	type Marker,
	type MarkerCreatedBy,
	type BuildMarkerInput,
	type MarkerParseResult,
} from './marker.js';

export {
	alwaysAllowed,
	type ConnectCodeCheck,
	type ConnectGate,
	ENTITLEMENT_CODES,
	type EntitlementCode,
	type EntitlementContext,
	type EntitlementDecision,
	type EntitlementProvider,
	type EntitlementSubject,
	MAX_CODE_HOLD_SECONDS,
	MAX_CODE_REASON,
	MAX_CONNECT_CODE,
	neverLimited,
	type RateLimitDecision,
	type RateLimiter,
} from './entitlements.js';

export {
	AuthError,
	type ChangeEntry,
	type DeletedEntry,
	type ChangeSet,
	ConflictError,
	type CreateFileOptions,
	CursorResetError,
	type EntryRef,
	isAuthError,
	isConflictError,
	isCursorResetError,
	isNotFoundError,
	isRateLimitError,
	isUnreadableError,
	NotFoundError,
	type ProviderErrorCode,
	ProviderResponseError,
	RateLimitError,
	type RemoteEntry,
	type StorageProvider,
	UnreadableError,
	type WriteOptions,
} from './providers/types.js';

export { withoutNul } from './providers/text.js';

export { createDropboxProvider, type DropboxProviderOptions } from './providers/dropbox.js';
export { type FetchLike, parseRetryAfter } from './providers/http.js';

export { createGDriveProvider, type GDriveProviderOptions } from './providers/gdrive/index.js';
export { createOneDriveProvider, type OneDriveProviderOptions } from './providers/onedrive.js';

export {
	createFakeProvider,
	type FakeCall,
	type FakeFault,
	type FakeOperation,
	type FakeProvider,
	type FakeProviderOptions,
} from './providers/fake.js';

export {
	conflictContent,
	conflictFilename,
	conflictFilePath,
	conflictFolderPath,
	conflictPath,
	conflictStamp,
} from './sync/conflicts.js';

export {
	createSyncEngine,
	type SyncEngine,
	type SyncEngineOptions,
	type SyncOutcome,
	type SyncProgress,
	type SyncStatus,
} from './sync/engine.js';

export { messageOf } from './sync/outcome.js';

export {
	type ConflictResolution,
	type FileChange,
	isFileChange,
	isNoteChange,
	type NoteChange,
	noteIdOf,
	type OpOutcome,
	pathOf,
	type PullBatch,
	type PullChange,
	remoteOf,
	type SyncFile,
	type SyncFolder,
	type SyncNote,
	type SyncOp,
	type SyncOperation,
	type SyncStore,
	type UnreadableFile,
} from './sync/store.js';

export {
	contentTypeOf,
	downloadName,
	drawsFromData,
	fileKind,
	type FileKind,
	opensInTab,
	safeOpenType,
	showsInline,
} from './attachments.js';

export {
	imageInfo,
	MAX_COPY_PIXELS,
	PICTURE_WIDTHS,
	pictureVariant,
	THUMB_BOX,
	type PictureFormat,
	type PictureInfo,
	type PictureVariant,
	type PictureVariantSize,
} from './pictures.js';

export {
	RELAY_CHANGED,
	RELAY_CLOSE,
	RELAY_PING,
	RELAY_PONG,
	RELAY_PUSHED,
	RELAY_PUSHED_INTERVAL_MS,
} from './relay.js';

export * from './age/index.js';
export * from './hash.js';
export * from './markdown/index.js';
export * from './password.js';
export * from './paths.js';
export * from './sealing.js';
export * from './sites.js';
export * from './secrets.js';
export * from './vault.js';
