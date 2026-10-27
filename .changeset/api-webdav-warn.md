---
'@skysa/api': patch
---

`/api/config` no longer offers `webdav`, whose connect answers 404, though `ENABLED_PROVIDERS=webdav` still boots. The Worker logs a warning at boot for `webdav` in `ENABLED_PROVIDERS` and for `WEBDAV_ALLOW_PRIVATE`, which is deprecated and does nothing; both are removed with the breaking change #118 tracks.
