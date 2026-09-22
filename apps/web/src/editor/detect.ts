/**
 * Guessing what language a piece of code is written in.
 *
 * Only ever asked when a code block is made out of text that is already there:
 * the user selected something, or put the cursor in a paragraph, and pressed
 * the button. An empty block asks nothing, and a block that already names a
 * language is never second-guessed.
 *
 * The bias runs one way throughout, and it is the same bias the note preview
 * has (docs/PLAN.md §7): **when in doubt, say nothing.** A blank picker costs
 * one click. A confident `python` written into a fence over somebody's
 * pseudocode is a word in their file that they have to notice before they can
 * undo it — and the guess is made in the same transaction as the block, so one
 * undo does take back both.
 *
 * Signatures rather than a library. `highlight.js`'s auto-detection is the
 * thing this imitates, and it works by running every grammar and counting how
 * badly each one does; that means shipping every grammar, which is the cost
 * `editor/languages.ts` exists to avoid — and it is BSD-3, which this repo does
 * not take. What is left is a few dozen distinctive patterns and a threshold,
 * which is a pass over at most four kilobytes and no dependency at all.
 */

/** One language, and what gives it away. */
interface Signature {
	/** A language id from `editor/languages.ts`; the test suite checks that it is one. */
	readonly id: string;
	readonly patterns: readonly Readonly<{ test: RegExp; weight: number }>[];
}

/**
 * How much of the text to look at. A signature that is not in the first
 * hundred lines is not a signature, and a code block can hold a whole file.
 */
const SAMPLE = 4000;

/**
 * What it takes to answer at all, and by how much the winner has to win.
 *
 * Both are deliberately blunt. `MINIMUM` is one decisive giveaway — a shebang,
 * `<?php`, `diff --git` — or two or three ordinary ones; `MARGIN` is what stops
 * the guess where two languages look equally likely, which is exactly where a
 * guess is worth least. C against C++ and Java against C# live in that gap on
 * purpose.
 */
const MINIMUM = 4;
const MARGIN = 2;

/** Weight for something that is the language and could not be anything else. */
const SURE = 10;

/**
 * No `g` flag anywhere below: a global regular expression carries `lastIndex`
 * between calls, so the same pattern over the same text answers differently on
 * the second block of the same note.
 */
const SIGNATURES: readonly Signature[] = [
	{
		id: 'bash',
		patterns: [
			{ test: /^#!.*\b(bash|sh|zsh)\b/mu, weight: SURE },
			{ test: /^\s*\$ \S/mu, weight: 3 },
			{
				test: /^\s*(\$\s+)?(npm|pnpm|yarn|git|docker|brew|apt-get|cargo|pip3?|go|make)\s+(install|run|add|build|test|status|commit|push|pull|clone|start|exec|up)\b/mu,
				weight: 4,
			},
			{
				test: /^\s*(\$\s+)?(sudo|chmod|chown|mkdir|rm|cp|mv|ls|cd|echo|export|source|curl|wget|tar|ssh|kill)\s+\S/mu,
				weight: 2,
			},
			{ test: /\|\s*(grep|awk|sed|xargs|head|tail|sort|uniq|jq)\b/u, weight: 3 },
			{ test: /^\s*(if|for|while)\b.*;\s*(then|do)\b/mu, weight: 3 },
			{ test: /\$\{\w+\}|\$\(\w+/u, weight: 1 },
		],
	},
	{
		id: 'c',
		patterns: [
			{ test: /^\s*#include\s*<\w+\.h>/mu, weight: 4 },
			{ test: /\bprintf\s*\(/u, weight: 3 },
			{ test: /\bint\s+main\s*\(/u, weight: 3 },
			{ test: /\b(struct|typedef)\s+\w+\s*\{/u, weight: 2 },
			{ test: /\bmalloc\s*\(|\bfree\s*\(/u, weight: 2 },
		],
	},
	{
		id: 'cpp',
		patterns: [
			{
				test: /^\s*#include\s*<(iostream|vector|string|map|set|algorithm|memory)>/mu,
				weight: 6,
			},
			{ test: /\bstd::/u, weight: 5 },
			{ test: /\btemplate\s*</u, weight: 4 },
			{ test: /\b(cout|cerr)\s*<</u, weight: 5 },
			{ test: /\bnamespace\s+\w+\s*\{/u, weight: 3 },
		],
	},
	{
		id: 'csharp',
		patterns: [
			{ test: /^\s*using\s+System(\.\w+)*;/mu, weight: SURE },
			{ test: /\bConsole\.(Write|Read)/u, weight: 6 },
			{ test: /^\s*namespace\s+[\w.]+/mu, weight: 3 },
			{ test: /\bpublic\s+(static\s+)?(class|void|string|int|bool)\b/u, weight: 2 },
			{ test: /\bvar\s+\w+\s*=\s*new\s+\w+\(/u, weight: 2 },
		],
	},
	{
		id: 'css',
		patterns: [
			{ test: /^\s*@(media|import|supports|keyframes|font-face)\b/mu, weight: 5 },
			{ test: /^\s*:root\b|^\s*--[\w-]+:/mu, weight: 4 },
			{
				test: /\b(color|background|margin|padding|font-size|display|position|border-radius|flex-direction):\s*[^;{]+;/u,
				weight: 4,
			},
			{ test: /^[.#]?[\w-]+[^{;]*\{\s*$/mu, weight: 2 },
		],
	},
	{
		id: 'diff',
		patterns: [
			{ test: /^diff --git /mu, weight: SURE },
			{ test: /^@@ -\d+(,\d+)? \+\d+/mu, weight: 8 },
			{ test: /^--- .+\n\+\+\+ /mu, weight: 5 },
			{ test: /^[+-](?![+-])\S/mu, weight: 1 },
		],
	},
	{
		id: 'dockerfile',
		patterns: [
			{ test: /^FROM\s+\S+/mu, weight: 6 },
			{
				test: /^(RUN|CMD|ENTRYPOINT|COPY|ADD|WORKDIR|ENV|EXPOSE|VOLUME|ARG)\s+\S/mu,
				weight: 4,
			},
		],
	},
	{
		id: 'go',
		patterns: [
			{ test: /^\s*package\s+\w+\s*$/mu, weight: 5 },
			{ test: /\bfunc\s+(\(\s*\w+\s+\*?\w+\s*\)\s*)?\w*\s*\(/u, weight: 3 },
			{ test: /:=/u, weight: 3 },
			{ test: /^\s*import\s+\(/mu, weight: 3 },
			{ test: /\bfmt\.(Print|Sprint|Errorf)/u, weight: 5 },
		],
	},
	{
		id: 'html',
		patterns: [
			{ test: /<!DOCTYPE\s+html/iu, weight: SURE },
			{ test: /<html[\s>]/iu, weight: 6 },
			{
				test: /<\/(div|span|p|body|head|table|section|header|footer|main|nav)>/iu,
				weight: 3,
			},
			{ test: /<(div|span|img|br|input|link|meta)\b[^>]*>/iu, weight: 2 },
		],
	},
	{
		id: 'java',
		patterns: [
			{ test: /^\s*import\s+java(x)?\./mu, weight: SURE },
			{ test: /\bSystem\.out\.print/u, weight: 6 },
			{
				test: /\b(public|private|protected)\s+(static\s+)?(final\s+)?(class|interface|enum|void|int|String)\b/u,
				weight: 3,
			},
			{ test: /\bpublic\s+static\s+void\s+main\s*\(/u, weight: 5 },
		],
	},
	{
		id: 'javascript',
		patterns: [
			{ test: /\bconsole\.(log|error|warn)\s*\(/u, weight: 4 },
			{ test: /^\s*(const|let)\s+[\w{[]/mu, weight: 3 },
			{ test: /\b(const|let)\s+\w+\s*=/u, weight: 2 },
			{ test: /=>\s*[{([`\w]/u, weight: 2 },
			// `export` on its own would be the shell's, which is why the word
			// after it has to be one JavaScript puts there.
			{
				test: /^\s*export\s+(default|const|let|var|function|async|class|type|interface|\{|\*)/mu,
				weight: 3,
			},
			{ test: /^\s*import\s+([\w*]+\s+from|\{)/mu, weight: 3 },
			{ test: /\b(function\s+\w*\s*\(|async\s+(function|\()|await\s+\w)/u, weight: 2 },
			{ test: /\b(document|window)\.\w+/u, weight: 3 },
			{ test: /\b(require\(|module\.exports)/u, weight: 3 },
			// JSX, which is evidence *for* JavaScript and against HTML — the
			// two otherwise look alike from a closing tag, and `refineJavaScript`
			// below only gets to choose the dialect once the family has won.
			{ test: /\bclassName=/u, weight: 4 },
			{ test: /return\s*\(\s*</u, weight: 3 },
		],
	},
	{
		id: 'kotlin',
		patterns: [
			{ test: /\bfun\s+\w+\s*\(/u, weight: 4 },
			{ test: /^\s*val\s+\w+/mu, weight: 3 },
			{ test: /\bprintln\s*\(/u, weight: 2 },
			{ test: /:\s*\w+\?\s*=/u, weight: 2 },
		],
	},
	{
		id: 'markdown',
		patterns: [
			{ test: /^#{1,6}\s+\S/mu, weight: 2 },
			{ test: /\[[^\]\n]+\]\([^)\n]+\)/u, weight: 3 },
			{ test: /^\s*```/mu, weight: 3 },
			{ test: /^\s*[-*]\s+\[[ x]\]\s/mu, weight: 4 },
			{ test: /^\s*\|.+\|\s*$/mu, weight: 2 },
			{ test: /\*\*[^*\n]+\*\*/u, weight: 2 },
		],
	},
	{
		id: 'php',
		patterns: [
			{ test: /<\?php/u, weight: SURE },
			{ test: /\becho\s+["'$]/u, weight: 3 },
			{ test: /\$this->\w+/u, weight: 4 },
			{ test: /^\s*(namespace|use)\s+\w+\\/mu, weight: 4 },
		],
	},
	{
		id: 'python',
		patterns: [
			{ test: /^#!.*\bpython/mu, weight: SURE },
			{ test: /^\s*def\s+\w+\s*\([^)]*\)\s*(->[^:]+)?:/mu, weight: 4 },
			{ test: /^\s*class\s+\w+(\([^)]*\))?\s*:/mu, weight: 4 },
			{ test: /^\s*(from\s+[\w.]+\s+)?import\s+[\w*]/mu, weight: 3 },
			{
				test: /^\s*(if|elif|else|for|while|try|except|finally|with)\b[^\n]*:\s*$/mu,
				weight: 3,
			},
			{ test: /\bself\b/u, weight: 2 },
			{ test: /\bprint\s*\(/u, weight: 1 },
			{ test: /\bf["'][^"'\n]*\{/u, weight: 3 },
		],
	},
	{
		id: 'ruby',
		patterns: [
			{ test: /^#!.*\bruby/mu, weight: SURE },
			{ test: /\bputs\s+\S/u, weight: 5 },
			{ test: /\bdo\s*\|\w+/u, weight: 5 },
			{ test: /^\s*require(_relative)?\s+['"]/mu, weight: 4 },
			{ test: /:\w+\s*=>/u, weight: 3 },
			{ test: /^\s*def\s+\w+[^:\n]*$/mu, weight: 2 },
			{ test: /^\s*end\s*$/mu, weight: 2 },
		],
	},
	{
		id: 'rust',
		patterns: [
			{ test: /\bprintln!|\bvec!|\bformat!/u, weight: 6 },
			{ test: /\blet\s+mut\b/u, weight: 5 },
			{ test: /\bfn\s+\w+\s*(<[^>]*>)?\s*\(/u, weight: 3 },
			{ test: /\bimpl\s+\w+/u, weight: 4 },
			{ test: /^\s*use\s+[\w:]+(::\{[^}]*\})?;/mu, weight: 4 },
			{ test: /->\s*(Result|Option)</u, weight: 5 },
			{ test: /\b(pub\s+)?(struct|enum)\s+\w+/u, weight: 2 },
		],
	},
	{
		id: 'sql',
		patterns: [
			{ test: /\bSELECT\b[\s\S]{0,400}\bFROM\b/iu, weight: 6 },
			{
				test: /\b(INSERT\s+INTO|UPDATE\s+[\w.]+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW)|ALTER\s+TABLE|DROP\s+TABLE)\b/iu,
				weight: 6,
			},
			{ test: /\b(INNER|LEFT|RIGHT|FULL|CROSS)\s+JOIN\b/iu, weight: 4 },
			{ test: /\b(GROUP\s+BY|ORDER\s+BY|HAVING)\b/iu, weight: 3 },
		],
	},
	{
		id: 'toml',
		patterns: [
			{ test: /^\s*\[[\w.-]+\]\s*$/mu, weight: 4 },
			{ test: /^\s*\[\[[\w.-]+\]\]\s*$/mu, weight: 6 },
			{ test: /^\s*[\w-]+\s*=\s*("|'|\d|\[|true|false)/mu, weight: 3 },
		],
	},
	{
		id: 'xml',
		patterns: [
			{ test: /<\?xml[\s>]/u, weight: SURE },
			{ test: /<\w+(:\w+)?\s+xmlns/u, weight: 6 },
			{ test: /<\/\w+:\w+>/u, weight: 4 },
		],
	},
	{
		id: 'yaml',
		patterns: [
			{ test: /^---\s*$/mu, weight: 4 },
			{ test: /^\s{2,}[\w-]+:\s*(\S|$)/mu, weight: 3 },
			{ test: /^\s*-\s+[\w-]+:\s/mu, weight: 4 },
			{ test: /^[\w-]+:\s*$/mu, weight: 2 },
			{ test: /^\s*-\s+\S/mu, weight: 1 },
		],
	},
];

/**
 * JSON is not guessed at, it is checked: a body that parses is JSON and a body
 * that does not is not, which is a stronger answer than any pattern gives.
 *
 * The cheap test comes first so that a page of prose is not handed to
 * `JSON.parse` on every press.
 */
const looksLikeJson = (text: string): boolean => {
	const trimmed = text.trim();
	if (!/^[{[]/u.test(trimmed) || !/[\]}]$/u.test(trimmed)) return false;

	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		// Not JSON, or JSON cut short by the sample — either way, no claim.
		return false;
	}
};

/**
 * JavaScript, or one of the three things people mean by it.
 *
 * Asked only once JavaScript has already won, because every signal here is a
 * *distinction within* the family rather than evidence for it: `interface` is
 * TypeScript only among languages that already look like JavaScript, and JSX
 * is a closing tag in a file that is plainly not HTML. Guessing plain
 * `javascript` for a snippet full of JSX would be worse than saying nothing —
 * the grammar would mark every tag invalid and underline it in red.
 */
const refineJavaScript = (text: string): string => {
	const typed =
		/^\s*(export\s+)?(interface|type)\s+\w+[\s=<]/mu.test(text) ||
		/:\s*(string|number|boolean|void|unknown|any|Promise<)/u.test(text) ||
		/\bas\s+(const|string|number)\b/u.test(text) ||
		/^\s*(public|private|readonly)\s+\w+\s*[:(]/mu.test(text) ||
		// `note: Note` — an annotation naming a type of the code's own, which is
		// most of what a real snippet's types are.
		/\b\w+\s*:\s*[A-Z]\w*(\[\])?\s*[,;)}]/u.test(text);

	const jsx =
		/<\/[A-Za-z][\w.]*>/u.test(text) ||
		/<[A-Z][\w.]*(\s[^>]*)?\/>/u.test(text) ||
		/return\s*\(\s*</u.test(text);

	if (jsx) return typed ? 'tsx' : 'jsx';
	return typed ? 'typescript' : 'javascript';
};

const scoreOf = (text: string, signature: Signature): number =>
	signature.patterns.reduce(
		(total, pattern) => total + (pattern.test.test(text) ? pattern.weight : 0),
		0
	);

/**
 * The language this text is written in, when that is clear enough to say.
 *
 * `undefined` is the honest answer more often than not, and is what the caller
 * turns into a fence with no word after it.
 */
export const detectLanguage = (source: string): string | undefined => {
	const text = source.slice(0, SAMPLE);
	if (text.trim() === '') return undefined;

	const scored = [
		{ id: 'json', score: looksLikeJson(text) ? SURE : 0 },
		...SIGNATURES.map((signature) => ({ id: signature.id, score: scoreOf(text, signature) })),
	].sort((a, b) => b.score - a.score);

	const best = scored[0];
	const next = scored[1];
	if (best === undefined || best.score < MINIMUM) return undefined;
	if (best.score - (next?.score ?? 0) < MARGIN) return undefined;

	return best.id === 'javascript' ? refineJavaScript(text) : best.id;
};

/** The ids this module can answer with, for the suite that checks they all exist. */
export const DETECTABLE = [
	'json',
	...SIGNATURES.map((signature) => signature.id),
	'typescript',
	'jsx',
	'tsx',
] as const;
