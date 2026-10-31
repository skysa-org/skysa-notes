# 0014. The vault

*2026-10-15. Cited in the code as §7, "The vault". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

**What the app calls the place a source keeps what only its devices can read.**
A source's vault is its key (the recovery key), the public half of it in the folder, and how each device unlocks it, all as §7, "Secrets in a note", sets them out; the owner named it on 2026-10-15, as it is to hold a second kind of item, passwords, beside the secrets (§7, "Passwords in the vault").
The menu item that opens it, on the gear and the source's `⋯`, says "Vault", or "Set up vault" until the source has one (`secretsLabel`; both ended in an ellipsis until 2026-10-16, against §7, "No menu item ends in an ellipsis"), and its dialog is "Vault".
Setting it up, unlocking it, the recovery key's printed page ("Vault recovery key for {source}") and the passkey a device's own lock answers through ("Unlocks the vault on this device: {source}"; one made before keeps the name it was made with) all say the vault.
A secret in a note is still a secret: "Secret" on its block, "Insert secret", "Delete secret".
The code keeps the names it had (`SecretsDialog`, `secretsLabel`, `store/secretKeys.ts`, `secrets/`), since renaming them would move every line that names them and change nothing anyone sees.
