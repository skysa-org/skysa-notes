---
'@skysa/core': minor
---

Core knows which site a password is for, and whether it fills a page: `siteOf` reads an item's Site, `pageSite` the origin a page's message came from, and `fillsOn` says whether the one fills the other — the same host or one under it, on its port, never `https:` to `http:`. An item's payload keeps its sites in `urls` and the passwords an Update replaced in `previousPasswords` (`vaultUrls`, `withVaultUrls`, `vaultPrevious`, `withReplacedPassword`). Nothing uses them yet.
