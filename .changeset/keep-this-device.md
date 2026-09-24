---
'@skysa/web': minor
---

The app asks the browser to keep this device's notes
(`navigator.storage.persist()`): once, when the first note is made in the
device's own library, and again when the app is installed. While the browser
has not agreed and the notes here are the only copy, the storage panel says
the browser may clear them without warning, and that connecting storage or
downloading them keeps them.
