---
'@skysa/api': patch
---

The three storage OAuth flows share their token request, ID-token reading, revoking and default token lifetime (`oauth/common.ts`), and the Dropbox module is only its adapter, as the other two are.
