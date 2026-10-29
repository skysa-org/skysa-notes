import type { ConnectGate, ProviderKind } from '@skysa/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient } from '../../../api/client.js';
import { t } from '../../../i18n/t.js';
import { heldConnectCode, heldConnectCodeShown } from '../../../store/connectCode.js';
import type { NotesDatabase } from '../../../store/db.js';
import { PROVIDER_LABELS } from '../../../sync/account.js';
import { ConnectButton } from '../../ConnectButton.js';
import { ProviderIcon } from '../../ProviderIcon.js';
import {
	askAbout,
	ConnectCodeForm,
	ConnectCodeLine,
	openStep,
	useHeldCode,
} from './ConnectCode.js';

interface ConnectButtonsProps {
	db: NotesDatabase;
	client: Pick<ApiClient, 'config' | 'startConnect' | 'checkConnectCode'>;
	offerable: readonly ProviderKind[];
	returnTo: string;
	navigate: ((url: string) => void) | undefined;
	className?: string;
}

/** A button per provider another account can be connected from. */
const ConnectButtons = ({
	db,
	client,
	offerable,
	returnTo,
	navigate,
	className = 'toolbar-item',
}: ConnectButtonsProps) =>
	offerable.map((provider) => (
		<ConnectButton
			key={provider}
			db={db}
			client={client}
			provider={provider}
			returnTo={returnTo}
			className={className}
			{...(navigate === undefined ? {} : { navigate })}
		>
			<ProviderIcon kind={provider} />
			{PROVIDER_LABELS[provider]}
		</ConnectButton>
	));

/**
 * The operator's link out. In this window, as connecting storage is: a new
 * one, in an app installed on a phone, was a second window with no way back
 * from it but closing the app. The operator's page sends the user back here
 * with `?enter=code` (`routes/search.ts`), which opens the code field.
 * `noreferrer`, so the page is not told which note was open.
 */
const GateLink = ({ action }: { action: ConnectGate['action'] }) => (
	<a href={action.url} rel="noreferrer">
		{action.label}
	</a>
);

/**
 * The connect buttons, or what the operator of this instance says in front of
 * them (`ConnectGate` in `@skysa/core`, served from `/api/config`): "sync here
 * is part of the paid plan", and where to go about it. Without a gate this is
 * the buttons and nothing else.
 *
 * With one, a device that already has an account syncing here sees the
 * buttons anyway, with the gate as a line above them: its account was let in
 * at least once, and a notice standing between it and a second account would
 * be a wall in front of someone already inside. A device with none sees the
 * gate instead, and one more control that shows the buttons after all —
 * someone the policy allows has to have a way in, and showing them grants
 * nothing, since the server decides at the callback either way
 * (docs/ARCHITECTURE.md §6).
 *
 * Rendered inside the group each caller already names — the `+` menu's, and
 * the compact source panel's by its heading — so the gate is read out as part
 * of connecting, as the buttons are.
 *
 * A gate that asks for a code is two steps, one open at a time: the gate with
 * its code field, then the buttons. A code the policy accepts is held for as
 * long as it said (`store/connectCode.ts`), and while it is, the gate is folded
 * to a line naming it, or saying it was accepted where the policy gave
 * something to hold in its place (`ConnectCodeLine`), from which it opens again
 * and the buttons close. When the hold ends, here or while the app was closed, the gate
 * asks again. Where the operator made the code `required`, that is the only
 * way to the buttons, for every device. Where not, "Already have access?"
 * shows them without one, and a device with an account syncing here starts on
 * them, since it is there already.
 */
export const ConnectChoice = ({
	gate,
	live,
	openAt,
	...buttons
}: ConnectButtonsProps & {
	gate: ConnectGate | undefined;
	live: boolean;
	/** Asked for by the app's URL, at the code field (`useAdding`): changed, it opens there. */
	openAt: number | undefined;
}) => {
	const [picked, setPicked] = useState<'gate' | 'buttons'>();
	// Only a code the person typed goes back in the field: a value held in its
	// place was never theirs to edit.
	const [code, setCode] = useState(() =>
		heldConnectCodeShown() ? (heldConnectCode() ?? '') : ''
	);
	const [checking, setChecking] = useState(false);
	const [problem, setProblem] = useState<string>();
	// Where the focus goes next, counted so that the same place twice moves it
	// twice: the control pressed is gone once the other step opens, and the
	// focus with it.
	const [focus, setFocus] = useState<{ on: 'buttons' | 'field'; n: number }>();
	const move = (on: 'buttons' | 'field') => {
		setFocus((last) => ({ on, n: (last?.n ?? 0) + 1 }));
	};
	const choices = useRef<HTMLDivElement>(null);
	const field = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (focus?.on === 'buttons') choices.current?.querySelector('button')?.focus();
		if (focus?.on === 'field') field.current?.focus();
	}, [focus]);

	// Back from the operator's page for a code: the gate, whatever step was
	// open, with the focus in its field. Even with a code held — a new one is
	// what the user went for. In render, as React has state follow a prop.
	const [openedAt, setOpenedAt] = useState<number>();
	if (openAt !== undefined && openAt !== openedAt) {
		setOpenedAt(openAt);
		setPicked('gate');
		setFocus((last) => ({ on: 'field', n: (last?.n ?? 0) + 1 }));
	}

	// A code the policy has stopped taking is no use in the field.
	const held = useHeldCode(
		useCallback((lapsed: string) => {
			setCode((typed) => (typed.trim() === lapsed ? '' : typed));
		}, [])
	);

	if (gate === undefined) return <ConnectButtons {...buttons} />;

	const asked = gate.connectCode;
	const open = openStep(asked, picked, held !== undefined, live);

	const use = async () => {
		setChecking(true);
		setProblem(undefined);
		const said = await askAbout(buttons.client, code);
		setChecking(false);
		setProblem(said);
		if (said !== undefined) {
			move('field');
			return;
		}
		setPicked('buttons');
		move('buttons');
	};

	if (open === 'gate') {
		return (
			<div className="connect-gate">
				<p>{gate.message}</p>
				<p>
					<GateLink action={gate.action} />
				</p>
				{asked !== undefined && (
					<ConnectCodeForm
						label={asked.label}
						code={code}
						field={field}
						checking={checking}
						problem={problem}
						onChange={(typed) => {
							setCode(typed);
							setProblem(undefined);
						}}
						onUse={() => {
							void use();
						}}
					/>
				)}
				{asked?.required !== true && (
					<button
						type="button"
						className="link-button"
						onClick={() => {
							setPicked('buttons');
							move('buttons');
						}}
					>
						{t('sources.haveAccess')}
					</button>
				)}
			</div>
		);
	}
	return (
		<>
			{asked === undefined ? (
				<p className="connect-gate-note">
					{gate.message} <GateLink action={gate.action} />
				</p>
			) : (
				<ConnectCodeLine
					label={asked.label}
					held={held}
					onOpen={() => {
						setPicked('gate');
						move('field');
					}}
				/>
			)}
			{/* No box of its own (`display: contents`): only somewhere to find
			    the first button in. */}
			<div ref={choices} className="connect-choices">
				<ConnectButtons {...buttons} />
			</div>
		</>
	);
};
