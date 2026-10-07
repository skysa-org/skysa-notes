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
		selector: 'AwaitExpression > ImportExpression',
		message:
			'Await with dynamic imports (await import()) is not allowed. Use static imports at the top of the file instead.',
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
/**
 * The components whose words are still written into them, until the change that
 * moves each one's into the catalog takes it off this list. Nothing is added to
 * it.
 */
const WORDS_NOT_MOVED_YET = [
	'apps/web/src/components/AccountPanel.tsx',
	'apps/web/src/components/AttachedFiles.tsx',
	'apps/web/src/components/ClipboardPanel.tsx',
	'apps/web/src/components/CompactBar.tsx',
	'apps/web/src/components/ConnectButton.tsx',
	'apps/web/src/components/DeletedNotice.tsx',
	'apps/web/src/components/FindBar.tsx',
	'apps/web/src/components/ImportNotes.tsx',
	'apps/web/src/components/NoteList.tsx',
	'apps/web/src/components/NoteView.tsx',
	'apps/web/src/components/Outline.tsx',
	'apps/web/src/components/RowOptions.tsx',
	'apps/web/src/components/RowRename.tsx',
	'apps/web/src/components/ScratchControls.tsx',
	'apps/web/src/components/Scratchpad.tsx',
	'apps/web/src/components/SearchField.tsx',
	'apps/web/src/components/Sidebar.tsx',
	'apps/web/src/components/unsupported.tsx',
	'apps/web/src/install/InstallBanner.tsx',
	'apps/web/src/routes/index.tsx',
	'apps/web/src/share/TakeShare.tsx',
];

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
		files: ['apps/web/**/*.tsx'],
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

	// ---- The app's words ----------------------------------------------------

	{
		files: ['apps/web/src/**/*.tsx'],
		ignores: WORDS_NOT_MOVED_YET,
		rules: { 'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX, ...INLINE_WORDS] },
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
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['node:*', 'fs', 'path', 'crypto', 'stream'],
							message: 'packages/core must not depend on Node built-ins.',
						},
						{
							group: ['@skysa/web', '@skysa/api', '**/apps/**'],
							message: 'packages/core must not import from apps/*.',
						},
					],
				},
			],
		},
	},
	{
		// No Node built-ins anywhere in the Worker, `worker.ts` included: the
		// entry module is the likeliest place for one to appear, and nothing else
		// in the gate would notice. `pnpm typecheck` passes (apps/api's src and
		// tests are one TypeScript program and the tests legitimately pull
		// @types/node in) and so does `wrangler deploy --dry-run` — the import
		// goes straight into the bundle, and only the deployed Worker finds out.
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
							group: ['node:*', 'fs', 'path', 'stream'],
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
							group: ['node:*', 'fs', 'path', 'stream'],
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
