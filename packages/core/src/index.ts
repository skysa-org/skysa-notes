/**
 * What the apps may use of core, by name (#449). A name is here because
 * something in `apps/` imports it, in its source or its tests (which assert
 * with core's real errors and functions), or, for four types, because an
 * operator's policy is written against them. One nothing outside core needs
 * stays in its module, so the surface is chosen rather than whatever a module
 * happens to export. `tests/exports.test.ts` lists the values and the types,
 * so a change to this list is a change a reviewer sees. The test doubles are
 * `@skysa/core/testing`.
 */

export { encrypt } from './age/age.js';
export { armor } from './age/armor.js';
export { parseRecipient, recipientOf } from './age/curve.js';
export { AgeError } from './age/errors.js';
export { encodeIdentity, generateIdentity } from './age/keys.js';
export { API_ERROR_CODES, type ApiErrorCode, AUTH_MODES, type AuthMode } from './api.js';
export { isEncryptionFile, isScratchPath, isVaultPath } from './appFolder.js';
export {
	APP_FOLDER_NAME,
	CLIPBOARD_FOLDER,
	CLIPBOARD_ITEMS,
	ENCRYPTION_FILE,
	NOTE_EXTENSION,
	PROVIDER_KINDS,
	type ProviderKind,
	SCRATCHPAD_FOLDER,
	VAULT_FOLDER,
} from './config.js';
// With the types a deployment's policy is written against (CLAUDE.md, the
// `EntitlementProvider` and `RateLimiter` seams): no app imports them, but an
// operator's code outside this repo does.
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
	GATE_LIMITS,
	MAX_CODE_HOLD_SECONDS,
	MAX_CODE_REASON,
	MAX_CONNECT_CODE,
	neverLimited,
	type RateLimitDecision,
	type RateLimiter,
} from './entitlements.js';
export {
	contentTypeOf,
	downloadName,
	drawsFromData,
	fileKind,
	opensInTab,
	safeOpenType,
	showsInline,
} from './files/attachments.js';
export { type ClipName, clipName, clipPath, clipStamp, readClipName } from './files/clipboard.js';
export { type FileKind } from './files/mediaTypes.js';
export {
	imageInfo,
	type PictureInfo,
	pictureVariant,
	type PictureVariant,
} from './files/pictures.js';
export { bytesHash, contentHash } from './hash.js';
export {
	attachmentHref,
	type AttachmentKind,
	attachmentLabel,
	attachmentMarkdown,
	classifyHref,
	isAttachmentHref,
	linkedFiles,
	MAX_ATTACHMENT_BYTES,
	resolveRelative,
} from './markdown/attachments.js';
export {
	firstStructuralDifference,
	sameMarkdownStructure,
	type StructuralDifference,
} from './markdown/fidelity.js';
export {
	frontmatterIsEditable,
	type NoteFrontmatter,
	readFrontmatter,
	splitFrontmatter,
	writeFrontmatter,
} from './markdown/frontmatter/index.js';
export { toLf } from './markdown/lineEndings.js';
export { type ParsedNoteFile, parseNoteFile, serializeNoteFile } from './markdown/note.js';
export { type Heading, headings } from './markdown/outline.js';
export { STRINGIFY_OPTIONS } from './markdown/pipeline.js';
export {
	previewBlocks,
	type PreviewEmbed,
	type PreviewLine,
	previewLineText,
	type PreviewMark,
	type PreviewMarker,
	type PreviewRun,
} from './markdown/preview.js';
export { decodeCharacterReferences } from './markdown/references.js';
export {
	isSecretBlock,
	rewriteSecrets,
	SECRET_LANGUAGE,
	secretBlocksIn,
	secretLabel,
	withoutArmor,
} from './markdown/secretBlocks.js';
export { deriveTitle, titleFromFilename, UNTITLED_TITLE } from './markdown/title.js';
export { clusters } from './names/bytes.js';
export { conflictFilePath, conflictFolderPath, conflictPath } from './names/conflicts.js';
export { extensionOf } from './names/extension.js';
export { foldName } from './names/fold.js';
export {
	attachmentName,
	normalizeTag,
	sanitizeFolderName,
	uniqueFilename,
	UNTITLED_SLUG,
} from './names/slug.js';
export {
	ancestorPaths,
	basename,
	isHidden,
	isWithin,
	joinPath,
	normalizePath,
	parentPath,
	pathSegments,
	rebasePath,
	replaceBasename,
	ROOT,
} from './paths.js';
export { createDropboxProvider } from './providers/dropbox.js';
export { createGDriveProvider } from './providers/gdrive/index.js';
export { type FetchLike } from './providers/http.js';
export { createOneDriveProvider } from './providers/onedrive.js';
export { withoutNul } from './providers/text.js';
export {
	AuthError,
	type EntryRef,
	isAuthError,
	isConflictError,
	isNotFoundError,
	isRateLimitError,
	isUnreadableError,
	NotFoundError,
	RateLimitError,
	type RemoteEntry,
	type StorageProvider,
} from './providers/types.js';
export {
	RELAY_CHANGED,
	RELAY_CLOSE,
	RELAY_PING,
	RELAY_PONG,
	RELAY_PUSHED,
	RELAY_PUSHED_INTERVAL_MS,
} from './relay.js';
export { SCRATCH_COLORS, type ScratchColor, scratchColor } from './scratchpad.js';
export {
	buildEncryptionFile,
	parseEncryptionFile,
	serializeEncryptionFile,
} from './secrets/encryptionFile.js';
export { readRecoveryKey, RECOVERY_KEY_PREFIX, recoveryKeyGroups } from './secrets/recoveryKey.js';
export { openSecret, opensSecret, resealSecret, sealSecret } from './secrets/sealing.js';
export { conflictContent } from './sync/conflicts.js';
export { createSyncEngine, type SyncEngine } from './sync/engine.js';
export { messageOf, type SyncOutcome } from './sync/outcome.js';
export { type SyncProgress } from './sync/progress.js';
export {
	type ConflictResolution,
	isFileChange,
	type NewSyncOp,
	type OpOutcome,
	type PullBatch,
	type PullChange,
	type SyncFile,
	type SyncFolder,
	type SyncNote,
	type SyncOp,
	type SyncOperation,
	type SyncStore,
	type UnreadableFile,
} from './sync/store.js';
export {
	generatePassword,
	PASSWORD_LENGTH,
	passwordLength,
	type PasswordOptions,
} from './vault/password.js';
export {
	fillsOn,
	pageSite,
	type Site,
	siteAddress,
	siteLabel,
	siteName,
	siteOf,
} from './vault/sites.js';
export {
	EMPTY_VAULT_FIELDS,
	isEmptyVaultFields,
	type PreviousPassword,
	readVaultPayload,
	vaultArmor,
	vaultBody,
	type VaultFields,
	vaultPayload,
	vaultPrevious,
	vaultUrls,
	withReplacedPassword,
	withVaultUrls,
} from './vault/vault.js';
