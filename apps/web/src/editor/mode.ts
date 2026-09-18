/**
 * Which editor a note is open in.
 *
 * Both modes are views over the same markdown string, so the mode is never part
 * of the note's file — it is a local preference about how to show it. Rich text
 * is the default; a note the rich editor would damage is forced to raw.
 * See docs/PLAN.md §7.
 */

export type EditorMode = 'rich' | 'raw';

export const DEFAULT_EDITOR_MODE: EditorMode = 'rich';

export const isEditorMode = (value: unknown): value is EditorMode =>
	value === 'rich' || value === 'raw';

export const otherMode = (mode: EditorMode): EditorMode => (mode === 'rich' ? 'raw' : 'rich');

export const MODE_LABELS: Record<EditorMode, string> = {
	rich: 'Rich text',
	raw: 'Markdown',
};
