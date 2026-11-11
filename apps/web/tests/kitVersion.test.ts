import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The kit is one version (docs/decisions/0018-the-shared-kit.md): its packages
 * are released together, and a version can carry a migration the Worker runs,
 * so every manifest here names the same one, exactly. A range would let an
 * install move one package and not the others, with no changeset to say so.
 * This app's own packages, `workspace:*`, are not the kit's.
 *
 * In `apps/web` for `node:fs`, as `noControlBytes.test.ts` is.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The root and every workspace package, as `pnpm-workspace.yaml` finds them. */
const manifests = [
	'.',
	...['apps', 'packages'].flatMap((folder) =>
		readdirSync(join(root, folder)).map((name) => `${folder}/${name}`)
	),
].filter((folder) => existsSync(join(root, folder, 'package.json')));

type Manifest = Readonly<{ name?: string } & Record<string, unknown>>;

const read = (folder: string): Manifest =>
	JSON.parse(readFileSync(join(root, folder, 'package.json'), 'utf8')) as Manifest;

const ours = new Set(manifests.map((folder) => read(folder).name));

/** Each of the kit's packages a manifest names, where, and at what. */
const named = manifests.flatMap((folder) =>
	['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(
		(field) =>
			Object.entries((read(folder)[field] ?? {}) as Record<string, string>)
				.filter(([name]) => name.startsWith('@skysa/') && !ours.has(name))
				.map(([name, version]) => ({ where: `${folder}/package.json`, name, version }))
	)
);

describe('the kit’s version', () => {
	it('is read from every manifest, the root’s too', () => {
		expect(manifests).toEqual(['.', 'apps/api', 'apps/web', 'packages/core']);
		expect(named.map(({ where }) => where)).toContain('./package.json');
	});

	it('is named exactly, never as a range, a tag or a catalog entry', () => {
		expect(
			named.filter(({ version }) => !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version))
		).toEqual([]);
	});

	it('is the same one in every manifest', () => {
		expect([...new Set(named.map(({ version }) => version))]).toHaveLength(1);
	});
});
