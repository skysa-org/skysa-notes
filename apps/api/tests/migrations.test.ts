import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The D1 migrations are the kit's (`@skysa/server`), and `wrangler.toml`
 * reaches them in `node_modules`. D1 remembers a migration by its file's name,
 * so every one a database may already have applied must be there under that
 * name, in that order, or `wrangler d1 migrations apply` would find no folder,
 * or take a renamed one for new and run it again over a live database.
 */

const API = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every migration a database migrated before 3.0.0 can have applied. */
const APPLIED = [
	'0000_init.sql',
	'0001_connection_per_provider.sql',
	'0002_connection_account_id.sql',
	'0003_one_user_per_account.sql',
	'0004_per_connection_credentials.sql',
	'0005_drop_user_connections.sql',
	'0006_grant_device.sql',
];

const folder = (): string => {
	const named = /^migrations_dir = "([^"]+)"$/mu.exec(
		readFileSync(join(API, 'wrangler.toml'), 'utf8')
	)?.[1];
	expect(named).toBeDefined();
	return resolve(API, named ?? '');
};

describe('the D1 migrations wrangler.toml applies', () => {
	it('are the kit’s, where it says', () => {
		expect(folder()).toMatch(/node_modules\/@skysa\/server\/migrations$/u);
		expect(existsSync(folder())).toBe(true);
	});

	it('begin with every one a database may have applied, under its own name', () => {
		const files = readdirSync(folder())
			.filter((file) => file.endsWith('.sql'))
			.sort();
		expect(files.slice(0, APPLIED.length)).toEqual(APPLIED);
	});
});
