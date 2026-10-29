import { type ConnectGate, MAX_CONNECT_CODE } from '@skysa/core';
import { type RefObject, useEffect, useId, useState } from 'react';

import { type ApiClient, ApiError } from '../../../api/client.js';
import { rich } from '../../../i18n/rich.js';
import { t } from '../../../i18n/t.js';
import {
	connectCodeHeldUntil,
	heldConnectCode,
	heldConnectCodeShown,
	holdAcceptedCode,
	watchConnectCode,
} from '../../../store/connectCode.js';

/**
 * Asks the operator's policy about a code, and holds it — or what the policy
 * gave in its place — for as long as the policy says where it is accepted.
 * Otherwise, what to say under the field:
 * the policy's reason, or this app's words for a refusal without one, a limit
 * reached, or no answer at all.
 */
export const askAbout = async (
	client: Pick<ApiClient, 'checkConnectCode'>,
	code: string
): Promise<string | undefined> => {
	// What is said under the field when the code could not be asked about.
	const notChecked = () => t('sources.code.notChecked');
	try {
		const result = await client.checkConnectCode(code);
		if (!result.ok) return notChecked();
		if (!result.value.accepted) return result.value.reason ?? t('sources.code.notAccepted');
		holdAcceptedCode(code, result.value);
		return undefined;
	} catch (error) {
		return error instanceof ApiError && error.status === 429
			? t('sources.code.tooMany')
			: notChecked();
	}
};

/** The longest delay `setTimeout` takes as meant; one longer fires at once. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

/** What the gate knows of the code it holds: whether it may show it, and until when it is good. */
interface HeldCode {
	readonly code: string;
	readonly until: number;
	readonly shown: boolean;
}

/**
 * The code held for the gate. Read at every render rather than kept, since the
 * hold ends by the clock and another tab can take or drop one, with a render
 * when it ends, so a gate showing it goes back to asking, and one whenever this
 * tab changes it — the app asking about it again as it loads, say. `onLapse`
 * is told which code it was.
 */
export const useHeldCode = (onLapse: (code: string) => void): HeldCode | undefined => {
	const until = connectCodeHeldUntil();
	const code = until === undefined ? undefined : heldConnectCode();
	const shown = heldConnectCodeShown();
	const [woken, setWoken] = useState(0);
	useEffect(
		() =>
			watchConnectCode(() => {
				setWoken((n) => n + 1);
			}),
		[]
	);
	useEffect(() => {
		if (code === undefined || until === undefined) return;
		// A timer longer than a browser can count (2³¹ ms, about 25 days) fires at
		// once, and a hold may run a year: so it wakes at the most, and is set
		// again from there (`woken`) until the hold has truly ended.
		const timer = setTimeout(
			() => {
				setWoken((n) => n + 1);
				if (Date.now() >= until) onLapse(code);
			},
			Math.min(Math.max(0, until - Date.now()) + 50, LONGEST_TIMER_MS)
		);
		return () => {
			clearTimeout(timer);
		};
	}, [code, until, onLapse, woken]);
	return code === undefined || until === undefined ? undefined : { code, until, shown };
};

/**
 * Which step `ConnectChoice` has open: the one picked, where the gate allows
 * a pick, and until then the buttons for a device that is in already and the
 * gate for any other. A gate whose code is required is open whenever no code
 * is held, whatever was picked.
 */
export const openStep = (
	asked: ConnectGate['connectCode'],
	picked: 'gate' | 'buttons' | undefined,
	holding: boolean,
	live: boolean
): 'gate' | 'buttons' => {
	if (asked === undefined) return picked ?? (live ? 'buttons' : 'gate');
	if (asked.required === true) return holding ? (picked ?? 'buttons') : 'gate';
	return picked ?? (holding || live ? 'buttons' : 'gate');
};

/**
 * The gate's code step (`ConnectGate.connectCode`): the field under the
 * operator's label and the button that uses it, which asks the operator's
 * policy whether the code will do (`checkCode`) before anything is connected.
 * Before the policy could be asked, any code at all looked accepted until the
 * provider sent the person back. Under them, after a refusal, why: in the
 * policy's words where it gave some. A live region, since the answer comes
 * after the press that asked for it; the button says it is asking meanwhile,
 * and stays pressable so the focus is not lost from under it.
 *
 * A one-time code to the browser, so a code the operator sent by email or text
 * can be offered from there. Taken as typed, with nothing capitalised or
 * corrected: whether case matters is the policy's to say. A blank one cannot
 * be used, since there is nothing to ask about.
 */
export const ConnectCodeForm = ({
	label,
	code,
	field,
	checking,
	problem,
	onChange,
	onUse,
}: {
	label: string;
	code: string;
	field: RefObject<HTMLInputElement | null>;
	checking: boolean;
	problem: string | undefined;
	onChange: (typed: string) => void;
	onUse: () => void;
}) => {
	const id = useId();
	const blank = code.trim() === '';
	return (
		<form
			className="connect-code-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (!blank && !checking) onUse();
			}}
		>
			<label htmlFor={id}>{label}</label>
			<span className="connect-code-row">
				<input
					ref={field}
					id={id}
					value={code}
					maxLength={MAX_CONNECT_CODE}
					autoComplete="one-time-code"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					aria-invalid={problem === undefined ? undefined : true}
					aria-describedby={`${id}-said`}
					onChange={(event) => {
						onChange(event.target.value);
					}}
				/>
				{/* Both words, one of them hidden, so the button is as wide as the
				    longer and the menu does not change width while it asks. */}
				<button type="submit" className="connect-code-use" disabled={blank}>
					<span aria-hidden={checking}>{t('sources.code.use')}</span>
					<span aria-hidden={!checking}>{t('sources.code.checking')}</span>
				</button>
			</span>
			<span className="connect-code-said" id={`${id}-said`} role="status">
				{problem}
			</span>
		</form>
	);
};

/**
 * The time a held code stops being good, with the day where it is not today,
 * and the year where it is not this one: a hold may run a year, and "Tue,
 * Oct 5" on the Monday before would read as tomorrow.
 */
const untilFormat = (until: number, now = Date.now()): string =>
	new Intl.DateTimeFormat(undefined, {
		...(new Date(until).toDateString() === new Date(now).toDateString()
			? {}
			: { weekday: 'short', month: 'short', day: 'numeric' }),
		...(new Date(until).getFullYear() === new Date(now).getFullYear()
			? {}
			: { year: 'numeric' }),
		hour: 'numeric',
		minute: '2-digit',
	}).format(until);

/**
 * The code step folded while the buttons are open: the code they will send and
 * until when the policy said it is good, or, where a code is not required,
 * that they will send none. What the policy gave to hold in place of a code
 * is not named, only that the code was accepted on this device: it was never
 * the person's to read, and it can be long. Its control opens the step again, which hides the
 * buttons, so the code and the buttons are never both open and what is on
 * screen is only ever the next thing to do.
 */
export const ConnectCodeLine = ({
	label,
	held,
	onOpen,
}: {
	label: string;
	held: HeldCode | undefined;
	onOpen: () => void;
}) =>
	held === undefined ? (
		<p className="connect-code-line">
			<button type="button" className="link-button" onClick={onOpen}>
				{t('sources.code.enter')}
			</button>
		</p>
	) : (
		<p className="connect-code-line">
			<span>
				{held.shown
					? rich(
							'sources.code.held',
							{ code: (words) => <code title={words}>{words}</code> },
							{ label, value: held.code }
						)
					: t('sources.code.accepted', { label })}{' '}
				<button
					type="button"
					className="link-button"
					aria-label={t('sources.code.changeLabel', { label })}
					onClick={onOpen}
				>
					{t('sources.code.change')}
				</button>
			</span>
			<span className="connect-code-until">
				{t('sources.code.until', { time: untilFormat(held.until) })}
			</span>
		</p>
	);
