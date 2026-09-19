---
'@skysa/core': patch
'@skysa/web': patch
---

The storage panel now says which files it is not showing. A file in the notes
folder that is not UTF-8 text is left alone, and until now nothing said so: a
note whose file another tool re-saved as Latin-1 simply went from the device.
Each connected source now lists those files by path under its sync status, with
what to do about it — save the file as UTF-8, or delete it — and the line goes
once the file reads, is deleted, is renamed to something that is not a note, or
a re-scan no longer finds it. A note of yours that had to move aside because
such a file has its name is reported like any other conflict copy.

The list is kept with each source's sync cursor and written in the same step, so
it never names a file from a sync that did not finish, and "Re-scan from
scratch" keeps it until the scan has looked. It is a notice only: nothing the
app decides depends on it, and a file on it is still read again every time the
provider mentions it.

For anyone implementing `SyncStore`: there is one new read, `unreadable()`, and
two new `PullChange` kinds, `unreadable` and `forget-unreadable`; `move-folder`
carries the listed paths under a folder along and `delete-folder` drops them.
The store contract suite covers all of it.
