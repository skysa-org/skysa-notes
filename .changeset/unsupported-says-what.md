---
'@skysa/web': minor
'@skysa/core': patch
---

When a note has something the rich editor can't show, the banner now says what
it is and which line it's on — "The rich editor has no way to show a link
reference definition on line 5" — rather than only that there is something.

And the note is no longer stuck in markdown mode for as long as it stays open.
Once you have changed it, the rich text tab (and Ctrl/Cmd+E) is offered again;
pressing it saves what you typed, then opens the rich editor, which checks the
note again before you can type. If it still can't show the note, you are back
in markdown mode with the banner saying what it found this time, and nothing
in the note has been changed.
