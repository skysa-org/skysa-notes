---
'@skysa/web': patch
---

With instant updates between devices turned on, a change made on another device no longer sometimes waits a minute to arrive. Google Drive takes a few seconds to report a change, and a device used to ask it once and then wait for the next minute's sync. It now looks again a few seconds later. This was most noticeable with the clipboard: an item added, or several removed one after another, could take a minute to show on your other devices. An item removed from the clipboard on another device also no longer stays on this one until the next change to the clipboard.
