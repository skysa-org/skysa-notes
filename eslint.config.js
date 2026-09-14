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
 * Google's style rules. Most of the formatting entries are switched back off by
 * `prettierConfig` at the bottom; they are kept because the set also carries
 * real correctness rules (`guard-for-in`, `no-invalid-this`, `no-throw-literal`,
 * ...) and splitting the two apart would make it harder to compare this file
 * against the config it was ported from.
 */
const googleRules = {
	'no-cond-assign': 0, // eslint:recommended
	'no-irregular-whitespace': 2, // eslint:recommended
	'no-unexpected-multiline': 2, // eslint:recommended
	curly: [2, 'multi-line'],
	'guard-for-in': 2,
	'no-caller': 2,
	'no-extend-native': 2,
	'no-extra-bind': 2,
	'no-invalid-this': 2,
	'no-multi-spaces': 2,
	'no-multi-str': 2,
	'no-new-wrappers': 2,
	'no-throw-literal': 2, // eslint:recommended
	'no-with': 2,
	'prefer-promise-reject-errors': 2,
	'no-unused-vars': [2, { args: 'none' }], // eslint:recommended
	'array-bracket-newline': 0, // eslint:recommended
	'array-bracket-spacing': [2, 'never'],
	'array-element-newline': 0, // eslint:recommended
	'block-spacing': [2, 'never'],
	'brace-style': 2,
	'comma-spacing': 2,
	'comma-style': 2,
	'computed-property-spacing': 2,
	'eol-last': 2,
	'key-spacing': 2,
	'keyword-spacing': 2,
	'linebreak-style': 2,
	'no-array-constructor': 2,
	'no-multiple-empty-lines': [2, { max: 2 }],
	'no-trailing-spaces': 2,
	'one-var': [2, { var: 'never', let: 'never', const: 'never' }],
	'padded-blocks': [2, 'never'],
	quotes: [2, 'single', { allowTemplateLiterals: true }],
	semi: 2,
	'semi-spacing': 2,
	'space-before-blocks': 2,
	'spaced-comment': [2, 'always'],
	'switch-colon-spacing': 2,
	'arrow-parens': [2, 'always'],
	'constructor-super': 2, // eslint:recommended
	'generator-star-spacing': [2, 'after'],
	'no-this-before-super': 2, // eslint:recommended
	'no-var': 2,
	'prefer-const': [2, { destructuring: 'all' }],
	'prefer-rest-params': 2,
	'prefer-spread': 2,
	'rest-spread-spacing': 2,
	'yield-star-spacing': [2, 'after'],
};

/**
 * The TypeScript and functional-style baseline. Shared verbatim between the
 * `.ts` and `.tsx` blocks so component code is held to the same standard as the
 * rest of the repo, rather than a looser one.
 */
const typescriptRules = {
	'object-shorthand': 'error',
	'no-param-reassign': 'error',
	eqeqeq: 'error',
	'prefer-arrow-callback': 'error',
	'arrow-body-style': ['error', 'as-needed'],
	complexity: ['error', 20],
	'max-depth': ['error', 2],
	'no-else-return': 'error',
	'no-console': 'error',
	'no-debugger': 'error',
	'no-alert': 'error',
	camelcase: [
		'error',
		{ ignoreDestructuring: true, ignoreImports: true, ignoreGlobals: true, allow: [''] },
	],
	'func-style': ['error', 'expression'],
	'prefer-arrow-functions/prefer-arrow-functions': [
		'error',
		{ disallowPrototype: true, singleReturnOnly: false, classPropertiesAllowed: false },
	],
	'no-restricted-syntax': [
		'error',
		{
			selector: 'IfStatement > IfStatement.alternate',
			message: "'else if' is not allowed, use early returns instead.",
		},
		{
			selector: 'AwaitExpression > ImportExpression',
			message:
				'Await with dynamic imports (await import()) is not allowed. Use static imports at the top of the file instead.',
		},
	],

	'unused-imports/no-unused-imports': 'error',
	'simple-import-sort/imports': 'error',

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
	'@typescript-eslint/no-explicit-any': 'off',
	'@typescript-eslint/restrict-template-expressions': 'error',
	'@typescript-eslint/restrict-plus-operands': 'error',
	'@typescript-eslint/no-redundant-type-constituents': 'error',
	'@typescript-eslint/no-extra-non-null-assertion': 'error',
	'@typescript-eslint/no-duplicate-enum-values': 'error',
	'@typescript-eslint/no-duplicate-type-constituents': 'error',
	'@typescript-eslint/no-array-delete': 'error',
	'@typescript-eslint/no-base-to-string': 'error',
	'@typescript-eslint/no-for-in-array': 'error',
	'@typescript-eslint/no-this-alias': 'error',
	'@typescript-eslint/no-unnecessary-condition': 'error',
	'@typescript-eslint/no-unnecessary-type-assertion': 'error',
	'@typescript-eslint/no-unnecessary-type-constraint': 'error',
	'@typescript-eslint/triple-slash-reference': 'error',
	'@typescript-eslint/no-empty-function': 'error',
	'@typescript-eslint/no-wrapper-object-types': 'error',
	'@typescript-eslint/consistent-type-imports': 'error',
	'@typescript-eslint/no-deprecated': 'error',
	'no-throw-literal': 'off',
	'@typescript-eslint/only-throw-error': 'error',
	'@typescript-eslint/prefer-as-const': 'error',
	'prefer-promise-reject-errors': 'off',
	'@typescript-eslint/prefer-promise-reject-errors': 'error',
	'require-await': 'off',
	'@typescript-eslint/require-await': 'error',
};

export default tseslint.config(
	{
		ignores: [
			'**/dist/**',
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
	{
		files: ['packages/**/*.ts', 'apps/**/*.{ts,tsx}'],
		rules: googleRules,
	},
	{
		files: ['packages/**/*.ts', 'apps/**/*.ts'],
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
		rules: {
			...typescriptRules,
			// `core` runs in the browser, Node and Workers, so nothing here may be
			// class-based or depend on an environment-specific global.
			'functional/no-classes': 'error',
			'functional/immutable-data': ['error', { ignoreMapsAndSets: true }],
		},
	},
	{
		files: ['apps/web/**/*.tsx'],
		extends: [
			...tseslint.configs.recommendedTypeChecked,
			react.configs.flat.recommended,
			react.configs.flat['jsx-runtime'], // new JSX transform — no `React` import needed
			jsxA11y.flatConfigs.recommended,
		],
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
			globals: globals.browser,
		},
		plugins: {
			'prefer-arrow-functions': preferArrowFunctions,
			functional,
			'unused-imports': unusedImports,
			'simple-import-sort': simpleImportSort,
			'react-hooks': reactHooks,
		},
		settings: {
			// Explicit rather than 'detect': eslint-plugin-react 7.37.5's version
			// detection calls an API ESLint 10's flat-config rule context no longer
			// exposes, and crashes the run instead of warning. Keep in sync with
			// apps/web's react dependency.
			react: { version: '19.3.0' },
		},
		rules: {
			...reactHooks.configs['recommended-latest'].rules,
			...typescriptRules,
			// Two relaxations for React specifically. `functional/no-classes` would
			// flag a future error boundary, which has no non-class API, and
			// `functional/immutable-data` flags ordinary useState setter patterns.
			'react/react-in-jsx-scope': 'off', // React 19 automatic JSX runtime
			'react/prop-types': 'off', // types come from TypeScript
		},
	},
	{
		// packages/core must stay framework-free and portable: browser, Node, Workers.
		files: ['packages/core/src/**/*.ts'],
		languageOptions: { globals: globals.browser },
		rules: {
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
		// Only worker.ts may read the Workers env.
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
		},
	},
	{
		// Workers has no logger binding and no stdout: `console` is the only sink
		// Cloudflare's observability and `wrangler tail` read. Scoped to the two
		// places that report an error, not opened up across the API.
		files: ['apps/api/src/worker.ts', 'apps/api/src/app.ts'],
		rules: { 'no-console': 'off' },
	},
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
	// Must stay last: turns off every rule that would fight Prettier, including the
	// formatting entries in googleRules above.
	prettierConfig
);
