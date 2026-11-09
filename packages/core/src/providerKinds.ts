/**
 * Storage providers this codebase knows. `dropbox`, `onedrive` and `gdrive`
 * have adapters; `webdav` is deferred indefinitely (docs/ARCHITECTURE.md §5.4).
 *
 * What the server, the client and a deployment all speak, so not this app's
 * own: a kind is written into the marker, into each device's rows and into
 * `storage_connections.provider`, and is only ever added, never renamed
 * (docs/decisions/0018-the-shared-kit.md).
 */
export const PROVIDER_KINDS = ['gdrive', 'onedrive', 'dropbox', 'webdav'] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];
