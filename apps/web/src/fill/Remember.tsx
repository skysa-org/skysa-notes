import { type Site, siteAddress, siteLabel } from '@skysa/core';
import { useId, useState } from 'react';

import { KEEP_OUT } from '../components/passwords/keepOut.js';
import { Icon } from '../editor/icons.js';
import { t } from '../i18n/t.js';
import type { FillSource, Login, Match } from './matches.js';
import type { Offer, Saving, Wrote } from './remembering.js';

/**
 * What the fill window offers for a password typed on the page
 * (docs/ARCHITECTURE.md §7, "Filling in on a site"): nothing, where it is
 * saved already; Update, naming the password it replaces, where it is the new
 * password of the one saved for this site and username; else Save, a form
 * with the label, username, password and Site it is saved with, which the
 * user can change first, and the source, where there is more than one.
 */

export interface RememberProps {
	page: Site;
	typed: Login;
	offer: Offer;
	/** The sources it can be saved in. */
	sources: readonly FillSource[];
	press: (run: () => void) => () => void;
	onSave: (saving: Saving) => Promise<Wrote | 'failed'>;
	onUpdate: (match: Match) => Promise<Wrote | 'failed'>;
	/** The way to Passwords, where the source's Vault dialog puts the device right. */
	onOpenPasswords: () => void;
}

type Came = Wrote | 'failed' | undefined;

/** What a write that did not go through says. */
const Said = ({ came, onOpenPasswords }: { came: Came; onOpenPasswords: () => void }) => {
	if (came === undefined || (came !== 'failed' && came.state === 'written')) return null;
	if (came !== 'failed' && came.state === 'refused') {
		return (
			<>
				<p role="alert">{came.why.message}</p>
				{came.why.way !== undefined && (
					<button type="button" onClick={onOpenPasswords}>
						{t('fill.openPasswords')}
					</button>
				)}
			</>
		);
	}
	const words =
		came === 'failed'
			? t('fill.remember.failed')
			: came.state === 'changed'
				? t('fill.remember.changed')
				: t('fill.remember.unknown');
	return <p role="alert">{words}</p>;
};

const SaveForm = ({
	page,
	typed,
	sources,
	onSave,
	onCancel,
	onCame,
}: Pick<RememberProps, 'page' | 'typed' | 'sources' | 'onSave'> & {
	onCancel: () => void;
	onCame: (came: Came) => void;
}) => {
	const ids = {
		label: useId(),
		username: useId(),
		password: useId(),
		site: useId(),
		siteHint: useId(),
		source: useId(),
	};
	const [label, setLabel] = useState(siteLabel(page));
	const [username, setUsername] = useState(typed.username);
	const [password, setPassword] = useState(typed.password);
	const [site, setSite] = useState(siteAddress(page));
	const [connectionId, setConnectionId] = useState(sources[0]?.connectionId ?? '');
	const [revealed, setRevealed] = useState(false);
	const [busy, setBusy] = useState(false);

	return (
		<form
			className="password-form fill-save"
			aria-label={t('fill.remember.saving')}
			onSubmit={(event) => {
				event.preventDefault();
				if (busy) return;
				setBusy(true);
				void onSave({
					connectionId,
					label: label.trim() === '' ? siteLabel(page) : label,
					username,
					password,
					site,
				}).then((came) => {
					setBusy(false);
					onCame(came);
				});
			}}
		>
			<label htmlFor={ids.label}>{t('passwords.item.label')}</label>
			<input
				id={ids.label}
				type="text"
				value={label}
				{...KEEP_OUT}
				onChange={(event) => {
					setLabel(event.target.value);
				}}
			/>
			<label htmlFor={ids.username}>{t('passwords.item.username')}</label>
			<input
				id={ids.username}
				type="text"
				value={username}
				{...KEEP_OUT}
				onChange={(event) => {
					setUsername(event.target.value);
				}}
			/>
			<label htmlFor={ids.password}>{t('passwords.item.password')}</label>
			<div className="password-entry">
				<input
					id={ids.password}
					type="text"
					className={revealed ? undefined : 'password-masked'}
					value={password}
					{...KEEP_OUT}
					onChange={(event) => {
						setPassword(event.target.value);
					}}
				/>
				<button
					type="button"
					className="icon"
					title={revealed ? t('passwords.item.hide') : t('passwords.item.show')}
					aria-label={revealed ? t('passwords.item.hide') : t('passwords.item.show')}
					onClick={() => {
						setRevealed((now) => !now);
					}}
				>
					<Icon name={revealed ? 'eye-off' : 'eye'} />
				</button>
			</div>
			<label htmlFor={ids.site}>{t('passwords.item.site')}</label>
			<input
				id={ids.site}
				type="text"
				inputMode="url"
				value={site}
				aria-describedby={ids.siteHint}
				{...KEEP_OUT}
				onChange={(event) => {
					setSite(event.target.value);
				}}
			/>
			<p id={ids.siteHint} className="password-hint">
				{t('passwords.item.siteHint')}
			</p>
			{sources.length > 1 && (
				<>
					<label htmlFor={ids.source}>{t('fill.remember.source')}</label>
					<select
						id={ids.source}
						value={connectionId}
						onChange={(event) => {
							setConnectionId(event.target.value);
						}}
					>
						{sources.map((source) => (
							<option key={source.connectionId} value={source.connectionId}>
								{source.name}
							</option>
						))}
					</select>
				</>
			)}
			<div className="password-actions">
				<button type="button" onClick={onCancel}>
					{t('passwords.item.cancel')}
				</button>
				<button type="submit" className="primary" disabled={busy}>
					{t('fill.remember.submit')}
				</button>
			</div>
		</form>
	);
};

export const Remember = ({
	page,
	typed,
	offer,
	sources,
	press,
	onSave,
	onUpdate,
	onOpenPasswords,
}: RememberProps) => {
	const [saving, setSaving] = useState(false);
	const [came, setCame] = useState<Came>(undefined);
	const [busy, setBusy] = useState(false);

	if (offer.kind === 'saved') return <p className="muted">{t('fill.remember.saved')}</p>;
	if (offer.kind === 'update') {
		const { label } = offer.match;
		return (
			<section className="fill-remember" aria-label={t('fill.remember.heading')}>
				<p>{t('fill.remember.updateText', { label })}</p>
				<button
					type="button"
					disabled={busy}
					onClick={press(() => {
						setBusy(true);
						void onUpdate(offer.match).then((wrote) => {
							setBusy(false);
							setCame(wrote);
						});
					})}
				>
					{t('fill.remember.update', { label })}
				</button>
				<Said came={came} onOpenPasswords={onOpenPasswords} />
			</section>
		);
	}
	if (sources.length === 0) return null;
	return (
		<section className="fill-remember" aria-label={t('fill.remember.heading')}>
			{saving ? (
				<SaveForm
					page={page}
					typed={typed}
					sources={sources}
					onSave={onSave}
					onCancel={() => {
						setSaving(false);
						setCame(undefined);
					}}
					onCame={setCame}
				/>
			) : (
				<>
					<p>{t('fill.remember.saveText')}</p>
					<button
						type="button"
						onClick={() => {
							setSaving(true);
						}}
					>
						{t('fill.remember.save')}
					</button>
				</>
			)}
			<Said came={came} onOpenPasswords={onOpenPasswords} />
		</section>
	);
};
