---
'@skysa/web': minor
---

The secrets dialog's steps are laid out so the button row holds only the way out and the answer:

- On a device that is set up, "Change how this device unlocks" and "Replace this source's key" are a list in the dialog rather than buttons crowding its row. The row has Remove from this device (and Lock now, while unlocked) on the left, and Unlock on the right.
- Checking a new recovery key asks for its two groups in numbered cells side by side, drawn like the cells the whole key is typed into. Typing goes on from the first to the second as it fills, and Backspace in an empty cell goes back.
- Print and Copy are under the new key, and Scan QR code is under the cells a key is typed into.
- When secrets in the source were made with another key, "Use that key instead" and "Add it as well" are a list in the dialog, with Continue in the row.
- The recovery key's QR code lines up with its groups.
