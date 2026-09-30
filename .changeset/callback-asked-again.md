---
'@skysa/api': patch
'@skysa/web': patch
---

The OAuth callback no longer strands a browser that asks for it twice. Its
answer is kept for five minutes in a signed cookie, `skysa_flow_answer`, so the
same callback asked for again, as after going on past a browser's warning page,
a reload or the back button, is sent where the first was, `?connect=` outcome
and all, and exchanges nothing. A callback with no flow of this browser's
behind it, which was answered `flow_expired` in raw JSON, is sent back to the
app as `?connect=expired`, and the app says that connecting did not finish and
to connect again if the storage is not connected.
