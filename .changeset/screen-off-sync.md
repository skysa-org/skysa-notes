---
'@skysa/core': patch
'@skysa/web': patch
---

A long sync on a phone no longer starts over when the screen goes off. A pull that fails part-way, as one does when a phone's screen times out and takes the network with it, keeps the notes it had already read, and the next try reads only the rest; before, a batch of up to a thousand notes on Google Drive was downloaded again from the first. While a sync long enough to show a count is running and the app is on screen, the app also asks the browser to keep the screen on, and lets go when the sync ends.
