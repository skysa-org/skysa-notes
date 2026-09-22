import {
	LanguageDescription,
	LanguageSupport,
	StreamLanguage,
	type StreamParser,
} from '@codemirror/language';

/**
 * The languages a code block can be written in, and how to load one.
 *
 * A curated list rather than `@codemirror/language-data`, which knows about a
 * hundred and sixty of them. Every language is a lazily imported chunk, and
 * every chunk in the build is a chunk the service worker precaches so that a
 * note opened offline still highlights — so the list is the offline download,
 * and a hundred and sixty of them would be several megabytes fetched on install
 * for languages nobody in this app will open. These are the ones people write
 * notes about; an unknown language is not an error, it just isn't coloured
 * (`findCodeLanguage` returns nothing and the fence keeps the word it had).
 *
 * The parsers are CodeMirror's because CodeMirror is already here for raw mode,
 * which means one set of grammars serves both editors and one set of token
 * classes styles them (`editor/highlight.ts`).
 */

export interface CodeLanguage {
	/**
	 * What goes in the fence's info string and in the node's `language` attr —
	 * so this is the word that ends up in the user's file.
	 */
	id: string;
	/** What the picker shows. */
	label: string;
	/** Other info strings that mean this language, all lower case. */
	aliases: readonly string[];
	/** Fetches the grammar. Called at most once per language; see `createLanguageSource`. */
	load: () => Promise<LanguageSupport>;
}

/**
 * A legacy CodeMirror 5 mode, wrapped as a language.
 *
 * Shell, Ruby, TOML and the rest have no Lezer grammar. A stream parser is a
 * coarser thing — it has no tree to speak of, only tokens — but tokens are the
 * whole of what highlighting needs, and `highlightTree` reads them the same way.
 */
const legacy = (load: () => Promise<StreamParser<unknown>>) => async (): Promise<LanguageSupport> =>
	new LanguageSupport(StreamLanguage.define(await load()));

/**
 * Every language, in the order the picker lists them: alphabetical by label,
 * because a list this long is one people scan by name.
 */
export const CODE_LANGUAGES: readonly CodeLanguage[] = [
	{
		id: 'bash',
		label: 'Bash',
		aliases: ['sh', 'shell', 'zsh', 'console', 'terminal'],
		load: legacy(() => import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell)),
	},
	{
		id: 'c',
		label: 'C',
		aliases: ['h'],
		load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
	},
	{
		id: 'csharp',
		label: 'C#',
		aliases: ['c#', 'cs', 'dotnet'],
		load: legacy(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.csharp)),
	},
	{
		id: 'cpp',
		label: 'C++',
		aliases: ['c++', 'cc', 'hpp', 'cxx'],
		load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
	},
	{
		id: 'css',
		label: 'CSS',
		aliases: [],
		load: () => import('@codemirror/lang-css').then((m) => m.css()),
	},
	{
		id: 'diff',
		label: 'Diff',
		aliases: ['patch'],
		load: legacy(() => import('@codemirror/legacy-modes/mode/diff').then((m) => m.diff)),
	},
	{
		id: 'dockerfile',
		label: 'Dockerfile',
		aliases: ['docker'],
		load: legacy(() =>
			import('@codemirror/legacy-modes/mode/dockerfile').then((m) => m.dockerFile)
		),
	},
	{
		id: 'go',
		label: 'Go',
		aliases: ['golang'],
		load: () => import('@codemirror/lang-go').then((m) => m.go()),
	},
	{
		id: 'html',
		label: 'HTML',
		aliases: ['htm'],
		load: () => import('@codemirror/lang-html').then((m) => m.html()),
	},
	{
		id: 'ini',
		label: 'INI',
		aliases: ['conf', 'properties', 'cfg'],
		load: legacy(() =>
			import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties)
		),
	},
	{
		id: 'java',
		label: 'Java',
		aliases: [],
		load: () => import('@codemirror/lang-java').then((m) => m.java()),
	},
	{
		id: 'javascript',
		label: 'JavaScript',
		aliases: ['js', 'mjs', 'cjs', 'node'],
		load: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
	},
	{
		id: 'json',
		label: 'JSON',
		aliases: ['jsonc', 'json5'],
		load: () => import('@codemirror/lang-json').then((m) => m.json()),
	},
	{
		id: 'jsx',
		label: 'JSX',
		aliases: [],
		load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
	},
	{
		id: 'kotlin',
		label: 'Kotlin',
		aliases: ['kt', 'kts'],
		load: legacy(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.kotlin)),
	},
	{
		id: 'lua',
		label: 'Lua',
		aliases: [],
		load: legacy(() => import('@codemirror/legacy-modes/mode/lua').then((m) => m.lua)),
	},
	{
		id: 'markdown',
		label: 'Markdown',
		aliases: ['md', 'mdown'],
		load: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
	},
	{
		id: 'php',
		label: 'PHP',
		aliases: [],
		load: () => import('@codemirror/lang-php').then((m) => m.php()),
	},
	{
		id: 'powershell',
		label: 'PowerShell',
		aliases: ['ps1', 'pwsh'],
		load: legacy(() =>
			import('@codemirror/legacy-modes/mode/powershell').then((m) => m.powerShell)
		),
	},
	{
		id: 'python',
		label: 'Python',
		aliases: ['py', 'py3'],
		load: () => import('@codemirror/lang-python').then((m) => m.python()),
	},
	{
		id: 'ruby',
		label: 'Ruby',
		aliases: ['rb'],
		load: legacy(() => import('@codemirror/legacy-modes/mode/ruby').then((m) => m.ruby)),
	},
	{
		id: 'rust',
		label: 'Rust',
		aliases: ['rs'],
		load: () => import('@codemirror/lang-rust').then((m) => m.rust()),
	},
	{
		id: 'sql',
		label: 'SQL',
		aliases: ['postgres', 'postgresql', 'mysql', 'sqlite'],
		load: () => import('@codemirror/lang-sql').then((m) => m.sql()),
	},
	{
		id: 'swift',
		label: 'Swift',
		aliases: [],
		load: legacy(() => import('@codemirror/legacy-modes/mode/swift').then((m) => m.swift)),
	},
	{
		id: 'toml',
		label: 'TOML',
		aliases: [],
		load: legacy(() => import('@codemirror/legacy-modes/mode/toml').then((m) => m.toml)),
	},
	{
		id: 'tsx',
		label: 'TSX',
		aliases: [],
		load: () =>
			import('@codemirror/lang-javascript').then((m) =>
				m.javascript({ jsx: true, typescript: true })
			),
	},
	{
		id: 'typescript',
		label: 'TypeScript',
		aliases: ['ts', 'mts', 'cts'],
		load: () =>
			import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
	},
	{
		id: 'xml',
		label: 'XML',
		aliases: ['svg', 'rss', 'xsd', 'plist'],
		load: () => import('@codemirror/lang-xml').then((m) => m.xml()),
	},
	{
		id: 'yaml',
		label: 'YAML',
		aliases: ['yml'],
		load: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
	},
];

/**
 * The language an info string names, if it is one of ours.
 *
 * Matched on the whole word, case-folded: ```` ```JS ```` is JavaScript and
 * ```` ```jsonnet ```` is nothing, because a prefix match would claim the
 * second. What remark hands over as `lang` is already only the first word of
 * the info string — ```` ```js title=a.js ```` parses as `js` with the rest as
 * meta — but the attr can also come from a `data-language` on pasted HTML, so
 * the first word is taken here too rather than assumed.
 */
export const matchCodeLanguage = (
	languages: readonly CodeLanguage[],
	info: string | undefined
): CodeLanguage | undefined => {
	const wanted = (info ?? '').trim().split(/\s+/u)[0]?.toLowerCase() ?? '';
	if (wanted === '') return undefined;

	return languages.find(
		(language) => language.id === wanted || language.aliases.includes(wanted)
	);
};

export const findCodeLanguage = (info: string | undefined): CodeLanguage | undefined =>
	matchCodeLanguage(CODE_LANGUAGES, info);

/**
 * The same list as CodeMirror's own `LanguageDescription`s, for the raw editor:
 * `@codemirror/lang-markdown` takes these to parse the inside of a fence, so
 * both modes colour a code block from the same grammar rather than from two
 * lists that could drift apart.
 */
export const markdownCodeLanguages = (): LanguageDescription[] =>
	CODE_LANGUAGES.map((language) =>
		LanguageDescription.of({
			name: language.id,
			alias: [...language.aliases],
			load: language.load,
		})
	);

/**
 * Where the rich editor gets a grammar from.
 *
 * A seam rather than a module-level cache, because the highlighting plugin's
 * interesting behaviour is what it does *while* a language is still loading,
 * and a test that had to wait on a real dynamic import to see it would be
 * testing Vite instead.
 */
export interface LanguageSource {
	/** The grammar for this info string, if it is known and already here. */
	get: (info: string | undefined) => LanguageSupport | undefined;
	/**
	 * Fetch the grammar, resolving once `get` would answer — or, for a language
	 * that is not in the list or whose chunk failed to arrive, once it is known
	 * that it never will. Asking twice for the same language fetches once.
	 */
	load: (info: string | undefined) => Promise<void>;
}

export const createLanguageSource = (
	languages: readonly CodeLanguage[] = CODE_LANGUAGES
): LanguageSource => {
	const loaded = new Map<string, LanguageSupport>();
	const loading = new Map<string, Promise<void>>();

	const find = (info: string | undefined): CodeLanguage | undefined =>
		matchCodeLanguage(languages, info);

	return {
		get: (info) => {
			const language = find(info);
			return language === undefined ? undefined : loaded.get(language.id);
		},
		load: async (info) => {
			const language = find(info);
			if (language === undefined || loaded.has(language.id)) return;

			const already = loading.get(language.id);
			if (already !== undefined) return already;

			const fetching = language
				.load()
				.then((support) => {
					loaded.set(language.id, support);
				})
				// A chunk that cannot be fetched — offline, before the service
				// worker has it — must not leave the language looking like it is
				// still on its way, or nothing would ever ask again. The block
				// stays plain, which is what it already was.
				.catch(() => undefined)
				.finally(() => {
					loading.delete(language.id);
				});

			loading.set(language.id, fetching);
			return fetching;
		},
	};
};
