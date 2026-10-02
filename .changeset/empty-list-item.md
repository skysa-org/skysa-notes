---
'@skysa/web': patch
---

An empty list item is written as its marker alone — `-`, `2.` — instead of `- <br />`. Pressing Enter after a list item and switching to the markdown showed a `<br />` nobody had typed; and a note with an empty item in it (`-` on a line of its own) opened in the markdown editor, with the banner saying the rich editor could not show it. An empty task item still needs `- [ ] <br />`, since `- [ ]` alone is not a task.
