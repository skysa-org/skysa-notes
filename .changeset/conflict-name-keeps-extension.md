---
'@skysa/core': patch
---

On Google Drive, two files of the same name in one folder are no longer separated by renaming the second to a note: a picture named `photo.png` became `photo.png (conflict …).md`, which the app would then try to read as text. A file that is not a note keeps its own extension in its conflict name (`photo (conflict …).png`), and a second copy with the same bytes goes to the trash instead of being kept beside the first. Notes are renamed as before. Nothing the app writes today is affected; it clears the way for attachments (#187).
