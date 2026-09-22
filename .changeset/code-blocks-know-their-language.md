---
'@skysa/web': patch
---

Code blocks now say what language they are written in, and both editors colour
what is inside them. A fence had a language in the file and nowhere on screen:
the rich editor drew a plain `<pre>` and the only way to set or change the word
after the backticks was to switch to raw mode and type it.

A bar of tools floats under the code block the cursor is in, and under no
other: nothing sits above the code, where a row of controls on every block
would be a row of controls in the way of every block. On it are the language
picker, wrapping, line numbers, copy and delete.

Choosing a language rewrites the fence's info string, which is an edit like any
other — it changes the file. A fence that says `js` shows as JavaScript without
being rewritten to `javascript`, and a language this app has never heard of —
`mermaid`, something from another tool — keeps its word, keeps its place in the
picker, and is simply left uncoloured.

Wrapping and line numbers are the reader's settings rather than the note's:
there is nowhere in markdown to write either one, so they apply to every code
block in every note and are remembered on this device until they are changed
again. Nothing either of them does touches a file.

Thirty languages, each fetched only when a note actually holds one, and all of
them available offline. The list is curated rather than the whole of
`@codemirror/language-data`: every language is a chunk the service worker
precaches, so the list is what the app downloads to be able to work offline —
thirty is about 550 KiB of grammars and nothing added to the first load, where
a hundred and sixty would be several megabytes of languages nobody opens.

Raw mode colours the inside of a fence too, with the same grammars and the same
palette, so a code block looks the same whichever mode the note is open in.
Markdown's own syntax stays in black and white there: raw mode is the mode
where the characters are the formatting.

Inline code is now drawn as a chip — monospace, a tint, a thin edge and its own
ink — so a `--flag` in the middle of a sentence is visibly not the sentence.

A block that names no language says "Detect language", and means it. Turning
text you have already written into a code block guesses from that text: select
a snippet, press the button, and the fence comes with `python` or `sql` or
`diff` already on it. A block started empty works it out as it is typed or
pasted into, and stops asking the moment it has an answer — a language you
picked yourself, or one the file came with, is never second-guessed. The guess
rides along with the edit that prompted it, so a single undo takes back both.

It only answers when the text is distinctive: prose, a path, a list of names or
a snippet that could as easily be Java as C# stays blank, because a blank
picker costs a click and a wrong word in the fence has to be noticed before it
can be undone. Text the app itself puts in the editor — a sync pull, a switch
back from raw mode — is never labelled: a note nobody typed in comes back byte
for byte.

A note that ends in a code block has a way out of it again. Clicking below the
last block used to put the cursor inside the code, because that was the nearest
place a cursor could go, and typing added a line to the code sample. There is
now a strip under such a block — and a button on it for the keyboard — that
puts a paragraph after it. Clicking it and then thinking better of it costs
nothing: the note is not marked as changed, and the empty paragraph is taken
back when the cursor leaves it.

Selecting text inside a code block no longer brings up the floating formatting
toolbar. A code block holds no marks, so every button on it was a button that
did nothing.

The toolbar has a code block button, the one insert it offers; the rest — a
table, a quote, a divider — still comes from the `/` menu. It lights up inside
a code block and pressing it again gives the block back as plain text, and the
mark buttons are grey in there, since a code block holds no marks.
