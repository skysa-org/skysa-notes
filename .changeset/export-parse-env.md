---
'@skysa/api': patch
---

`parseEnv` and `AppConfig` are exported from the package entry beside
`createApp`, so an operator writing their own Worker entry can build its
config through the same validation the default entry uses.
