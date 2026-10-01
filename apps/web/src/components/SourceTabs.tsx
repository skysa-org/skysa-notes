import { type ConnectGate, MAX_CONNECT_CODE, type ProviderKind } from '@skysa/core';
import { useLiveQuery } from 'dexie-react-hooks';
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from 'react';

import { api, type ApiClient, ApiError } from '../api/client.js';
import { answer, useInstanceConfig } from '../api/instanceConfig.js';
import { connectCodeHeldUntil, heldConnectCode, holdConnectCode } from '../store/connectCode.js';
import {
	type ConnectedSource,
	connectedSources,
	LABEL_LIMIT,
	renameSource,
	showConnection,
} from '../store/connection.js';
import { db as defaultDb, LOCAL_CONNECTION_ID, type NotesDatabase } from '../store/db.js';
import {
	anyConnected,
	CONNECT_FIRST_LABEL,
	CONNECTABLE,
	inOrder,
	PROVIDER_LABELS,
	tabName,
} from '../sync/account.js';
import { ConnectButton } from './ConnectButton.js';
import { useEscape } from './useEscape.js';

export interface SourceTabsProps {
	db?: NotesDatabase;
	client?: Pick<ApiClient, 'config' | 'startConnect' | 'checkConnectCode'>;
	/** Where the provider's callback should send the browser back to. */
	returnTo: string;
	/** Seam for tests: jsdom has no navigation. */
	navigate?: (url: string) => void;
	/**
	 * The app's search field, which the route owns and the bar shows at its
	 * right-hand end: it asks every source, so it belongs beside the sources
	 * rather than inside any one pane of the source showing. With it given the
	 * bar is always shown, since there is then always something in it.
	 */
	search?: ReactNode;
}

/**
 * Every set of notes on this device, across the top of the app.
 *
 * A device can hold several storage accounts at once, each its own silo — its
 * own notes, notebooks, queue and cursor (docs/ARCHITECTURE.md §6) — and until now the
 * only way between them was a list inside the storage panel at the foot of the
 * sidebar. That is a long way to go for something a user with two accounts
 * does all day, and it gave no standing answer to "which of these am I
 * looking at". Tabs are that answer.
 *
 * Everything `connectedSources` knows about is here, not only the live ones: a
 * detached source holds work its remote was never sent and is editable, so a
 * bar that left it out would be a bar that hides notes. The device's own pile
 * is here too, when it holds anything.
 *
 * `nav` and `aria-current`, not `role="tablist"`. The ARIA tab pattern owes
 * arrow-key navigation, a roving `tabindex` and an `aria-controls` pointing at
 * a panel — and the "panel" here is the entire application, which is not one
 * element and is not re-rendered as one. A row of links to places, with the
 * one you are at marked, is what this actually is, and it costs a screen
 * reader user nothing.
 */
/**
 * What the bar offers: the sources in the order they are shown, and the
 * providers another account can be connected from. Shared by the tabs and the
 * compact window's dropdown, which are the same choice drawn two ways.
 */
const useSourceChoices = (
	db: NotesDatabase,
	client: Pick<ApiClient, 'config' | 'startConnect' | 'checkConnectCode'>
) => {
	const sources = useLiveQuery(() => connectedSources(db), [db]);
	const config = useInstanceConfig(client);

	const settings = answer(config);
	const offerable =
		settings?.authMode === 'storage-first'
			? settings.providers.filter((provider) => CONNECTABLE.includes(provider))
			: [];

	const ordered = inOrder(sources ?? []);

	return {
		ordered,
		offerable,
		gate: settings?.connectGate,
		// This device has an account syncing here now, which the operator's
		// policy let in at least once: it is shown the buttons, with the gate
		// beside them rather than in front of them. A detached source does not
		// count — it syncs nowhere.
		live: ordered.some(
			(source) => source.connectionId !== LOCAL_CONNECTION_ID && source.detached === undefined
		),
		// "Connect another account" once there is one; before that, what
		// connecting is (`CONNECT_FIRST_LABEL`).
		connectLabel: anyConnected(ordered) ? 'Connect another account' : CONNECT_FIRST_LABEL,
		// The bar is the only place connections are made or chosen, so it is
		// here from the start — with nothing connected it is the `+` and nothing
		// else, which is the whole of what there is to offer. It goes away
		// entirely only when there is neither anything to show nor anything to
		// offer: a deployment with no providers, or a server that cannot be
		// reached, where an empty strip would be furniture standing in for a
		// choice nobody has.
		nothingToShow: sources === undefined || (sources.length === 0 && offerable.length === 0),
	};
};

export const SourceTabs = ({
	db = defaultDb,
	client = api,
	returnTo,
	navigate,
	search,
}: SourceTabsProps) => {
	const { ordered, offerable, gate, live, connectLabel, nothingToShow } = useSourceChoices(
		db,
		client
	);
	const first = connectLabel === CONNECT_FIRST_LABEL;
	const [renaming, setRenaming] = useState<{ id: string; width: number } | null>(null);
	const [adding, setAdding] = useState(false);
	const addFrame = useRef<HTMLDivElement>(null);
	const stopAdding = useCallback(() => {
		setAdding(false);
	}, []);

	if (nothingToShow && search === undefined) return null;

	return (
		<div className="source-tabs">
			<nav aria-label="Sources">
				<ul>
					{ordered.map((source) => (
						<li key={source.connectionId}>
							{renaming?.id === source.connectionId ? (
								<RenameField
									name={tabName(source, ordered)}
									width={renaming.width}
									onDone={(chosen) => {
										setRenaming(null);
										if (chosen !== undefined)
											void renameSource(db, source.connectionId, chosen);
									}}
								/>
							) : (
								<SourceTab
									source={source}
									name={tabName(source, ordered)}
									onShow={(width) => {
										// A press on the tab already showing is the
										// way into renaming it, which is what makes
										// the name feel like part of the tab rather
										// than a setting filed somewhere else. The
										// pile has no row to write a name onto.
										if (!source.active) {
											void showConnection(db, source.connectionId);
											return;
										}
										if (source.connectionId !== LOCAL_CONNECTION_ID)
											setRenaming({ id: source.connectionId, width });
									}}
								/>
							)}
						</li>
					))}
				</ul>
			</nav>
			{offerable.length > 0 && (
				<div className="source-add" ref={addFrame}>
					<button
						type="button"
						className={
							adding ? 'source-add-button source-add-button-on' : 'source-add-button'
						}
						// Named by its words where it has them, which is when nothing is
						// connected; a bare `+` beside the tabs is named for what it does.
						{...(first ? {} : { 'aria-label': connectLabel })}
						aria-haspopup="true"
						aria-expanded={adding}
						onClick={() => {
							setAdding((open) => !open);
						}}
					>
						{first ? (
							<>
								<span aria-hidden="true">+</span>{' '}
								<span className="source-add-label">{CONNECT_FIRST_LABEL}</span>
							</>
						) : (
							'+'
						)}
					</button>
					{adding && (
						<Menu
							className="source-add-menu"
							label="Storage providers"
							frame={addFrame}
							onClose={stopAdding}
						>
							<p className="source-add-heading">
								{first ? 'Choose a storage provider' : connectLabel}
							</p>
							<ConnectChoice
								gate={gate}
								live={live}
								db={db}
								client={client}
								offerable={offerable}
								returnTo={returnTo}
								navigate={navigate}
							/>
						</Menu>
					)}
				</div>
			)}
			{search !== undefined && <div className="source-search">{search}</div>}
		</div>
	);
};

const SourceTab = ({
	source,
	name,
	onShow,
}: {
	source: ConnectedSource;
	name: string;
	/** With the width the tab is taking, so replacing it moves nothing. */
	onShow: (width: number) => void;
}) => (
	<button
		type="button"
		className={source.active ? 'source-tab source-tab-active' : 'source-tab'}
		// Said outright rather than left to be assembled from the two spans
		// below. The name from contents is not simply their text: it joins the
		// pieces by its own rules, so "A source" and " — disconnected" came out
		// as a name no caller could predict — and a test looking for the tab by
		// what it plainly says could not find it. Exactly the visible words, so
		// it still satisfies WCAG 2.5.3.
		aria-label={source.detached === undefined ? name : `${name} — disconnected`}
		// The tab the user is on, said once. `aria-current` is what a screen
		// reader announces; "showing" in the text as well would be read twice.
		{...(source.active ? { 'aria-current': 'true' as const } : {})}
		onClick={(event) => {
			onShow(event.currentTarget.offsetWidth);
		}}
	>
		{/* The name once more on `data-name`, for the hidden bold copy that
		    holds the tab's width — see `.source-tab-name` in the stylesheet. */}
		<span className="source-tab-name" data-name={name}>
			<span>{name}</span>
		</span>
		{source.detached !== undefined && (
			// Not an icon alone: a source that syncs nowhere is the one thing
			// about this bar a user must not have to infer from a colour.
			<span className="source-tab-detached"> — disconnected</span>
		)}
	</button>
);

/**
 * The tab, become its own name.
 *
 * The field carries no box of its own — no padding, no background, no border,
 * no focus ring. The tab's own box is still there, around it, so entering a
 * rename changes nothing about the bar except that there is now a caret in the
 * name. A field with its own padding and border drew a second, smaller box
 * inside the tab and shifted the text of it.
 *
 * Nor does the tab change width. An `input` is as wide as its `size` attribute
 * and not as wide as its text, so swapping one in resized the tab and shoved
 * every tab after it sideways. The tab measures itself on the way in and the
 * wrapper is pinned to that. The name can then be longer than the room it has,
 * and scrolls inside it, which is what a tab of fixed width owes a long name
 * anyway.
 *
 * Nothing is measurable in jsdom, where `offsetWidth` is always 0, so a width
 * of nothing is left unset rather than pinning the field shut in the tests.
 *
 * Escape abandons it and Enter takes it, which is the pair every rename in
 * this app has. Blur takes it too: a click somewhere else is not "cancel", and
 * a field that threw the name away because the user looked at the note they
 * were naming it after would be its own bug report.
 *
 * The text starts selected. A rename is nearly always a replacement — "Dropbox
 * 2" into "Work" — and the alternative is every user clearing the field by
 * hand before they can start.
 */
const RenameField = ({
	name,
	width,
	onDone,
}: {
	name: string;
	width: number;
	onDone: (chosen?: string) => void;
}) => {
	const [draft, setDraft] = useState(name);
	const field = useRef<HTMLInputElement>(null);
	const done = useRef(false);

	useEffect(() => {
		// Focus first, and not `select()` alone: `select()` focuses as a side
		// effect in a browser and does not everywhere, which leaves a field that
		// looks ready and swallows the first thing typed into it.
		field.current?.focus();
		field.current?.select();
	}, []);

	// Once. Escape blurs the field, and a blur handler that had not been told
	// the rename was already abandoned would put the name straight back.
	const finish = (chosen?: string) => {
		if (done.current) return;
		done.current = true;
		onDone(chosen);
	};

	return (
		<span
			className="source-tab source-tab-active source-tab-editing"
			{...(width > 0 ? { style: { width: `${String(width)}px` } } : {})}
		>
			<input
				ref={field}
				className="source-tab-rename"
				aria-label={`Rename ${name}`}
				value={draft}
				maxLength={LABEL_LIMIT}
				onChange={(event) => {
					setDraft(event.target.value);
				}}
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						finish(draft);
					}
					if (event.key === 'Escape') {
						event.preventDefault();
						finish();
					}
				}}
				onBlur={() => {
					finish(draft);
				}}
			/>
		</span>
	);
};

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
			{PROVIDER_LABELS[provider]}
		</ConnectButton>
	));

/** The operator's link out. A new tab, so the app is still here to come back to. */
const GateLink = ({ action }: { action: ConnectGate['action'] }) => (
	<a href={action.url} target="_blank" rel="noopener noreferrer">
		{action.label}
	</a>
);

/** What is said under the field when the code could not be asked about. */
const NOT_CHECKED = 'The code could not be checked. Try again.';

/**
 * Asks the operator's policy about a code, and holds it for as long as the
 * policy says where it is accepted. Otherwise, what to say under the field:
 * the policy's reason, or this app's words for a refusal without one, a limit
 * reached, or no answer at all.
 */
const askAbout = async (
	client: Pick<ApiClient, 'checkConnectCode'>,
	code: string
): Promise<string | undefined> => {
	try {
		const result = await client.checkConnectCode(code);
		if (!result.ok) return NOT_CHECKED;
		if (!result.value.accepted) return result.value.reason ?? 'That code was not accepted.';
		holdConnectCode(code, result.value.expiresIn);
		return undefined;
	} catch (error) {
		return error instanceof ApiError && error.status === 429
			? 'Too many tries from here. Wait a minute, then try again.'
			: NOT_CHECKED;
	}
};

/**
 * The code held for the gate. Read at every render rather than kept, since the
 * hold ends by the clock and another tab can take or drop one, with a render
 * when it ends, so a gate showing it goes back to asking. `onLapse` is told
 * which code it was.
 */
const useHeldCode = (
	onLapse: (code: string) => void
): { code: string; until: number } | undefined => {
	const until = connectCodeHeldUntil();
	const code = until === undefined ? undefined : heldConnectCode();
	const [, setLapsed] = useState(0);
	useEffect(() => {
		if (code === undefined || until === undefined) return;
		const timer = setTimeout(
			() => {
				setLapsed((n) => n + 1);
				onLapse(code);
			},
			Math.max(0, until - Date.now()) + 50
		);
		return () => {
			clearTimeout(timer);
		};
	}, [code, until, onLapse]);
	return code === undefined || until === undefined ? undefined : { code, until };
};

/**
 * Which step `ConnectChoice` has open: the one picked, where the gate allows
 * a pick, and until then the buttons for a device that is in already and the
 * gate for any other. A gate whose code is required is open whenever no code
 * is held, whatever was picked.
 */
const openStep = (
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
const ConnectCodeForm = ({
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
					<span aria-hidden={checking}>Use code</span>
					<span aria-hidden={!checking}>Checking…</span>
				</button>
			</span>
			<span className="connect-code-said" id={`${id}-said`} role="status">
				{problem}
			</span>
		</form>
	);
};

/** The time a held code stops being good, with the day where it is not today. */
const untilFormat = (until: number, now = Date.now()): string =>
	new Intl.DateTimeFormat(undefined, {
		...(new Date(until).toDateString() === new Date(now).toDateString()
			? {}
			: { weekday: 'short', month: 'short', day: 'numeric' }),
		hour: 'numeric',
		minute: '2-digit',
	}).format(until);

/**
 * The code step folded while the buttons are open: the code they will send and
 * until when the policy said it is good, or, where a code is not required,
 * that they will send none. Its control opens the step again, which hides the
 * buttons, so the code and the buttons are never both open and what is on
 * screen is only ever the next thing to do.
 */
const ConnectCodeLine = ({
	label,
	held,
	onOpen,
}: {
	label: string;
	held: { code: string; until: number } | undefined;
	onOpen: () => void;
}) =>
	held === undefined ? (
		<p className="connect-code-line">
			<button type="button" className="link-button" onClick={onOpen}>
				Have a code? Enter it
			</button>
		</p>
	) : (
		<p className="connect-code-line">
			<span>
				{label}: <code title={held.code}>{held.code}</code>{' '}
				<button
					type="button"
					className="link-button"
					aria-label={`Change ${label}`}
					onClick={onOpen}
				>
					Change
				</button>
			</span>
			<span className="connect-code-until">Good until {untilFormat(held.until)}</span>
		</p>
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
 * to a line naming it (`ConnectCodeLine`), from which it opens again and the
 * buttons close. When the hold ends, here or while the app was closed, the gate
 * asks again. Where the operator made the code `required`, that is the only
 * way to the buttons, for every device. Where not, "Already have access?"
 * shows them without one, and a device with an account syncing here starts on
 * them, since it is there already.
 */
const ConnectChoice = ({
	gate,
	live,
	...buttons
}: ConnectButtonsProps & { gate: ConnectGate | undefined; live: boolean }) => {
	const [picked, setPicked] = useState<'gate' | 'buttons'>();
	const [code, setCode] = useState(() => heldConnectCode() ?? '');
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
						Already have access? Connect storage
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

/**
 * What the `+` opens. Closes on Escape and on a press anywhere outside it, which is the whole of
 * what a menu this small owes anyone: the buttons inside are ordinary buttons.
 *
 * Dressed as the editor toolbar's menus are (`.toolbar-panel`, `.toolbar-item`
 * in the stylesheet), so the app has one kind of menu rather than one per
 * place: a card hung under the control that opened it, with a row per choice.
 *
 * `frame` is the element around both the menu and the control that opened it,
 * and it is what "inside" means. A press on the control is not a press outside:
 * the control closes the menu itself, and letting this close it first had the
 * control's own click open it straight back up. And Escape is heard from the
 * control as well as from the menu, since the control is where the focus is
 * when a menu has just been opened with the keyboard.
 */
const Menu = ({
	children,
	className,
	label,
	frame,
	onClose,
}: {
	children: ReactNode;
	className: string;
	label: string;
	frame: RefObject<HTMLElement | null>;
	onClose: () => void;
}) => {
	useEscape(frame, true, onClose);

	useEffect(() => {
		const away = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && frame.current?.contains(target) === true) return;
			// A dialog is over everything, this menu included, and one opened from
			// in here is drawn at the end of the page (`ConnectButton`): a press in
			// it is an answer to it, not a press outside.
			if (target instanceof Element && target.closest('[aria-modal="true"]') !== null) return;
			onClose();
		};
		document.addEventListener('pointerdown', away);
		return () => {
			document.removeEventListener('pointerdown', away);
		};
	}, [onClose, frame]);

	return (
		<div className={`toolbar-panel ${className}`} role="group" aria-label={label}>
			{children}
		</div>
	);
};

export interface SourcePanelProps {
	db?: NotesDatabase;
	client?: Pick<ApiClient, 'config' | 'startConnect' | 'checkConnectCode'>;
	/** Where the provider's callback should send the browser back to. */
	returnTo: string;
	/** Seam for tests: jsdom has no navigation. */
	navigate?: (url: string) => void;
	/**
	 * The storage panel — what the showing source is syncing with — under the
	 * sources. A wide window keeps it at the foot of the sidebar; a compact one
	 * has no sidebar in view, and this is the panel that is about sources.
	 *
	 * Given where its actions go: the panel's header, as one `⋯` menu beside
	 * the `+`, as the notebooks' header has its own (`AccountPanel`'s
	 * `menuIn`). Null until the header is drawn.
	 */
	account?: (menuIn: HTMLElement | null) => ReactNode;
	/** A source was chosen, so the panel has done its job. */
	onChosen?: () => void;
}

/**
 * The tabs and the `+`, as one panel, for a compact window: opened from the
 * source dropdown in `CompactBar` and laid out as the notebook and note panels
 * are, across the window under the bar.
 *
 * Its header is the notebooks' header (`Sidebar`): a `⋯` for what can be done
 * to the source showing, and a `+` for another, which opens the same list of
 * providers the `+` beside the tabs does. There even with nothing to offer,
 * disabled, so the header keeps its shape.
 *
 * The same choices in the same order, with the one showing marked by
 * `aria-current` as its tab is. Renaming a source is not offered here: on a
 * tab it is a second press on the name, and a row in a panel is a place to go
 * rather than a name to edit. It is still there in a wider window.
 */
export const SourcePanel = ({
	db = defaultDb,
	client = api,
	returnTo,
	navigate,
	account,
	onChosen,
}: SourcePanelProps) => {
	const { ordered, offerable, gate, live, connectLabel } = useSourceChoices(db, client);
	const first = connectLabel === CONNECT_FIRST_LABEL;
	const [adding, setAdding] = useState(false);
	const addFrame = useRef<HTMLDivElement>(null);
	const stopAdding = useCallback(() => {
		setAdding(false);
	}, []);
	// State rather than a ref: the storage panel draws its menu into this, and
	// has to be drawn again once it is there.
	const [actions, setActions] = useState<HTMLDivElement | null>(null);

	return (
		<section className="source-panel" aria-label="Sources">
			<div className="pane-header">
				<h2>Sources</h2>
				<div className="pane-actions">
					<div className="source-panel-options" ref={setActions} />
					<div className="source-add" ref={addFrame}>
						<button
							type="button"
							className="icon"
							title={connectLabel}
							aria-label={connectLabel}
							aria-haspopup="true"
							aria-expanded={adding}
							disabled={offerable.length === 0}
							onClick={() => {
								setAdding((open) => !open);
							}}
						>
							+
						</button>
						{adding && offerable.length > 0 && (
							<Menu
								className="source-add-menu"
								label="Storage providers"
								frame={addFrame}
								onClose={stopAdding}
							>
								<p className="source-add-heading">
									{first ? 'Choose a storage provider' : connectLabel}
								</p>
								<ConnectChoice
									gate={gate}
									live={live}
									db={db}
									client={client}
									offerable={offerable}
									returnTo={returnTo}
									navigate={navigate}
								/>
							</Menu>
						)}
					</div>
				</div>
			</div>
			{ordered.length > 0 && (
				<ul>
					{ordered.map((source) => {
						const name = tabName(source, ordered);
						return (
							<li key={source.connectionId}>
								<button
									type="button"
									className={source.active ? 'row selected' : 'row'}
									aria-label={
										source.detached === undefined
											? name
											: `${name} — disconnected`
									}
									{...(source.active ? { 'aria-current': 'true' as const } : {})}
									onClick={() => {
										onChosen?.();
										if (!source.active)
											void showConnection(db, source.connectionId);
									}}
								>
									<span className="row-label">
										{name}
										{source.detached !== undefined && (
											<span className="source-tab-detached">
												{' '}
												— disconnected
											</span>
										)}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
			<div className="source-panel-foot">{account?.(actions)}</div>
		</section>
	);
};

/**
 * What the compact bar's source dropdown says: the source showing, or plain
 * "Storage" before there is one — the dropdown is there regardless, because
 * the storage panel is in it.
 */
export const useShowingSourceName = (
	db: NotesDatabase = defaultDb,
	client: Pick<ApiClient, 'config' | 'startConnect' | 'checkConnectCode'> = api
): string => {
	const { ordered } = useSourceChoices(db, client);
	const showing = ordered.find((source) => source.active);
	return showing === undefined ? 'Storage' : tabName(showing, ordered);
};
