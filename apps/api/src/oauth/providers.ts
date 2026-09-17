import type { ProviderKind } from '@skysa/core';

import type { AppConfig } from '../env.js';
import { dropboxOAuth } from './dropbox.js';
import { gdriveOAuth } from './gdrive.js';
import { onedriveOAuth } from './onedrive.js';
import type { OAuthCredentials, StorageOAuth } from './types.js';

/**
 * The storage providers that connect through OAuth and have a flow here. WebDAV
 * never does — it has credentials, not a grant.
 */
const CLIENTS = {
	dropbox: dropboxOAuth,
	gdrive: gdriveOAuth,
	onedrive: onedriveOAuth,
} as const satisfies Partial<Record<ProviderKind, StorageOAuth>>;

export type OAuthProviderKind = keyof typeof CLIENTS;

export type ResolvedOAuth =
	| {
			ok: true;
			provider: OAuthProviderKind;
			client: StorageOAuth;
			credentials: OAuthCredentials;
	  }
	| { ok: false; error: 'unsupported_provider' | 'provider_not_configured' };

const isOAuthProvider = (provider: string): provider is OAuthProviderKind =>
	Object.hasOwn(CLIENTS, provider);

/**
 * The flow for a provider, if this deployment offers it.
 *
 * A provider with no flow here and a provider the operator has not enabled
 * give the same answer: which providers a deployment offers is already public
 * at `/api/config`, so a different answer per reason would say nothing new.
 * Enabled but without credentials is an operator's mistake, and says so —
 * `parseEnv` refuses to boot like that, so it is reachable only through a
 * config built by hand.
 */
export const oauthFor = (config: AppConfig, provider: string): ResolvedOAuth => {
	if (!isOAuthProvider(provider) || !config.enabledProviders.includes(provider)) {
		return { ok: false, error: 'unsupported_provider' };
	}
	const credentials = config.oauth[provider];
	if (credentials === undefined) return { ok: false, error: 'provider_not_configured' };
	return { ok: true, provider, client: CLIENTS[provider], credentials };
};
