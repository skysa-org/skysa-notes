import type { ConnectGate, EntitlementCode } from '@skysa/core';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../api/client.js';
import { answer, useInstanceConfig } from '../../api/instanceConfig.js';
import type { Notice } from '../../components/notify.js';
import { t } from '../../i18n/t.js';
import {
	connectCodeAskedAt,
	dropConnectCode,
	heldConnectCode,
	heldConnectCodeShown,
	holdAcceptedCode,
} from '../../store/connectCode.js';
import type { SyncStateRecord } from '../../store/db.js';
import { useClaimingConnection } from '../../store/hooks.js';
import type { ConnectOutcome } from '../search.js';

/**
 * What the app says on the way back from connecting storage (`?connect=…`),
 * and asking again for a connect code the operator's gate turned down.
 */

/**
 * What to tell the user on the way back from connecting a storage account, or
 * `undefined` for a value this build has no message for.
 *
 * The `default` is what stopped an **empty** alert banner — a red bar saying
 * nothing — when a hand-typed or bookmarked `?connect=signin` arrived here
 * intact, returning `undefined` through a `string` signature. It arrived
 * because `parseSearch` left a refused key out instead of overriding it, and
 * the router's spread put the raw one back (see `parseSearch`). That is fixed
 * there; this stays, because a build older than the API it talks to can still
 * be sent an outcome it has no words for.
 *
 * Found on 2026-09-18 by removing `signin`, `conflict` and `occupied` — the
 * three outcomes Phase 7 retired server-side — which is when a value outside
 * the union first became reachable.
 *
 * `codeRefused` is a plain no to a connect that carried the gate's code
 * (`codeWasRefused`), which is said to be about the code.
 */
const connectMessage = (
	outcome: ConnectOutcome,
	code?: EntitlementCode,
	gate?: ConnectGate,
	codeRefused = false
): Notice | undefined => {
	switch (outcome) {
		case 'ok':
			return { message: t('shell.connect.ok'), tone: 'success' };
		// The user's own choice, and nothing is broken — but nothing is
		// connected either, which is not what they will assume from a screen
		// that looks the same as before they started.
		case 'denied':
			return { message: t('shell.connect.denied'), tone: 'warning' };
		case 'failed':
			return {
				message: t('shell.connect.failed'),
				tone: 'error',
			};
		// A warning rather than an error: this one worked exactly as it was
		// asked to, and what to do about it is a tickbox away.
		case 'partial':
			return {
				message: t('shell.connect.partial'),
				tone: 'warning',
			};
		// Trying again will not help: this server will not have the account.
		// What might is whatever its operator offers instead, when they do.
		case 'refused':
			return {
				message: codeRefused ? t('shell.connect.refused.code') : refusedText(code),
				tone: 'error',
				action: gate?.action,
			};
		// The browser came back from the provider with no flow of its own for the
		// server to finish: one that took too long, or a callback opened again
		// long after it was answered. Whether anything was connected by then is
		// not known there, and the storage tabs already say, so it is not guessed.
		case 'expired':
			return {
				message: t('shell.connect.expired'),
				tone: 'warning',
			};
		default:
			return undefined;
	}
};

/**
 * A refused connect, by the kind of no the operator's policy gave. The storage
 * panel says the same reasons in its own sentences (`refusedSentence` in
 * `components/account/statusWords.ts`); here each is a whole one about the connect.
 */
const refusedText = (code: EntitlementCode | undefined): string => {
	switch (code) {
		case 'not_allowed':
			return t('shell.connect.refused.notAllowed');
		case 'lapsed':
			return t('shell.connect.refused.lapsed');
		case 'limit_reached':
			return t('shell.connect.refused.limitReached');
		case undefined:
			return t('shell.connect.refused.cannotSync');
	}
};

/**
 * Whether a refusal is the operator's policy turning down the code typed into
 * its gate (`ConnectGate.connectCode`): a plain no — `not_allowed`, or no code
 * at all — to a connect made while this tab held one. The code is what the
 * person offered, and what they can put right. A `lapsed` or a `limit_reached`
 * is about the account or the instance, whatever was typed, and is said as it
 * is.
 *
 * Not a value the policy gave to hold in a code's place: nothing was typed
 * this time, and a pass that cost an email to get is not thrown away on a no
 * that may be about the account. The policy is asked about it instead
 * (`useCodeAskedAgain`), and lets it go if it no longer takes it.
 */
const codeWasRefused = (
	connect: ConnectOutcome | undefined,
	code: EntitlementCode | undefined
): boolean =>
	connect === 'refused' &&
	(code === undefined || code === 'not_allowed') &&
	heldConnectCode() !== undefined &&
	heldConnectCodeShown();

/** How long the policy's word on a held value stands before the app asks again as it loads. */
const ASK_AGAIN_MS = 60 * 60_000;

/**
 * What the operator's policy gave to hold in place of the gate's code
 * (`ConnectCodeCheck.hold`), asked about again once as the app loads, where
 * the instance's gate asks for a code: at most once an hour, since the policy
 * last answered, and at once after a refused connect.
 *
 * A typed code is not asked about again: it is good for as long as the policy
 * said when it took it, minutes as a rule, and an answer would add nothing.
 * Nor is a held value the policy answered about within the hour. Each asking
 * costs one of the guesses the instance allows an address
 * (`connect-code:<ip>`), which the people behind one carrier's or one office's
 * address share, and someone typing a fresh code must not find them spent by
 * the others opening the app.
 *
 * A policy that hands a device a pass to keep says each time whether it still
 * takes it, and may answer with a fresh one, so a pass lives as long as the
 * device is used rather than from the day it was given. One it no longer takes
 * — the subscription behind it ended, say — is let go of here, and the gate
 * asks for a code again before any consent screen rather than after one. Not
 * asked, or not answered, it is kept: the callback still decides, as it always
 * did. An answer about a value no longer held, because a new code was typed
 * meanwhile, is not the answer about this one, and changes nothing.
 *
 * After the refusal of a connect that carried a typed code, which lets go of
 * the code first (`useConnectNotice`), there is nothing left to ask about; a
 * held value is kept through a refusal (`codeWasRefused`) and asked about here.
 */
export const useCodeAskedAgain = (connect: ConnectOutcome | undefined) => {
	const config = useInstanceConfig(api);
	const asksForCode = answer(config)?.connectGate?.connectCode !== undefined;
	const asked = useRef(false);
	const [refused] = useState(connect === 'refused');
	useEffect(() => {
		if (!asksForCode || asked.current) return;
		asked.current = true;
		const held = heldConnectCode();
		if (held === undefined || heldConnectCodeShown()) return;
		if (!refused && Date.now() - (connectCodeAskedAt() ?? 0) < ASK_AGAIN_MS) return;
		void api.checkConnectCode(held).then(
			(result) => {
				if (!result.ok || heldConnectCode() !== held) return;
				if (result.value.accepted) holdAcceptedCode(held, result.value);
				else dropConnectCode();
			},
			() => {
				// A limit reached or no answer at all: kept, as it was.
			}
		);
	}, [asksForCode, refused]);
};

/**
 * The toast for how a connect went, read once as the app opens on the way back
 * from the provider and taken out of the URL straight away: left there, a
 * reload or a bookmark would say "connected" again about a connection that may
 * since have gone.
 *
 * Except that a new source's "connected" is the import dialog's to say, and
 * a toast behind it — under a held app, where it cannot be dismissed — says it
 * twice. Whether the app will be held is not known on arrival: the bind that
 * decides it comes after a round trip to the server (`claimConnection`), so
 * "connected" waits while the credential brought back is still being taken up,
 * and is dropped once an import holds the app. Every other outcome says
 * something went wrong, and is shown at once.
 */
export const useConnectNotice = (
	connect: ConnectOutcome | undefined,
	code: EntitlementCode | undefined,
	held: SyncStateRecord | undefined
) => {
	const navigate = useNavigate({ from: '/' });
	const [outcome, setOutcome] = useState(connect);
	const [refusedAs] = useState(code);
	const [codeRefused] = useState(() => codeWasRefused(connect, code));
	// So the field is empty for the next code, rather than offering again the one
	// just turned down.
	useEffect(() => {
		if (codeRefused) dropConnectCode();
	}, [codeRefused]);
	// The operator's gate, whose action is the one thing a refused toast can
	// offer to do. The same request the connect buttons make (`instanceConfig`).
	const config = useInstanceConfig(api);
	const gate = answer(config)?.connectGate;
	useEffect(() => {
		if (connect === undefined && code === undefined) return;
		void navigate({
			search: ({ connect: _outcome, code: _code, ...rest }) => rest,
			hash: true,
			state: true,
			replace: true,
		});
	}, [connect, code, navigate]);

	const claiming = useClaimingConnection();
	// Dropped for good, in render rather than an effect (React's "adjusting
	// state when a prop changes"): the import finishing must not bring it back.
	if (outcome === 'ok' && held !== undefined) setOutcome(undefined);

	const dismissConnect = useCallback(() => {
		setOutcome(undefined);
	}, []);
	// Whether there is a message at all decides whether a toast is rendered, and
	// `connectMessage` answers `undefined` for an outcome this build has no
	// words for (see above).
	//
	// A refusal waits for the instance's config, answered or not: its link is
	// part of the message, and an alert that grows a link a moment after it
	// appears is an alert a screen reader reads twice. Never for long — the
	// server has only just sent the browser here.
	const waiting =
		(outcome === 'ok' && (claiming || held !== undefined)) ||
		(outcome === 'refused' && config.kind === 'asking');
	const connectNotice =
		outcome === undefined || waiting
			? undefined
			: connectMessage(outcome, refusedAs, gate, codeRefused);
	return { connectNotice, dismissConnect };
};
