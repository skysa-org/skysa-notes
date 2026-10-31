import { useEffect, useRef, useState } from 'react';

import { DialogActions } from '../../components/ui/Dialog.js';
import { Icon } from '../../components/ui/icons.js';
import { t } from '../../i18n/t.js';
import { clearLink, setLink } from '../rich/actions/link.js';
import { type PanelProps, ToolbarPopover } from './menus.js';
import type { FormatToolbarProps } from './types.js';

/**
 * What the empty address field shows: the start of an address, which is the
 * same in every language and so stays out of the catalog.
 */
const ADDRESS_START = 'https://';

/**
 * The field inside the link panel.
 *
 * Mounted with the panel and thrown away with it, so the URL it starts from is
 * whatever the cursor was in when the panel opened — no effect to keep it in
 * step with a `format.link` that changes as the user moves around underneath.
 */
export const LinkForm = ({
	href: current,
	run,
	close,
}: {
	href: string | null;
	run: FormatToolbarProps['run'];
	close: () => void;
}) => {
	const [href, setHref] = useState(current ?? '');
	const field = useRef<HTMLInputElement>(null);

	useEffect(() => {
		field.current?.focus();
		field.current?.select();
	}, []);

	return (
		<form
			className="toolbar-link"
			onSubmit={(event) => {
				event.preventDefault();
				const url = href.trim();
				if (url === '') return;
				run(setLink(url));
				close();
			}}
		>
			<label htmlFor="toolbar-link-url">{t('editor.toolbar.linkTo')}</label>
			<input
				id="toolbar-link-url"
				ref={field}
				type="url"
				inputMode="url"
				placeholder={ADDRESS_START}
				value={href}
				onChange={(event) => {
					setHref(event.target.value);
				}}
			/>
			{/* A dialog's row (`DialogActions`): the answer last. Its way out is
			    Escape, or a press outside it, as for any of the toolbar's panels. */}
			<DialogActions
				primary={
					<button type="submit" disabled={href.trim() === ''}>
						{t('editor.toolbar.applyLink')}
					</button>
				}
			>
				{current !== null && (
					<button
						type="button"
						onClick={() => {
							run(clearLink);
							close();
						}}
					>
						{t('editor.toolbar.removeLink')}
					</button>
				)}
			</DialogActions>
		</form>
	);
};

/**
 * The link button and the panel under it.
 *
 * The field is a real text field, so the editor does lose focus to it. That is
 * why the commands here act on the ProseMirror selection rather than on the
 * browser's: the selection outlives the blur, and the editor is handed focus
 * back the moment the panel closes.
 */
export const LinkPanel = ({ format, run, open, setOpen, stop }: PanelProps) => (
	<ToolbarPopover
		id="link"
		label={t('editor.toolbar.link')}
		trigger={<Icon name="link" />}
		open={open}
		setOpen={setOpen}
		stop={stop}
	>
		<LinkForm
			href={format.link}
			run={run}
			close={() => {
				setOpen(false);
			}}
		/>
	</ToolbarPopover>
);
