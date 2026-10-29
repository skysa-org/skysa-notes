import { builtinModules } from 'node:module';

import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import functional from 'eslint-plugin-functional';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import preferArrowFunctions from 'eslint-plugin-prefer-arrow-functions';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Syntax refused everywhere. A named list because flat config *replaces* a
 * rule's options rather than merging them: a block that sets
 * `no-restricted-syntax` without spreading these turns both of them off for
 * every file it covers, and no existing file violates them, so nothing would
 * ever say so.
 */
const RESTRICTED_SYNTAX = [
	{
		selector: 'IfStatement > IfStatement.alternate',
		message: "'else if' is not allowed, use early returns instead.",
	},
	{
		// A static import is what the src rule on `@skysa/core/testing` sees;
		// this keeps a lazy one from slipping a test double into a chunk.
		selector: "ImportExpression[source.value='@skysa/core/testing']",
		message: 'import the test doubles statically, from a test (#449).',
	},
	{
		selector: 'AwaitExpression > ImportExpression',
		message:
			'Await with dynamic imports (await import()) is not allowed. Use static imports at the top of the file instead.',
	},
];

/**
 * The one way to hold a value that changes: `cell()` from `@skysa/core`
 * (#457). Not a `Map` keyed by one literal, and not a `{ current }` written
 * out — the two ways the rule against `let` used to be worked round, each to
 * be learned where it was met. A React ref is a cell's shape already and is
 * not written as one of these. In source only: tests keep their own idioms.
 */
const CELL_MESSAGE =
	'a value that changes is a cell (#457): cell() and Cell<T>, from @skysa/core, or from src/cell.js inside core.';

const CELL_SYNTAX = [
	{
		// Keyed by one literal, or by a union of nothing but literals: a value or
		// two by name, not a table. A key named through a type alias is not seen;
		// only a type-aware rule could, and review is that here.
		selector:
			"NewExpression[callee.name='Map'] > TSTypeParameterInstantiation > :first-child:matches(TSLiteralType, TSUnionType:not(:has(> :not(TSLiteralType))))",
		message: CELL_MESSAGE,
	},
	{
		// A set that can only ever hold one thing is a flag.
		selector:
			"NewExpression[callee.name='Set'] > TSTypeParameterInstantiation > TSLiteralType:first-child",
		message: CELL_MESSAGE,
	},
	{
		selector:
			"ObjectExpression[properties.length=1] > Property:matches([key.name='current'], [key.value='current'])",
		message: CELL_MESSAGE,
	},
	{
		selector:
			"TSTypeLiteral[members.length=1] > TSPropertySignature:matches([key.name='current'], [key.value='current'])",
		message: CELL_MESSAGE,
	},
];

/**
 * Every Node built-in, by bare name and by `node:` — read from Node itself, so a
 * hand-kept list cannot leave one out. Neither core nor the Worker has them:
 * core runs in the browser and Workers too, and the Worker runs without
 * `nodejs_compat`. Names that start with `_` are Node's internals, not modules
 * anyone imports.
 */
const NODE_BUILTINS = ['node:*', ...builtinModules.filter((name) => !name.startsWith('_'))];

/**
 * Restricted import patterns for a folder that sits below others: it may not
 * reach up into the folders named, so the layers stay one way round. `**`
 * either side because a file one folder deeper writes `../../components/…`.
 */
const NOT_ABOVE = (folders, message) => ({
	group: folders.map((folder) => `**/${folder}/**`),
	message,
});

/** What nothing in packages/core/src may import. */
const CORE_IMPORTS = [
	{
		group: NODE_BUILTINS,
		message: 'packages/core must not depend on Node built-ins.',
	},
	{
		group: ['@skysa/web', '@skysa/api', '**/apps/**'],
		message: 'packages/core must not import from apps/*.',
	},
];

/**
 * Words the user reads, written straight into JSX: a sentence there is one no
 * translation can reach. They come from the catalog, `t()` in
 * `apps/web/src/i18n/t.ts` (docs/ARCHITECTURE.md §7, "The app's words").
 *
 * JSX text, and the text of the props that are read out or shown — a label, a
 * title, a placeholder, `aria-label`, and a component's own `…Label`, `…Text`
 * and `…Message` — whether written as a string, a template or either arm of a
 * condition. Only JSX can be told apart this way: in a `.ts` file a string may
 * be a message or a key, and that is left to review.
 */
const LETTERS = '/[A-Za-z]/';
const SHOWN_PROP =
	'JSXAttribute[name.name=/^(aria-(label|description|roledescription|valuetext|placeholder)|title|placeholder|alt|label|text|message|description|[a-z]+(Label|Text|Title|Message))$/]';
const INLINE_WORDS = [
	`JSXText[value=${LETTERS}]`,
	`${SHOWN_PROP} > Literal[value=${LETTERS}]`,
	...[':matches(JSXElement, JSXFragment)', SHOWN_PROP].flatMap((parent) => {
		const said = `${parent} > JSXExpressionContainer`;
		return [
			`${said} > Literal[value=${LETTERS}]`,
			`${said} > :matches(ConditionalExpression, LogicalExpression) > Literal[value=${LETTERS}]`,
			`${said} > ConditionalExpression > ConditionalExpression > Literal[value=${LETTERS}]`,
			`${said} > TemplateLiteral > TemplateElement[value.raw=${LETTERS}]`,
		];
	}),
].map((selector) => ({
	selector,
	message: "Words the user reads come from the catalog: t('…') from src/i18n/t.js.",
}));

/**
 * What every TypeScript file is held to, `.ts` and `.tsx` alike, so component
 * code meets the same standard as the rest of the repo rather than a looser
 * one. On top of `eslint:recommended` and typescript-eslint's
 * `recommendedTypeChecked`. Formatting is Prettier's: `prettierConfig`, last
 * in the list below, switches off every rule that would fight it.
 */
const typescriptRules = {
	// Mistakes JavaScript lets through.
	eqeqeq: 'error',
	'guard-for-in': 'error',
	'no-caller': 'error',
	'no-extend-native': 'error',
	'no-extra-bind': 'error',
	'no-invalid-this': 'error',
	'no-irregular-whitespace': 'error',
	'no-multi-str': 'error',
	'no-new-wrappers': 'error',
	'no-param-reassign': 'error',
	// Allowed, though `eslint:recommended` refuses it.
	'no-cond-assign': 'off',

	// Nothing left behind from debugging, and no browser dialogs.
	'no-console': 'error',
	'no-debugger': 'error',
	'no-alert': 'error',

	// Shallow, flat code: early returns rather than nesting.
	complexity: ['error', 20],
	'max-depth': ['error', 2],
	'no-else-return': 'error',
	'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX],

	// Declarations, names and comments.
	'no-var': 'error',
	'prefer-const': ['error', { destructuring: 'all' }],
	'one-var': ['error', { var: 'never', let: 'never', const: 'never' }],
	'object-shorthand': 'error',
	'prefer-rest-params': 'error',
	'prefer-spread': 'error',
	camelcase: [
		'error',
		{ ignoreDestructuring: true, ignoreImports: true, ignoreGlobals: true, allow: [''] },
	],
	'spaced-comment': ['error', 'always'],

	// Functions are arrow functions held in consts.
	'func-style': ['error', 'expression'],
	'prefer-arrow-callback': 'error',
	'arrow-body-style': ['error', 'as-needed'],
	'prefer-arrow-functions/prefer-arrow-functions': [
		'error',
		{ disallowPrototype: true, singleReturnOnly: false, classPropertiesAllowed: false },
	],

	// Functional style. `functional/immutable-data` is added below, for `.ts` only.
	'functional/no-this-expressions': 'error',
	'functional/no-loop-statements': 'error',
	'functional/no-let': 'error',
	'functional/functional-parameters': [
		'error',
		{ allowRestParameter: true, enforceParameterCount: false },
	],
	'functional/prefer-tacit': 'error',
	'functional/readonly-type': 'error',
	'functional/prefer-property-signatures': 'error',

	// Imports: sorted, types imported as types, and none left unused.
	'simple-import-sort/imports': 'error',
	'unused-imports/no-unused-imports': 'error',
	'@typescript-eslint/consistent-type-imports': 'error',

	// Where typescript-eslint has a type-aware version of a core rule, the core
	// one is off and that one is on.
	'no-unused-vars': 'off',
	'@typescript-eslint/no-unused-vars': [
		'error',
		{
			argsIgnorePattern: '^_',
			varsIgnorePattern: '^_',
			destructuredArrayIgnorePattern: '^_',
			ignoreRestSiblings: true,
		},
	],
	'no-throw-literal': 'off',
	'@typescript-eslint/only-throw-error': 'error',
	'prefer-promise-reject-errors': 'off',
	'@typescript-eslint/prefer-promise-reject-errors': 'error',
	'require-await': 'off',
	'@typescript-eslint/require-await': 'error',

	// The rest of TypeScript.
	'@typescript-eslint/no-explicit-any': 'off',
	'@typescript-eslint/no-array-delete': 'error',
	'@typescript-eslint/no-base-to-string': 'error',
	'@typescript-eslint/no-deprecated': 'error',
	'@typescript-eslint/no-duplicate-enum-values': 'error',
	'@typescript-eslint/no-duplicate-type-constituents': 'error',
	'@typescript-eslint/no-empty-function': 'error',
	'@typescript-eslint/no-extra-non-null-assertion': 'error',
	'@typescript-eslint/no-for-in-array': 'error',
	'@typescript-eslint/no-redundant-type-constituents': 'error',
	'@typescript-eslint/no-this-alias': 'error',
	'@typescript-eslint/no-unnecessary-condition': 'error',
	'@typescript-eslint/no-unnecessary-type-assertion': 'error',
	'@typescript-eslint/no-unnecessary-type-constraint': 'error',
	'@typescript-eslint/no-wrapper-object-types': 'error',
	'@typescript-eslint/prefer-as-const': 'error',
	'@typescript-eslint/restrict-plus-operands': 'error',
	'@typescript-eslint/restrict-template-expressions': 'error',
	'@typescript-eslint/triple-slash-reference': 'error',
};

export default tseslint.config(
	{
		ignores: [
			'**/dist/**',
			// vite-plugin-pwa's generated dev service worker.
			'**/dev-dist/**',
			'**/coverage/**',
			'**/node_modules/**',
			'**/.wrangler/**',
			'.claude/**',
			// Generated by TanStack Router from src/routes, committed only so a fresh
			// clone can typecheck without first running Vite.
			'**/routeTree.gen.ts',
			// Generated by `wrangler types` from wrangler.toml.
			'**/worker-configuration.d.ts',
			// Generated by drizzle-kit from src/db/schema.ts.
			'apps/api/migrations/**',
		],
	},

	js.configs.recommended,

	// ---- TypeScript ---------------------------------------------------------

	{
		files: ['packages/**/*.ts', 'apps/**/*.ts', 'apps/web/**/*.tsx'],
		extends: [...tseslint.configs.recommendedTypeChecked],
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
		plugins: {
			'prefer-arrow-functions': preferArrowFunctions,
			functional,
			'unused-imports': unusedImports,
			'simple-import-sort': simpleImportSort,
		},
		rules: typescriptRules,
	},
	{
		// Not in components: it flags ordinary useState setter patterns that the
		// accessor carve-out does not quite cover.
		files: ['packages/**/*.ts', 'apps/**/*.ts'],
		rules: {
			'functional/immutable-data': [
				'error',
				{ ignoreMapsAndSets: true, ignoreAccessorPattern: ['**.current', 'window.**'] },
			],
		},
	},

	// ---- React --------------------------------------------------------------

	{
		files: ['apps/web/**/*.{ts,tsx}'],
		extends: [
			react.configs.flat.recommended,
			react.configs.flat['jsx-runtime'], // new JSX transform — no `React` import needed
			jsxA11y.flatConfigs.recommended,
		],
		languageOptions: { globals: globals.browser },
		plugins: { 'react-hooks': reactHooks },
		settings: {
			// Explicit rather than 'detect': eslint-plugin-react 7.37.5's version
			// detection calls an API ESLint 10's flat-config rule context no longer
			// exposes, and crashes the run instead of warning. Keep in sync with
			// apps/web's react dependency.
			react: { version: '19.3.0' },
		},
		rules: {
			...reactHooks.configs['recommended-latest'].rules,
			'react/react-in-jsx-scope': 'off', // React 19 automatic JSX runtime
			'react/prop-types': 'off', // types come from TypeScript
		},
	},

	{
		// A value that changes is a cell (#457), in every package's src. The
		// API's env block below sets the rule again, so it spreads the list too.
		files: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
		rules: { 'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX, ...CELL_SYNTAX] },
	},

	// ---- The app's words ----------------------------------------------------

	{
		// The cell rule too, since this sets the rule again for every .tsx.
		files: ['apps/web/src/**/*.tsx'],
		rules: {
			'no-restricted-syntax': [
				'error',
				...RESTRICTED_SYNTAX,
				...INLINE_WORDS,
				...CELL_SYNTAX,
			],
		},
	},

	// ---- Boundaries ---------------------------------------------------------

	{
		// packages/core must stay framework-free and portable: browser, Node, Workers.
		files: ['packages/core/src/**/*.ts'],
		languageOptions: { globals: globals.browser },
		rules: {
			// core's tsconfig includes lib.dom for the web standards it does use
			// (Web Crypto, TextEncoder, fetch, URL). These are the ones that would
			// tie it to a browser, and no lib setting excludes them on its own.
			'no-restricted-globals': [
				'error',
				...[
					'document',
					'window',
					'localStorage',
					'sessionStorage',
					'navigator',
					'location',
					'alert',
					'indexedDB',
				].map((name) => ({
					name,
					message: 'packages/core must run in the browser, Node and Workers alike.',
				})),
			],
			'no-restricted-imports': ['error', { patterns: CORE_IMPORTS }],
		},
	},
	{
		// A provider moves bytes and names for the sync engine; it knows nothing
		// of the engine. What both need — a conflict copy's name, say — lives
		// below them both, in names/ (#449). Repeats core's patterns, since a
		// rule set here replaces the one above rather than adding to it.
		files: ['packages/core/src/providers/**/*.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						...CORE_IMPORTS,
						NOT_ABOVE(['sync'], 'a provider does not import the sync engine.'),
					],
				},
			],
		},
	},
	{
		// names/ sits below providers, sync and markdown, which all name files
		// by it; reaching up into any of them would bring the cycle back.
		files: ['packages/core/src/names/**/*.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						...CORE_IMPORTS,
						NOT_ABOVE(
							['sync', 'providers', 'markdown'],
							'names/ sits below sync, providers and markdown.'
						),
					],
				},
			],
		},
	},
	{
		// No Node built-ins anywhere in the Worker, `worker.ts` included: the
		// entry module is the likeliest place for one to appear. `wrangler deploy
		// --dry-run` bundles one without a word, and only the deployed Worker
		// would find out. `pnpm typecheck` refuses it too, through
		// `tsconfig.src.json` (src with no Node types; `tsconfig.json` holds the
		// tests, which pull @types/node in), but this says why, and says it first.
		files: ['apps/api/src/**/*.ts'],
		languageOptions: { globals: globals.node },
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							// wrangler.toml sets no `nodejs_compat`, so the Worker
							// runtime has none of these.
							group: NODE_BUILTINS,
							message:
								'the Worker runs without nodejs_compat — Web Crypto and fetch only.',
						},
						{
							// The rest of apps/api runs under Node in the tests and
							// knows the runtime only through createApp's seams.
							group: ['cloudflare:*'],
							message:
								'only src/worker.ts and src/relay/durableObject.ts may name the Workers runtime.',
						},
					],
				},
			],
		},
	},
	{
		// The two modules that are the Workers runtime's own: the entry, and the
		// Durable Object class it exports, which has to extend `DurableObject`
		// and reach its state through `this.ctx`. Node built-ins stay refused.
		files: ['apps/api/src/worker.ts', 'apps/api/src/relay/durableObject.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: NODE_BUILTINS,
							message:
								'the Worker runs without nodejs_compat — Web Crypto and fetch only.',
						},
					],
				},
			],
		},
	},
	{
		files: ['apps/api/src/relay/durableObject.ts'],
		rules: { 'functional/no-this-expressions': 'off' },
	},
	{
		// Only worker.ts may read *configuration*. Per-request bindings still
		// arrive on the Hono context — `c.env.DB` in app.ts is the one of those
		// that cannot be handed over at createApp time, because there is no
		// request yet when the app is built.
		//
		// There are three ways in. This block refuses two: the bare `process`
		// and `globalThis.process`. The third, importing `node:process`, is a
		// Node built-in, which the block above already refuses everywhere in
		// apps/api/src. Setting `no-restricted-imports` here would replace that
		// block's list for these files rather than add to it, so this one sets
		// none.
		files: ['apps/api/src/**/*.ts'],
		ignores: ['apps/api/src/worker.ts'],
		languageOptions: { globals: globals.node },
		rules: {
			'no-restricted-globals': [
				'error',
				{
					name: 'process',
					message:
						'apps/api reads env only in src/worker.ts; take config via createApp(options).',
				},
			],
			'no-restricted-syntax': [
				'error',
				...RESTRICTED_SYNTAX,
				...CELL_SYNTAX,
				{
					selector: "MemberExpression[object.name='globalThis'][property.name='process']",
					message:
						'apps/api reads env only in src/worker.ts; take config via createApp(options).',
				},
			],
		},
	},
	{
		// Workers has no logger binding and no stdout: `console` is the only sink
		// Cloudflare's observability and `wrangler tail` read. Scoped to the two
		// places that report an error, not opened up across the API.
		files: ['apps/api/src/worker.ts', 'apps/api/src/app.ts', 'apps/api/src/log.ts'],
		rules: { 'no-console': 'off' },
	},

	{
		// The web app's lower layers. The store is the data layer: Dexie tables
		// and the hooks that read them. The sync layer drives the engine against
		// that store. Neither may import the UI or anything built on top of
		// them, so each can be read, tested and changed without the screens.
		// The store reads the editor's mode and code-display preferences, which
		// are plain values kept in editor/; nothing else of the editor.
		files: ['apps/web/src/store/**/*.{ts,tsx}'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						NOT_ABOVE(
							[
								'components',
								'routes',
								'sync',
								'secrets',
								'fill',
								'share',
								'install',
								'pictures',
								'commands',
							],
							'the store is the data layer: it does not import the sync layer or the UI.'
						),
						{
							group: [
								'**/editor/*',
								'!**/editor/mode.js',
								'!**/editor/codeDisplay.js',
							],
							message:
								'the store reads only the editor preferences (editor/mode, editor/codeDisplay).',
						},
					],
				},
			],
		},
	},
	{
		files: ['apps/web/src/sync/**/*.{ts,tsx}'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						NOT_ABOVE(
							[
								'components',
								'routes',
								'editor',
								'secrets',
								'fill',
								'share',
								'install',
								'pictures',
								'commands',
							],
							'the sync layer drives the store; it does not import the UI.'
						),
					],
				},
			],
		},
	},
	{
		// The editors are views over a note's markdown (CLAUDE.md): they may use
		// the store and shared UI pieces, but not the screens that hold them or
		// the sync layer behind those.
		files: ['apps/web/src/editor/**/*.{ts,tsx}'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						NOT_ABOVE(
							['routes', 'sync'],
							'the editors are views: they do not import routes or the sync layer.'
						),
					],
				},
			],
		},
	},

	// ---- File size ----------------------------------------------------------

	{
		// A warning, not an error, while the files the 2026-10-21 audit found
		// too long are split (#446, #452–#454): it says which those are, and
		// keeps a split file from growing back. Code lines only — the comments
		// here are long on purpose. Tests are left out until #459 splits them.
		files: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}'],
		rules: {
			'max-lines': ['warn', { max: 600, skipBlankLines: true, skipComments: true }],
		},
	},
	{
		// Core's test doubles are `@skysa/core/testing` (#449), for tests alone:
		// nothing the app ships may reach them, by the entry or by a path into
		// any tests folder. typescript-eslint's rule rather than core's, which the
		// layer blocks above set per folder and would replace this in each.
		files: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}'],
		rules: {
			'@typescript-eslint/no-restricted-imports': [
				'error',
				{
					paths: [
						{ name: '@skysa/core/testing', message: 'test doubles are for tests.' },
					],
					patterns: [
						{
							group: ['**/tests/**', '**/providers/fake', '**/providers/fake.js'],
							message: 'test doubles are for tests.',
						},
					],
				},
			],
		},
	},

	// ---- The bookmarklet ----------------------------------------------------

	{
		// Plain JavaScript a bookmark runs in another site's page
		// (`apps/web/src/fill/bookmarklet.ts`): of the page's globals, these and
		// nothing else, so it cannot come to need one a page may not have.
		files: ['apps/web/src/fill/bookmarkletCode.js'],
		languageOptions: {
			sourceType: 'script',
			globals: Object.fromEntries(
				[
					'addEventListener',
					'alert',
					'document',
					'Event',
					'getComputedStyle',
					'Node',
					'open',
					'removeEventListener',
				].map((name) => [name, 'readonly'])
			),
		},
	},

	// ---- Relaxations --------------------------------------------------------

	{
		// Vitest's `describe`/`it` callbacks are inherently imperative — shared setup
		// captured in a closure, table-driven loops over fixtures read from disk.
		// Production code keeps full enforcement.
		files: ['**/*.test.ts', '**/*.test.tsx', '**/tests/**/*.ts'],
		rules: {
			'functional/no-let': 'off',
			'functional/no-loop-statements': 'off',
			'functional/immutable-data': 'off',
			'functional/functional-parameters': 'off',
		},
	},
	{
		// Build and tool configuration: plain Node ESM, outside any package's src.
		files: ['*.config.js', '**/*.config.ts'],
		languageOptions: { globals: globals.node },
		rules: {
			'functional/no-let': 'off',
			'functional/immutable-data': 'off',
		},
	},

	// Must stay last: turns off every rule that would fight Prettier.
	prettierConfig
);
