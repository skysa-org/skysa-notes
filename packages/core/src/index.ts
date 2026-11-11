/**
 * What the apps may use of core, by name (#449). A name is here because
 * something in `apps/` imports it, in its source or its tests (which assert
 * with core's real errors and functions), or, for the kit's names at the end,
 * because an operator's code does. One nothing outside core needs stays in its
 * module, so the surface is chosen rather than whatever a module happens to
 * export. `tests/exports.test.ts` lists the values and the types, so a change
 * to this list is a change a reviewer sees. The test doubles are the kit's,
 * from each package's `/testing` entry.
 */

export { encrypt } from './age/age.js';
export { armor } from './age/armor.js';
export { parseRecipient, recipientOf } from './age/curve.js';
export { AgeError } from './age/errors.js';
export { encodeIdentity, generateIdentity } from './age/keys.js';
export {
	isEncryptionFile,
	isScratchPath,
	isVaultPath,
	NOTES_WATCH,
	syncsHidden,
	isPassedOver,
} from './appFolder.js';
export {
	APP_FOLDER_NAME,
	CLIPBOARD_FOLDER,
	CLIPBOARD_ITEMS,
	ENCRYPTION_FILE,
	NOTE_EXTENSION,
	NOTES_FOLDER,
	SCRATCHPAD_FOLDER,
	VAULT_FOLDER,
} from './config.js';
export {
	downloadName,
	drawsFromData,
	fileKind,
	opensInTab,
	safeOpenType,
	showsInline,
} from './files/attachments.js';
export { type ClipName, clipName, clipPath, clipStamp, readClipName } from './files/clipboard.js';
export {
	imageInfo,
	type PictureInfo,
	pictureVariant,
	type PictureVariant,
} from './files/pictures.js';
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
export { conflictContent } from './markdown/conflictCopy.js';
export { NOTE_FORMAT } from './markdown/format.js';
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
export { conflictPath } from './names/notes.js';
export {
	attachmentName,
	normalizeTag,
	sanitizeFolderName,
	uniqueFilename,
	UNTITLED_SLUG,
} from './names/slug.js';
export { SCRATCH_COLORS, type ScratchColor, scratchColor } from './scratchpad.js';
export {
	buildEncryptionFile,
	parseEncryptionFile,
	serializeEncryptionFile,
} from './secrets/encryptionFile.js';
export { readRecoveryKey, RECOVERY_KEY_PREFIX, recoveryKeyGroups } from './secrets/recoveryKey.js';
export { openSecret, opensSecret, resealSecret, sealSecret } from './secrets/sealing.js';
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
// The kit's protocol (`@skysa/protocol`, record 0018), as this barrel offered
// it before the kit: the apps import it from there, but an operator's code
// outside this repo imports it from here, the types its policy is written
// against among it (CLAUDE.md, the `EntitlementProvider` and `RateLimiter` seams).
export {
	alwaysAllowed,
	API_ERROR_CODES,
	type ApiErrorCode,
	AUTH_MODES,
	type AuthMode,
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
	PROVIDER_KINDS,
	type ProviderKind,
	type RateLimitDecision,
	type RateLimiter,
	RELAY_CHANGED,
	RELAY_CLOSE,
	RELAY_PING,
	RELAY_PONG,
	RELAY_PUSHED,
	RELAY_PUSHED_INTERVAL_MS,
} from '@skysa/protocol';
