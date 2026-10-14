---
'@skysa/web': minor
---

Secrets: a device whose source key was replaced on another device asks for the new key when it meets a secret made with it, and keeps it as the source's key. A device that still holds the key from before encrypts what that key opens to the new one as it is unlocked, so a replacement that stopped short, or a secret made offline meanwhile, catches up.
