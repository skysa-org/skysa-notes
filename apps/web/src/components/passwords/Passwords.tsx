import { useId, useMemo, useState } from 'react';

import { Icon } from '../../editor/icons.js';
import { t } from '../../i18n/t.js';
import type { NoteRecord } from '../../store/db.js';
import { titleShown } from '../../store/titles.js';
import { filterByLabel, PASSWORDS_LABEL } from '../../store/vault.js';
import { FillSetupDialog } from './FillSetupDialog.js';

/**
 * The source's passwords, in the notes' place (docs/ARCHITECTURE.md §7,
 * "Passwords in the vault"): their labels, A to Z, a field that narrows them
 * as it is typed in, `+` for a new one, and Fill on sites, which sets up the
 * bookmarklet that fills them in (`FillSetupDialog`). The labels are plain
 * text, so the list needs no unlock.
 *
 * `note-list` as a notebook's notes are, so a compact window shows it as it
 * shows them, and the rows are a note list's rows.
 */
export const Passwords = ({
	items,
	selectedId,
	onSelect,
	onAdd,
}: {
	/** The source's passwords, by label; `undefined` until read. */
	items: readonly NoteRecord[] | undefined;
	/** The item open beside the list. */
	selectedId: string | undefined;
	onSelect: (note: NoteRecord) => void;
	onAdd: () => void;
}) => {
	const [query, setQuery] = useState('');
	const shown = useMemo(
		() => (items === undefined ? undefined : filterByLabel(items, query)),
		[items, query]
	);
	const filterId = useId();
	const [settingUp, setSettingUp] = useState(false);

	return (
		<section className="note-list passwords" aria-label={PASSWORDS_LABEL}>
			<div className="pane-header">
				<h2>{PASSWORDS_LABEL}</h2>
				<div className="pane-actions">
					<button
						type="button"
						className="icon"
						title={t('fill.setup.title')}
						aria-label={t('fill.setup.title')}
						onClick={() => {
							setSettingUp(true);
						}}
					>
						<Icon name="bookmark" />
					</button>
					<button
						type="button"
						className="icon"
						title={t('passwords.list.add')}
						aria-label={t('passwords.list.add')}
						onClick={onAdd}
					>
						+
					</button>
				</div>
			</div>

			{items !== undefined && items.length > 0 && (
				<div className="passwords-filter">
					<Icon name="search" />
					<input
						id={filterId}
						type="search"
						value={query}
						placeholder={t('passwords.list.filter')}
						aria-label={t('passwords.list.filter')}
						autoComplete="off"
						spellCheck={false}
						onChange={(event) => {
							setQuery(event.target.value);
						}}
						onKeyDown={(event) => {
							if (event.key === 'Escape' && query !== '') {
								event.stopPropagation();
								setQuery('');
							}
						}}
					/>
				</div>
			)}

			{items?.length === 0 && (
				<p className="muted placeholder">{t('passwords.list.empty')}</p>
			)}
			{items !== undefined && items.length > 0 && shown?.length === 0 && (
				<p className="muted placeholder">
					{t('passwords.list.noMatch', { query: query.trim() })}
				</p>
			)}

			{shown !== undefined && shown.length > 0 && (
				<div className="note-rows">
					<ul>
						{shown.map((note) => {
							const selected = note.id === selectedId;
							return (
								<li key={note.id} className="row-item">
									<button
										type="button"
										className={selected ? 'row selected' : 'row'}
										aria-current={selected ? 'true' : undefined}
										onClick={() => {
											onSelect(note);
										}}
									>
										<Icon name="key" />
										<span className="note-title">
											{titleShown(note.title)}
											{note.dirty === 1 && (
												<span
													className="dot"
													title={t('notes.list.notSynced')}
													aria-label={t('notes.list.notSynced')}
												/>
											)}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				</div>
			)}
			{settingUp && (
				<FillSetupDialog
					onClose={() => {
						setSettingUp(false);
					}}
				/>
			)}
		</section>
	);
};
