export {
	APP_FOLDER_NAME,
	APP_NAME,
	MARKER_FILE,
	MARKER_SCHEMA_VERSION,
	PROVIDER_KINDS,
	NOTE_EXTENSION,
	HIDDEN_PREFIX,
	type ProviderKind,
} from './config.js';

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
	type EntitlementDecision,
	type EntitlementProvider,
} from './entitlements.js';

export {
	AuthError,
	type ChangeEntry,
	type DeletedEntry,
	type ChangeSet,
	ConflictError,
	CursorResetError,
	type EntryRef,
	isAuthError,
	isConflictError,
	isCursorResetError,
	isNotFoundError,
	NotFoundError,
	type ProviderErrorCode,
	type RemoteEntry,
	type StorageProvider,
	type WriteOptions,
} from './providers/types.js';

export {
	createDropboxProvider,
	type DropboxProviderOptions,
	type FetchLike,
} from './providers/dropbox.js';

export { createGDriveProvider, type GDriveProviderOptions } from './providers/gdrive.js';
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
	conflictPath,
	conflictStamp,
} from './sync/conflicts.js';

export {
	createSyncEngine,
	type SyncEngine,
	type SyncEngineOptions,
	type SyncOutcome,
	type SyncStatus,
} from './sync/engine.js';

export type {
	ConflictResolution,
	OpOutcome,
	PullBatch,
	PullChange,
	SyncFolder,
	SyncNote,
	SyncOp,
	SyncOperation,
	SyncStore,
} from './sync/store.js';

export * from './hash.js';
export * from './markdown/index.js';
export * from './paths.js';
