---
'@skysa/web': patch
---

The storage accounts on a device are tabs across the top of the app, named
"Dropbox", "OneDrive" and "Google Drive" — with a number on the second of a
provider, "Dropbox 2" — and renamable to whatever the user likes.

A device can hold several accounts at once, each its own notes, notebooks,
queue and cursor, and the only way between them was a list at the foot of the
storage panel. That answered "switch me" and never "which of these am I
looking at", which is the question the panes below the bar depend on. Every
source is up there: the live ones, the detached ones — they hold work their
remote was never sent and can still be written in, so leaving them out would
hide notes — and the device's own pile when it holds anything. Disconnected
says so in words, not only in colour.

Pressing the tab that is already showing turns it into its own name. Enter
takes it, Escape abandons it, clicking away takes it; clearing it puts the
derived name back. The name is this device's, kept apart from the one the
server gives: that one is overwritten on every reconcile and a rename stored
there would not survive the next one. A `+` at the end of the bar offers the
providers the deployment has.

Numbering is derived rather than stamped on at connect time, so sources
already on a device get names with no backfill and letting the first Dropbox
go leaves the other one called "Dropbox" instead of a "Dropbox 2" with no 1
above it. A name the user chose is never moved by that.
