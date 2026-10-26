export { parse, serialize, normalize, STRINGIFY_OPTIONS } from './pipeline.js';
export { toLf, firstLineEnding, withLineEnding, type LineEnding } from './lineEndings.js';
export {
	firstStructuralDifference,
	roundTripsLosslessly,
	sameMarkdownStructure,
	type StructuralDifference,
} from './fidelity.js';
export {
	splitFrontmatter,
	joinFrontmatter,
	readFrontmatter,
	readNoteTimes,
	writeFrontmatter,
	frontmatterIsEditable,
	frontmatterHasDeclinedId,
	type SplitDocument,
	type NoteFrontmatter,
	type NoteTimes,
} from './frontmatter.js';
export { readTime } from './time.js';
export { decodeCharacterReferences } from './references.js';
export { headings, type Heading } from './outline.js';
export {
	previewBlocks,
	type PreviewLine,
	previewLines,
	previewLineText,
	type PreviewMark,
	type PreviewMarker,
	type PreviewEmbed,
	type PreviewRun,
	previewText,
} from './preview.js';
export {
	attachmentHref,
	attachmentLabel,
	attachmentMarkdown,
	type AttachmentKind,
	type AttachmentWords,
	classifyHref,
	type HrefKind,
	isAttachmentHref,
	linkedFiles,
	MAX_ATTACHMENT_BYTES,
	resolveRelative,
} from './attachments.js';
export { deriveTitle, titleFromFilename, UNTITLED_TITLE, type DeriveTitleInput } from './title.js';
export {
	parseNoteFile,
	serializeNoteFile,
	type ParsedNoteFile,
	type ParseNoteFileOptions,
	type SerializeNoteFileInput,
} from './note.js';
export {
	hidesAsSecret,
	isSecretBlock,
	rewriteSecrets,
	SECRET_LANGUAGE,
	secretBlocksIn,
	secretFile,
	secretLabel,
	withoutArmor,
} from './secretBlocks.js';
