---
'@skysa/api': patch
---

JSON the API reads from outside its own code is checked against a schema rather than cast: provider token responses (a field of the wrong kind is dropped, a lifetime sent as digits is read as a number, and an access token that is not a string fails the exchange), ID-token claims, the signed flow cookies, the stored OAuth secret, and the relay's frames and tickets.
