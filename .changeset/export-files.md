---
'@skysa/web': minor
---

Downloads take the files beside the notes (#187). "Download all notes" puts in every file whose current bytes this device holds, at its own path beside the notes that link it, and says how many it left out because the device has never opened them; the disconnect question's download and a detached source's take the files not uploaded yet and the files the unsent notes link, and a file not uploaded yet can be downloaded on its own. The archive is written as parts straight into the blob, so a large file is never copied into one buffer, and one too big for a ZIP is refused before its bytes are read. The archive limits are told in words that name files too. "Download all notes" is offered, in the panel and the palette alike, only where the archive would hold something. A download of what was never sent that fails now says why, in the disconnect question and in a detached source's panel.
