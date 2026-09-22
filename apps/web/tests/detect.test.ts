import { describe, expect, it } from 'vitest';

import { DETECTABLE, detectLanguage } from '../src/editor/detect.js';
import { findCodeLanguage } from '../src/editor/languages.js';

/**
 * Guessing a code block's language from the text it is made out of.
 *
 * Two suites, and the second is the important one. The first says the guesser
 * recognises what it claims to recognise; the second says it keeps quiet
 * everywhere else — which is the whole design, since a wrong guess writes a
 * word into the user's file and a missing one costs a click.
 *
 * The snippets are deliberately the size people actually paste. A guesser
 * tested on a full source file is a guesser tested where the answer was never
 * in doubt.
 */

const RECOGNISED: readonly (readonly [string, string])[] = [
	['bash', '#!/usr/bin/env bash\nset -euo pipefail\ncurl -s "$URL" | jq .\n'],
	['bash', 'npm install\nnpm run build\n'],
	['bash', '$ git status\n$ git commit -m "wip"\n'],
	['c', '#include <stdio.h>\n\nint main(void) {\n  printf("hi\\n");\n  return 0;\n}\n'],
	['cpp', '#include <iostream>\n\nint main() {\n  std::cout << "hi" << std::endl;\n}\n'],
	['csharp', 'using System;\n\nConsole.WriteLine("hi");\n'],
	['css', '.card {\n  display: flex;\n  padding: 1rem;\n  border-radius: 8px;\n}\n'],
	['diff', 'diff --git a/x.ts b/x.ts\n@@ -1,3 +1,4 @@\n-old\n+new\n'],
	[
		'dockerfile',
		'FROM node:22-alpine\nWORKDIR /app\nRUN pnpm install\nCMD ["node", "server.js"]\n',
	],
	['go', 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n'],
	['html', '<!DOCTYPE html>\n<html>\n  <body><div class="x">hi</div></body>\n</html>\n'],
	[
		'java',
		'import java.util.List;\n\npublic class Main {\n  public static void main(String[] args) {\n    System.out.println("hi");\n  }\n}\n',
	],
	[
		'javascript',
		'const rows = await load();\nconsole.log(rows.length);\nmodule.exports = rows;\n',
	],
	['json', '{\n  "name": "skysa-notes",\n  "private": true,\n  "version": "0.1.0"\n}\n'],
	['jsx', 'const App = () => {\n  return (\n    <div className="app">hi</div>\n  );\n};\n'],
	['kotlin', 'fun main() {\n    val greeting = "hi"\n    println(greeting)\n}\n'],
	[
		'markdown',
		'# Release notes\n\n- [x] shipped\n- [ ] pending\n\nSee [the plan](docs/PLAN.md) for **why**.\n',
	],
	['php', '<?php\n\n$rows = $this->repo->all();\necho count($rows);\n'],
	[
		'python',
		'import json\n\n\ndef load(path):\n    with open(path) as handle:\n        return json.load(handle)\n',
	],
	['ruby', "require 'json'\n\nrows.each do |row|\n  puts row[:name]\nend\n"],
	['rust', 'use std::fs;\n\nfn main() {\n    let mut total = 0;\n    println!("{total}");\n}\n'],
	['sql', 'SELECT id, name\nFROM notes\nWHERE folder_id = ?\nORDER BY updated_at DESC;\n'],
	['toml', '[package]\nname = "skysa"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n'],
	[
		'tsx',
		'export const Row = ({ note }: { note: Note }) => {\n  return (\n    <li>{note.title}</li>\n  );\n};\n',
	],
	[
		'typescript',
		'export interface Note {\n  id: string;\n  title: string;\n}\n\nconst load = async (): Promise<Note[]> => [];\n',
	],
	['xml', '<?xml version="1.0"?>\n<feed><entry><title>hi</title></entry></feed>\n'],
	[
		'yaml',
		'name: CI\non:\n  push:\n    branches:\n      - main\njobs:\n  test:\n    runs-on: ubuntu-latest\n',
	],
];

describe('detectLanguage', () => {
	it.each(RECOGNISED)('recognises %s (%#)', (language, snippet) => {
		expect(detectLanguage(snippet)).toBe(language);
	});

	/** A guess it cannot honour is worse than no guess: every id has to be one the picker offers. */
	it('only ever answers with a language the editor knows', () => {
		DETECTABLE.forEach((id) => {
			expect(findCodeLanguage(id)?.id, id).toBe(id);
		});
	});
});

/**
 * Where it is meant to say nothing. These are not edge cases dug up to make a
 * point — they are what a notes app is full of: a sentence, a name, a number,
 * a line of shell-ish English.
 */
const DECLINED: readonly (readonly [string, string])[] = [
	['nothing at all', ''],
	['whitespace', '   \n\n\t\n'],
	['a sentence', 'Ask the provider for the file and see what it says.\n'],
	['a short assignment', 'x = 1\n'],
	['a word', 'total\n'],
	['a list of names', 'alpha\nbeta\ngamma\n'],
	['prose with a colon in it', 'Note: this is the part that matters.\n'],
	['a path', 'apps/web/src/editor/detect.ts\n'],
	['a number', '42\n'],
	['pseudocode', 'take each note\n  if it changed, upload it\n  otherwise leave it\n'],
];

describe('detectLanguage, where it should not guess', () => {
	it.each(DECLINED)('says nothing about %s', (_what, text) => {
		expect(detectLanguage(text)).toBeUndefined();
	});

	/**
	 * The margin rule, put to the two pairs it exists for. Both of these can be
	 * told apart by a human reading more of the file, and neither can be told
	 * apart from five lines — so five lines gets no answer.
	 */
	it('declines when two languages look equally likely', () => {
		// Java or C#: a class, a method, nothing that belongs to only one.
		expect(
			detectLanguage('public class Thing {\n  public void run() {\n  }\n}\n')
		).toBeUndefined();
	});

	/** Long input is sampled, not read to the end, and must still come out the same. */
	it('reads enough of a long block to be sure', () => {
		const long = `def handle(row):\n    return row\n\n${'# padding\n'.repeat(2000)}`;

		expect(long.length).toBeGreaterThan(4000);
		expect(detectLanguage(long)).toBe('python');
	});

	/**
	 * A pattern carrying the `g` flag would keep `lastIndex` between calls and
	 * answer differently the second time — which would show up as the second
	 * code block in a note being guessed wrongly, and nowhere else.
	 */
	it('answers the same way twice', () => {
		const snippet = 'SELECT * FROM notes WHERE id = 1;\n';

		expect(detectLanguage(snippet)).toBe('sql');
		expect(detectLanguage(snippet)).toBe('sql');
		expect(detectLanguage(snippet)).toBe('sql');
	});
});
