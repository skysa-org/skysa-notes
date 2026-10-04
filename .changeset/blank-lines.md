---
'@skysa/web': patch
---

An empty line in the rich editor is written to the note as a blank line, not as `<br />`. Two blank lines between paragraphs are one empty line in rich text, and three are two, so a note another app wrote opens with the spacing its text shows. Pressing Enter in an empty note, or at the top or end of one, no longer sends the note to markdown mode with "The rich editor has no way to show the HTML `<br />` on line 1": an empty line at the top or end of a note is written as nothing. A `<br />` already in a note is kept as written and shows in rich text, where it can be deleted. An empty task item is still written `- [ ] <br />`, since `- [ ]` alone is not a task in markdown.
