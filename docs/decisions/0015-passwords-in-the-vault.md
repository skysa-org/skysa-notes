# 0015. Passwords in the vault

*2026-10-15. Cited in the code as §7, "Passwords in the vault". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

**A password manager, kept where the secrets are.**
The vault's second kind of item is a password: what an app, a site or a service is called, in plain text, and its username, password and notes, encrypted as a secret's words are, to the same key, and opened by the same unlock.
Nothing about the key, the unlock, the lock, replacing the key or catching up is new for it: an item is an `age` block in a note, so every step "Secrets in a note" sets out takes it as it takes a secret.
The owner asked for it on 2026-10-15, and chose the answers below.

- **Shown where it is turned on, per device and per source** (the owner's choice), as the scratchpad is: a switch, "Passwords", in the Vault dialog's step for an enrolled device, under its options (`prefs`, `passwords:<connectionId>`, `store/vault.ts`).
  Off until it is turned on, with no rule for sources to come: unlike the scratchpad, a password manager is something to choose.
  Turned off, the items stay where they are and keep syncing.
  Turned on, the row is there; the dialog is still open over it, so the place does not open by itself.
- **The row is "Passwords", under the notebooks** (the owner's choice of where, and of the name), with a key: it lists only passwords, and "Vault" is the menu item and dialog that hold both kinds.
  It sits between the tree, which scrolls, and the account's foot, so it is in sight however long the tree is, ruled off above as the scratchpad's row is ruled off below.
  In a compact window it is the notebooks dropdown's last row.
- **A file per item** (§3; the owner's choice), in `.vault/` at the root, an ordinary note as a scratch note is, for the reasons the scratchpad gave: the engine, conflict copies, the unsent count, export and import take it unchanged, and so do setup's scan, replacing the key (`resealSecrets`) and catching up, which find its block as they find any.
  One file for the whole vault would have made any two edits made offline, on two devices, a conflict of all of it.
  Nothing that lists notes lists them as notes: the sidebar's tree and a notebook's notes leave them out (`usePinnedTree`), search finds one by its label alone and only while the passwords are shown (below), and the account panel offers no "Open the note" for one whose write is stuck, which would open it in the note editor.
- **The label is plain** (the owner's choice): it is the note's `title`, and its file's name, so anyone who can read the folder reads it, as a secret's label is read.
  The field says "Not encrypted".
  The username, password and notes are one secret: a JSON object, `{"username":…,"password":…,"notes":…}`, encrypted as a secret's words are, in the one `age` fence the note's body is, with no label on the fence.
  `age -d` gives the object back.
  A key a later version writes beside them (`totp`, `urls`, …) is kept as it is when an item is edited here.
  An item this version cannot read (§3: words that are not an object, or a body that is more than its fence) is said to be one, with Delete and nothing else.
- **The place** is a notebook's shape, not the scratchpad's: the list in the notes' column and the item in the note's, and in a compact window the list as a notebook's notes are, and the item as a note is, with Back going up a step.
  `#passwords`, and `#passwords/<slug>` for an item, outside `#/…` as `#scratchpad` is.
  The title is "Passwords", or "Passwords > <label>".
  It is remembered as the last place, as the scratchpad is, and the item open in it is not.
- **The list** is the labels, A to Z as the user's language sorts them, with a field over them that narrows them as it is typed in (case and accents ignored) and `+` for a new item.
  Labels are plain, so the list needs no unlock.
- **An item** opens unlocked, asking the unlock straight away where the device is locked, as a secret's Reveal does: through the same host the editor's secrets use (`useNoteSecrets`), so the device's own lock, the unlock dialog, "Use the recovery key", "Add its key" for an item made with another key, and the warnings that open the Vault dialog are the editor's own.
  Opened, it shows the username, with Copy; the password as eight dots whatever its length, with Show and Copy; the notes as they were written; and Edit and Delete.
  Cancelled, or locked, it shows the label and Unlock.
- **Editing is kept as typed**, as a secret's panel is, and for the same reason: nothing typed is ever only in a form.
  Each change is encrypted then and there and written in one transaction with the label (`saveVaultItem`), a user edit, so the item is dirty then and only then; where a pull replaced the item since it was opened, the change is written beside it as a conflict copy, as an editor's is.
  Edit opens the form on the item as the store has it once the writes before it are made, not as the view was last given it, which can be a write behind: a form opened on that wrote the old password back with the next change to the label.
  Done closes the form.
  Cancel puts the item back as it was opened, label and armor, where it is still that item (`restoreVaultItem`): replaced by a pull since, what came stays, being newer than what Cancel would put back, and a copy the edit went into, which held nothing else, is taken away, so no row is left holding an old password.
  A label that changed renames the file once, on Done, rather than at every character, and only while the item is the one the edit was made over (`renameVaultItem`), so a label pulled since is not written over; left with the form open (Back, another item, the passwords hidden), it is renamed as Done would have.
  An item looked at and not changed keeps its armor byte for byte, so looking at it does not sync it.
  Locking closes the form, with everything typed in the file already, and lets go of the words.
- **A new item** needs the device enrolled, not unlocked, as a new secret does.
  It is a draft until its first change, then a note, `untitled.md` until Done names it.
  Cancel, or Done with nothing in it, deletes it quietly.
  Where the device cannot store it, what was typed is in the form and nowhere else, so the form says so and stays open, through Done and the lock alike, until Done stores it; a failed store is asked again, not answered with the first refusal (`useDrafts`).
- **Delete** is a note's: taken away at once, with Undo for ten seconds.
- **Copy** puts a field on the system clipboard and nowhere else, and does not clear it later: the owner's choice for secrets (§7, "Secrets in a note"), carried over.
- **The fields keep the browser out**: spell check, autocomplete, autocorrect, autocapitalize and writing suggestions off, and the marks the common password managers read, as a secret's panel has them.
  The password is a text field drawn as dots (`-webkit-text-security`, in Chrome, Safari and Firefox from 114), not a password field: a browser offers to save what is typed into one of those when it goes, and `autocomplete="off"` does not stop it.
  The cost is that a screen reader reads it out as it reads any text field, as it does the password shown.

**Three more, the owner's asks:**
- *Search finds an item by its label*, only while Passwords is shown for its source (`searchable`, as the scratchpad's notes are found only while it is shown), and says it is in "Passwords"; choosing it opens the item in the passwords.
  Of an item, only the label is indexed: its body is one unlabelled `age` fence, which `withoutArmor` makes nothing.
  A body this version cannot read as an item (§3) is indexed as a note's is, armor left out, which finds only what is plain in the file.
- *A password can be made* in Edit: Generate, under the password, fills it with a new one and shows it, kept as typed as any change is, and says so.
  Twenty characters unless a length from 8 to 64 is set (a box left empty, or holding no number, leaves the length as it was; Enter in it keeps the length rather than closing the form), of upper- and lower-case letters, digits and, unless turned off, symbols, at least one of each; the choices are remembered on the device, for every source (`prefs`, `passwordGenerator`).
  The characters are picked by `crypto.getRandomValues` with rejection sampling (`generatePassword`, `core`), so no character is likelier than another, which taking a random number modulo the alphabet's size would make some.
- *A label that is a web address opens* (and an item's Site, in its place, once the item is opened: §7, "Filling in on a site"): an `http://` or `https://` address, or a bare host such as `github.com` (no spaces, a dot, and a last part that is a country's two letters, as IANA lists them, or a generic one in common use: `.com`, `.org`, `.net`, `.app`, `.dev` and a few more), which opens as `https://`.
  Any last part of letters would have made "Node.js", "John.Smith" and "config.yaml" links; every top level there is would have added more than a thousand, `.family` among them.
  The item shows its address under its label, with Open, as a link's chip does (`labelLink`, over `openableLink` and `openLink`).
  Nothing else becomes a link: "Mr. Smith", "Mr.Smith", "v1.2" and "My bank" stay words, and so do a router's `192.168.1.1` and `localhost:8080`, which are not hosts by this rule.

**A version from before** takes `.vault/` for hidden, as every version took `.scratchpad/` before the scratchpad: it neither pulls an item nor deletes one, so a device not yet updated leaves the items alone.
Nor does it encrypt them afresh when it replaces the key: a device that has updated, and holds the key it replaced, catches them up, as it does any secret made with an old key.
A device that updates after items were made would have passed over them with the cursor it moved on, so schema version 12 drops every source's cursor once, as version 10 did (§3).

**Not built, and why:**
- *Filling in a site's form* by an extension or the browser's autofill: the app is a page, and a page cannot reach another's form.
  A bookmarklet runs in the site's page and can, so that is how it is done (2026-10-16, §7, "Filling in on a site").
- *Clearing the clipboard*: the owner's choice for secrets (§7, "Secrets in a note").
- *One-time codes, more than one address, files on an item*: the object keeps what a later version adds, so there is room for them.
- *Passwords in the device's own notes*: there is no folder to keep the key's public half in, as for secrets.
- *A number in a later version's fields* (§3): the object is read and written as `JSON` reads it.
- *A site's icon beside its label*: fetching it would tell a third party every label.
- *Previous passwords from an edit in Passwords*: only an Update from the fill window keeps the password it replaces.
  An edit in the app is the user changing it on purpose, and keeping every password ever typed into the field would keep each half-typed one.
