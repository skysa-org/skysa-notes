---
'@skysa/web': minor
'@skysa/core': minor
---

A clipboard a source's devices share. "Show clipboard" in a connected source's storage menu (the gear, or the source's `⋯` on a phone) puts a Clipboard region above the status line, on this device. Paste reads text or a picture from the system clipboard. A keyboard paste or a drop on the region, or "Add a file", adds files of up to 25 MB. Each item shows as a text preview, a thumbnail or a file card. Pressing one copies text or a picture back to the clipboard and saves a file. It keeps the last 10 items, newest first, and pasting something already there moves it to the top. Items are files in a hidden `.clipboard` folder in the app folder. A paste is kept on the device at once and sent when online, and where the instance runs the change relay, the source's other devices show it within a second or two. Not offered for notes kept on this device only. Turning it off only hides it, and disconnecting a source drops its clipboard from the device.

`@skysa/core` exports the clipboard's naming (`clipName`, `readClipName`, `clipStamp`, `clipPath`, `isClipPath`) and its folder and cap (`CLIPBOARD_FOLDER`, `CLIPBOARD_ITEMS`). A sync's outcome now says when a pull met that folder (`SyncOutcome.clipboard`).
