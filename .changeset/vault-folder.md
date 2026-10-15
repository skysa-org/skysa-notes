---
'@skysa/core': minor
'@skysa/web': minor
---

Ground work for passwords in the vault. A source's `.vault/` folder, where the vault's passwords will be kept one note each, now syncs as the scratchpad's folder does, while staying out of the notebooks and out of search. Each device reads its storage once more after updating, as "Re-scan" does, so that items another device made are picked up; it re-reads nothing it already holds. `@skysa/core` adds the item format (a label in plain text, and the username, password and notes as JSON in one age block) and an unbiased password generator.
