# 0013. Secrets in a note

*2026-10-14. Cited in the code as §7, "Secrets in a note". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

**Words the folder holds only encrypted.**
A source can be set up for secrets, by setting up its vault (above).
A secret is a block in a note whose words are encrypted on the device before they are written anywhere, so the store, the provider and anyone who can read the folder hold only ciphertext, and showing them takes the device unlocked.
The owner asked for it, and chose the answers below on 2026-10-14.
It is built in six steps: the format in `core` (#378), setting up a source (#379), unlocking and locking a device (#380), secret blocks in the editors (#381), the device's own lock (#382), and other keys and replacing the key (#383).
All six are built.

**The format is age's, so it does not depend on this app** (§3).
A secret is an armored [age](https://age-encryption.org/v1) file in a fence whose info string is `age`: X25519 for the key, ChaCha20-Poly1305 for the words and HKDF-SHA-256 between them, all named in the file's own header.
With the recovery key, `age -d -i key.txt` decrypts it, as does any other age implementation, with the app gone, and a block another age tool wrote is one the app reads.
The words inside are plain UTF-8 text, not markdown.
- *Primitives* come from `@noble/curves`, `@noble/ciphers` and `@noble/hashes` (HKDF, HMAC): MIT, audited, and pure JavaScript, so no WebAssembly and nothing for the CSP (§9).
  `@noble/hashes` is the curve's own dependency, so it adds no code that was not already there.
  Sealing and opening wait on nothing, which is the reason for it: an editor encrypts a secret's words into the note as they are typed, in the same moment (below).
  WebCrypto's HKDF and HMAC only answer later, and would leave a moment in which typed words were in a panel and not in the note.
- *The format itself is written here* (`packages/core/src/age/`), as storage OAuth is. age's own TypeScript implementation, typage, is BSD-3-Clause, which is not on the license list.
  It is held to the C2SP test vectors for age (CCTV).

**One key per source, and it is the recovery key.**
"Set up vault" (on the gear and the source's `⋯`; "Set up secrets…" until 2026-10-15) makes an age identity: 32 random bytes, written `AGE-SECRET-KEY-1…` in bech32.
Bech32 ignores case, leaves out characters that look alike, and carries a checksum that catches a mistyped one.
Or setup takes a key the user pastes, for notes that already hold blocks made with it.
- *A new key is shown once*, in groups of five, with Print and Copy.
  Print is a print stylesheet over the dialog, so the key never becomes a file or a URL of the app's.
  While the key is shown, the page is titled after it ("Vault recovery key for {source}"), set again as a print begins and given back as the step goes, so a PDF saved from the print, by Print or the browser's own, is named for the key rather than for the note open behind the dialog (the owner, 2026-10-15).
  The key keeps 2 cm from the paper's edge, inside a page with no margin of its own (`@page recovery-key`), so neither a browser's default margin, about a centimetre, nor a print dialog set to none puts it near the edge; until 2026-10-15 the page's own margin was the 2 cm, and a print with margins set to none started the key at the paper's left edge.
  Copy puts the key on the clipboard in its groups, as it is shown (`AGE-SECRET-KEY-1 ABCDE …`), and the app reads it back as it is. age itself wants the spaces taken out.
  Both changed on 2026-10-15, at the owner's ask: copied whole, the key was one run of 58 characters to check by eye.
  Setup does not finish until two groups, chosen at random, have been typed back, into two cells drawn as the whole key's are where it is typed: numbered, side by side, and going on from the first to the second as it fills.
- *A key is typed in its groups* (`PasteKey`, 2026-10-15, the owner's ask).
  There are twelve fields, one for each group, numbered as the key is shown and printed.
  A field that fills goes on to the next, and Backspace in an empty one goes back.
  A key pasted whole fills them all, wherever it is pasted, with its prefix or without it.
  The prefix ends in `1`, which no group holds, so it is never taken for a group; typed out a character at a time, it starts the fields again.
  Each field is its own: emptying one leaves the others as they were.
- *And as a QR code* (`components/secrets/RecoveryQr.tsx`, 2026-10-15, the owner's ask), under the groups on screen and beside them on the printed page, so a device being set up can read the key with its camera rather than have it typed: from the paper, or from the screen of a device that has just made it.
  It holds the key as age writes it, `AGE-SECRET-KEY-1…` with no spaces, and nothing else.
  It is no address, so a phone that reads it with its own camera app shows the key and sends it nowhere.
  It is drawn dark on white whatever the theme, with the four modules of white around it that a reader looks for, and medium error correction, so a crease still reads.
  It is drawn by `uqr` (MIT, no dependencies, about 4.5 KB gzipped), which is in the main chunk with the dialog, so the code is there before Print is pressed.
- *Scan QR code* (`components/secrets/ScanKey.tsx`) is beside Continue wherever a key is typed (`PasteKey`), where the page can ask for a camera.
  The camera is the one facing away, and it is asked for only when the button is pressed.
  Its frames are read on the device and go nowhere: one every 150 ms, drawn no wider than 640 px, and read by jsQR (Apache-2.0). jsQR is loaded only as a scan begins (about 47 KB gzipped), and the service worker precaches it with the rest.
  A code that spells a key fills the groups as a paste does, and the focus goes on to Continue, which checks it as it checks a typed key.
  A code that does not is said, and the scan goes on.
  The camera is let go of as soon as a key is read, and on Cancel scanning, on Escape (which the scan takes before the dialog does), and as the step goes.
  A refused camera, or none, is said, and the key is typed instead.
  - Not the browser's own `BarcodeDetector`, which only some platforms have, and every device works the same way here.
  - Not a WebAssembly reader either, which would need `'wasm-unsafe-eval'` in `script-src` (§9). jsQR and uqr are plain JavaScript, with no `eval`.
  - A stream given to a `<video>` is not a fetch, so the CSP is unchanged.
    No `Permissions-Policy` limits the camera.
- *Three groups to a row* where four would run past the edge of a phone's dialog and be missed as the key is written down (a container query on `.recovery-key`, 2026-10-15).
- *It is never stored*: not in the folder, not on the server, and not on a device as it is.
  If it is lost, and every device's unlock is forgotten or gone, the secrets are gone.
  The dialog says so before the key is made.
- *The curve is loaded when it is first needed* (`secrets/loadAge.ts`): making or checking a key, unlocking, opening or sealing.
  The rest of the app reads secret blocks and the key file without it, so a device that never uses secrets never parses or runs it; the service worker still precaches its chunk with the rest of the build.
  That holds only while what the main chunk uses is in modules with no curve in them, which is why `core` keeps the key's text forms (`age/keys.ts`) apart from the curve (`age/curve.ts`), and a secret block's format (`core`'s `markdown/secretBlocks.ts`) apart from sealing and opening one (`core`'s `secrets/sealing.ts`).
  Rollup splits by module, so one curve import in a module the main chunk reaches brings all of it back.
- *The dialog* (`components/secrets/SecretsDialog.tsx`) starts where the key file and the device's keys say it is: not set up, set up and this device not enrolled, enrolled with a key since replaced, or enrolled.
  It reads the key file again as it opens.
  A step that fails says so and can be taken again; a key file written on a try that failed after it counts as written on the next.
- *Keys a device holds are not put aside by setup.*
  A device enrolled in a source whose folder names no key (the file deleted, or never synced back) offers to put the file back, naming the key it holds, rather than to set up anew, which would leave whatever that key opens locked.
  A device whose source key was replaced elsewhere keeps the keys it held beside the new one, under the unlock it has, and is unlocked first to do it; keeping only the new key is the user's to choose.
  A setup write refused because another device wrote first goes back to where the dialog starts, decided by what the folder now says, so a typed key is always checked against a key file that names one.
- *The dialog's own copies of a key* (one it made, or read from what was typed) are filled with zeros once the device keeps them, and as it closes.
  What it takes from the lock is copied by the store before anything is awaited, since the lock wipes its own keys in place as the page hides.

**What the folder holds is the public half** (`.encryption.json` at the root, §3): the recipient (`age1…`) every new secret in the source is encrypted to.
A typed recovery key is checked against it at once, since its public half must be the one written there, and it is how a device learns that the key was replaced.
It is hidden, so the engine passes over it.
A device reads it when a session starts, and again when a pull meets it, as the clipboard's folder is (`SyncOutcome.encryption`, `sync/keyFile.ts`, kept in `keyFiles`).
A device whose last read found none, and which holds no key for the source, does not ask at a session start, so a device that never uses secrets asks nothing of the folder for them: the pull that meets the file is how it hears that another device set the source up.
A read that pull asks for, so, never leaves none behind: a listing can trail the feed that reported a new file, and a none kept then, or kept from before a read that fails or never comes, would leave the device thinking so for good.
It leaves the file unread instead, and the next session start reads it.
A file a newer build wrote is read by its version alone, whatever else it says, and is neither encrypted to nor written over.
Setup writes it only if no other device has: a source that is already set up asks for its recovery key instead.

**A key that does not open what is already there is said before it is used** (the owner's ask).
Setup tries the key on every `age` block in the source's notes.
If any do not open, the dialog says how many secrets, in how many notes, were made with a different key, and offers "Use that key instead", "Add it as well", and "Continue", which leaves those secrets locked.
Replacing the key says the same of the secrets that neither the new key nor the old ones open, which stay as they are (below).
On an unlocked device, a block that no key on the device opens says it was made with a different key and offers "Add its key", rather than saying the unlock was wrong.

**Unlocking belongs to the device, and never leaves it** (the owner's choice).
A device is enrolled once, with the recovery key, and the user then picks how this device unlocks:
- a pattern of at least four dots on a 3×3 grid;
- a PIN of at least four digits;
- a password of at least eight characters;
- or the device's own lock, where it has one (below).

The identity is wrapped under that unlock and kept in IndexedDB (`secretKeys`, by source, `store/secretKeys.ts`), with the recipient the device enrolled with.
A device's keys stay while the source's notes do, a detached source's included, and go home with them when the account is connected again.
Nothing about the unlock is written to the folder, and that is the reason for the design.
A wrapped copy in the folder could be tried offline by anyone who can read it, the provider included, with nothing counting the tries.
A pattern is one of 389,112 and a four-digit PIN one of 10,000, and no key stretching makes either last against that.
On the device, a pattern stops someone holding the phone, and a password holds up against a copy of the disk.
- *Wrapping.*
  Pattern, PIN and password wrap the key with AES-GCM under PBKDF2-SHA-256 (600,000 rounds, a salt per device), both from WebCrypto.
  Argon2 would be better, but it needs WebAssembly, or a JavaScript port too slow to help, and `script-src` takes nothing for it.
- *Wrong tries.*
  After 5 wrong tries, each further try waits 30 s.
  After 10, the device's copy is deleted and the recovery key is asked for.
  Each try is counted before it is checked, so tries made at once are all counted, and a right one sets the count back.
  A try of another kind than the device's is not counted: it comes from a form shown before the unlock was changed in another tab, and which kind a device unlocks with is no secret.
  That form gives way to the one for the new unlock, which says the unlock was just changed.
- *The unlock's field* asks the browser to keep nothing (`autocomplete="off"`, and the marks the common password managers read).
  Most browsers offer to save a password field anyway, and that is the user's to refuse.
  Saved, it unlocks nothing elsewhere: what it unwraps is in this device's storage alone.
- *Changing how a device unlocks* takes the device unlocked by its current unlock, and wraps the key again under the new one.
  It does not ask for the recovery key (the owner's choice): an unlocked device already holds the key, so asking for it again would protect nothing.
  A device whose unlock has been forgotten is enrolled again with the recovery key.

**The device's own lock, where there is one** (the owner's choice, 2026-10-14).
This is the one thing in the app offered on some devices and not others.
It uses WebAuthn's PRF extension: a passkey made on this device (`authenticatorAttachment: 'platform'`, `userVerification: 'required'`) returns the same 32 bytes for the same salt, but only after the device's own check, and those bytes, through HKDF-SHA-256 (WebCrypto), become the AES-GCM key that wraps the identity (`secrets/deviceLock.ts`).
- *A key, not a sign-in.*
  The passkey is made and used in the browser alone, with no attestation, and nothing it signs is checked: what it answers opens the keys or does not.
  It is never registered with the API, which never sees it (§6, "No sign-in separate from storage").
  It shows in the user's password manager under the brand's name (§8), as unlocking the vault on this device in the source it was made for ("Unlocks the vault on this device: {source}"; one made before 2026-10-15 keeps "Unlocks secrets on this device: …").
  The platform may sync it to the user's other devices; it opens nothing there, since what it wraps is in this device's storage alone.
- *The browser chooses the check* — fingerprint, face or the device PIN — so the option is labelled "this device's lock".
- *Offered* where the browser has a lock of the device's own (`userVerifyingPlatformAuthenticator` from `PublicKeyCredential.getClientCapabilities()`, or `isUserVerifyingPlatformAuthenticatorAvailable()` where it cannot report capabilities) and does not say it cannot answer a salt (`extension:prf` false).
  Where it says nothing of a salt, as Safari, which reports only what its platform tells it, may not, making the passkey settles it.
  One made that cannot is not offered again in that dialog, and the user chooses another way.
- *Setup proves the same bytes come back*: what the passkey answered as it was made and what it answers once after, or, where making it answered nothing, two answers after.
  They must agree before anything is wrapped under them, so a passkey that would answer otherwise never holds the keys.
  Nothing is written to the folder until it has, so a source set up this way writes its key file only once the device has answered.
- *What is kept* beside the wrapped key is the passkey's id and the salt (`secretKeys`, with no rounds).
  The answer itself is filled with zeros once the keys are wrapped or opened, and the browser's own copy of it as soon as it is copied.
- *A passkey the app stops using is let go of*: one made by a setup that did not finish, one a new passkey or another unlock replaces, and one whose keys are removed from the device.
  It is said to be unknown (`PublicKeyCredential.signalUnknownCredential`), where the browser lets that be said, so the password manager can take it out; one left listed would look like one that still unlocks.
  Where the browser cannot, it stays listed and opens nothing.
- *No tries are counted.*
  The hardware counts its own, and locks itself out, so the app's wrong-try count and its 30 s waits are for the entered unlocks.
  The device is asked as soon as unlocking is: a secret opened while the device is locked asks it with nothing drawn, and the Unlock dialog is drawn only where it says anything but yes (`Dialog`'s `hidden`), and the Vault dialog's Unlock asks it without a step of its own to press (the owner, 2026-10-15: Unlock pressed only to be asked was a tap for nothing).
  Until then it was asked only when Unlock was pressed, never as a dialog opened.
  Asking without a press is allowed wherever the app runs: Safari asked for a user gesture until 17.4, which rate-limits instead (https://corbado.com/blog/safari-webauthn-user-activated-events), and a browser that still refuses is a lock that did not answer.
  It is asked as a prompt of the app's own, so the page hidden behind it does not lock (below).
  Since it does not, the browser is given 60 s to ask, not its own few minutes.
  A passkey that does not answer says so, with Try again as the answer, Cancel beside it, and the recovery key on a line of its own above them.
- *Where that is* (2026): Android in Chrome, Edge and Samsung Internet; Safari on iOS and macOS 18 and later; Windows Hello since Windows 11's February 2026 update, in Chrome and Edge 147 and later and Firefox 148 and later.
  It is not offered on Linux, Windows 10, older phones, or with a security key on an iPhone.
- *Never data loss.*
  A deleted passkey, or a platform that later answers differently, costs the recovery key, never the secrets, since the passkey only ever wraps one device's copy.
  An answer that no longer opens it, or a passkey that answers nothing for the salt now, says the device's lock no longer opens the key, and asks for the recovery key, as a forgotten unlock does.

**Locked, a secret is a closed block.
Revealed, its words are outside the note.**
The rich editor draws an `age` fence whose text reads as an armored age file as a secret (`editor/features/secrets/secretBlock.ts`).
It is one unit, selected, moved and deleted whole and never typed into, showing its label, or "Secret" where it has none, and Reveal.
Selected whole, it has a bar at the end of its first line with Delete secret, as a picture has Remove from note, for a phone's keyboard that may delete nothing; the formatting bar a selection floats (`InlineToolbar`) does not come up over it, since it holds no text to format (2026-10-15, the owner's ask).
A fence that says `age` and holds anything else is an ordinary code block.
Reveal unlocks the device if it is locked, then opens a panel under the block, with the words in a plain-text editor of its own.
- **The words never enter the ProseMirror document.**
  Autosave writes that document to the store within 2 s, a failed save is held and retried, and undo keeps every state it passed through, so a decrypted word in the document would be on the device's disk within seconds.
  The document holds only ciphertext.
- **A label (2026-10-15, the owner's ask).**
  A secret may be called something: the panel has a Label field over its words, and what is typed there is what the closed block says in place of "Secret", in either editor, on a card and in a card's name.
  It is plain text on the fence's opening line (§3), and the field says so ("Not encrypted"), since anyone who can read the folder reads it.
  It is kept as it is typed, as the words are, but by changing only the label (`relabel`): nothing is sealed for it, so its block's armor, and the panel held under it, stay as they are, and sealing the words again keeps it.
  A new secret's label goes in with its first words.
  Cancel puts it back as it was revealed.
  What is written is one line, with no backtick, which would end the fence's info string, and no more than 80 characters (`labelToWrite`); the field shows it as typed.
  Changed in the note — undone, or typed in raw mode's text — while its panel is open, the field follows unless it is being typed in.
- *Kept as it is typed*: each change in the panel is encrypted, then and there, and the new ciphertext put in the block's place in one transaction.
  That is a user edit, so the note becomes dirty then and only then, and is saved, undone and synced as anything typed in it is.
  A character an input method is still composing is kept as it ends, or as the editor goes or the tab locks where that comes first (`keepSecrets`, called from either editor before it is taken away; the rich editor did not until 2026-10-21, and lost such a character to the note closing).
  So nothing typed is ever in a panel and not in the note: closing the note, switching mode, the tab locking, and a pull all find the words in the document already.
  An earlier design kept them as the focus left the panel and on Done, and lost them to the note closing first, since encrypting waited on WebCrypto.
  *Done* closes the panel; a new secret emptied before it is taken out.
  *Cancel* closes the panel and puts the block back as it was revealed (a new secret's block, taken out).
  Where words cannot be encrypted, the panel says so and stays open until they are.
- *A block that goes from under its panel* closes its panel, however it went.
  Deleted by the user, the words go as anything deleted does, into the undo history.
  Replaced by a pull, they were in the note before it: an edit not yet saved is written beside the replacement as a conflict copy (`saveNoteBody`), as any typed into a replaced body is.
- *Pasted, it is a secret still.*
  The secret's own reading of a `pre` comes before the code block's, so a secret copied, cut or dragged within the editor stays one, and a fence pasted as markdown text, which Milkdown draws and reads back, becomes one.
- *Reveal and hide dispatch nothing*, and an unchanged secret keeps its ciphertext byte for byte.
  Encrypting it again would change the file, and sync it, every time the secret was looked at.
- *The raw editor* shows the armor as written (`editor/features/secrets/secretRaw.ts`), with Reveal at the end of the fence's opening line (or Alt+Enter inside the fence) opening the same panel under its closing line, kept, closed and put back by the same steps (`editor/features/secrets/secretPanels.ts`).
  Keeping rewrites the armor's lines, inside whatever list or quote holds the fence.
  A fence is a secret where the markdown parser finds one and what it holds, with the list's or quote's marks taken off, reads as armor, as remark reads it for the rich editor.
  A new secret goes where rich mode puts one: after the block the cursor is in (a paragraph, a heading, a fence), inside the list item or quote that holds it, with a blank line either side, or in place of the empty line the cursor is on.
  It never splits a paragraph, a heading or a table.
  A block that runs open to the end of the note, as a fence or a comment left unclosed does, has it before it instead, and before it goes in, the note is parsed with it there, to be sure it is a secret where it lands (`placeFor`).
  Cancel, or Done after emptying it, takes out exactly what went in.
  Keeping is typing (`input.type`), so the history joins the words typed in a panel as it joins words typed in the note; the new fence they first write is a step of its own, apart from what was typed in the note just before.
  The panel is drawn as one widget for as long as it is open, so the armor changing above it as words are typed never draws it again or takes the focus from it, and keys pressed in it never reach the note.
  A body adopted from outside (a pull, the other mode) is put in as the one change between where it first and last differs (`changeBetween`, `RawEditor.tsx`), so a pull elsewhere in the note leaves an open panel, and the cursor, where they were.
  A word an input method is still composing in a panel is kept as the editor goes, before the note's autosave flushes.

**Inserting a secret** ("Secret" in the slash menu, "Insert secret" in the palette of either editor, and the lock on the rich editor's toolbar, in its Insert group after the paperclip) needs the device enrolled, not unlocked, since encrypting needs only the recipient (the owner's choice).
It opens the same panel empty, and Done with nothing in the panel inserts nothing.
The recipient used is the one the device enrolled with.
If the last `.encryption.json` read names another, the key was replaced on another device, and this device asks for the new recovery key before it begins a secret.
Words already revealed when that is learned are still kept, encrypted to the key the device has, rather than lost; it opens them, and replacing the key catches them up (below).
Where the source is not set up, the device not enrolled, or the folder no longer names the key, the editor says so with a button that opens the source's Vault dialog over the note, which is where each is put right (`components/secrets/noteSecrets.tsx`).
Until 2026-10-15 it said where in the source's menu to find the dialog; the owner asked for the way there instead.
Use the recovery key, in an unlock asked for over the note where the device's keys have gone, opens it the same way.
Where a newer app set the source up, or its key file is not one the app wrote, the editor says that, with nothing to open.
The lock on the toolbar came after 1.4.0 (2026-10-15, the owner's ask).
The slash menu and the palette are found only by someone who already knows what to type, so nothing on the screen said a note could hold a secret.
On a narrow bar the lock goes into More tools before the link does.

**Copy** puts a revealed secret's words on the system clipboard (`navigator.clipboard.writeText`) and nowhere else, never on the source's shared clipboard ("The clipboard", above).
What happens to them there is the user's business (the owner's choice): the app does not clear them later, and does not refuse them if they are pasted into the shared clipboard.

**Locking** (the owner's choice) happens when the page is hidden, and after 30 s with no key, pointer, touch or scroll in it.
- *What it lets go.*
  The identity's bytes are filled with zeros and let go.
  A typed array can be wiped and a string cannot, which is why the words in a panel are only ever let go of.
- *No edit is lost.*
  Every revealed panel closes at once, and what was typed in it is in the note already; a character still being composed is encrypted first, which needs no secret.
- *Nothing opened as it locks is shown.*
  A secret whose opening ends after the tab has locked stays closed.
  The keys it was opened with were copies, so the lock wiping its own meanwhile never makes it look made with another key.
- *The app's own prompts don't count.*
  A page hidden behind a prompt the app opened itself, such as the device's lock or Print, does not lock.
- *Unlocked while hidden* is locked at once.
  The derivation an unlock waits on takes a second or more on a phone, long enough to switch away during it, and no `visibilitychange` is coming after.
- *Each tab* locks and unlocks for itself (`secrets/lock.ts`).

**Where else the words could have gone, and why they do not.**
- *Search, the note list and cards.*
  `previewBlocks` (`core`) makes a secret a single line with no words and only a secret's mark, nothing of its ciphertext.
  So is an `age` fence that opens as armor and is cut short, as a list row's opening is cut at a length.
  The note list's openings, search's excerpts and the scratchpad's cards read from it, so none of them shows the words or a run of base64.
  The search index itself is not built from it but from the note's text with each secret in it as its label alone (`withoutArmor`, `core`; `store/search.ts`), so a note is found by a secret's label and not by its armor: not by a run of its base64, which a short query could match by chance, nor by the `age` its fence opens with (2026-10-15, the owner's ask; until then the index held the text as written, base64 and all).
  An `age` fence that opens as armor and does not read is taken out too, as a preview takes it.
  A note with no armor in it is indexed as written, without being read as markdown, which for every note would be most of what indexing costs.
  A secret's words were never in the index, being ciphertext there.
  A card draws the mark as a chip (`CardEmbed`) that says the secret's label, or "Secret" in the reader's language where it has none, and a card with no name that opens with a secret is called the same.
  A scratch note that holds only a secret, or only a picture, is something to keep: the box deletes a note it took only when nothing in it shows.
- *Find* passes over a secret, as it does over a chip's name.
  In the raw editor the armor is text, so find leaves out any match in a secret's fence, its `age` included (`editor/features/find/findRaw.ts`): a short search would otherwise find runs of base64 by chance, and a replace there would leave a secret no key opens.
  The fences are the ones the parser finds, as Reveal's are, so a note that only writes about armor is searched as it is.
- *The browser's helpers.*
  The panel's editor has `spellcheck`, `autocomplete`, `autocorrect`, `autocapitalize` and `writingsuggestions` turned off, since Chrome's enhanced spell check sends text to Google.
- *Dragging out of the panel* is refused: the words dropped in the note would be in it as they are.
- *Copying from the note.*
  A selection that includes a secret copies its fence, ciphertext and all, which is what the file holds.
- *Logs and errors* never carry the words.

**Replacing the key** ("Replace this source’s key", in the Vault dialog of an enrolled device, which is unlocked first where it is locked).
A new key is made, shown and checked as at setup, or one the user has is pasted; the source's key now is refused.
Before anything changes, the dialog says how many secrets will be encrypted to the new key, and how many were made with a key that is not the source's, which the new key will not open and which stay as they are.
It says too that copies kept from before, such as the provider's version history, still open with the old key: replacing a key that leaked protects what is written from then on, not what was.
Then, in this order:
- *The key file first*, written over the recipient the device has (`KeyFileSync.write`, `over`).
  A replacement made on another device meanwhile refuses this one before anything else changes, and the dialog then asks for that device's key.
  The plan was to write it last; it is written first because from that moment new secrets everywhere are made with the new key, and everything after it here is catching up, which a later unlock takes up again where it stops short (below).
  Written last, two devices replacing at once would each encrypt every secret to a key of its own, and the one that wrote second would leave the other's secrets made with a key the folder no longer names.
- *The device's keys*: the new one first and the ones it held kept beside it, under the unlock it has (`replaceKeys`).
  The recipient replaced is remembered (`SecretKeyRecord.former`), as it is where the key was replaced on another device and typed here.
- *Every secret one of the old keys opens*, encrypted afresh to the new key (`resealSecrets`, `secrets/age.ts`).
  Its bytes, whatever they are, are opened and sealed again and filled with zeros (`resealSecret`, `core`), and its armor is rewritten in place, inside whatever list or quote holds it (`rewriteSecrets`, `core`); a fence whose lines are not its armor under those marks, which only one written by hand could be, is left.
  A secret no old key opens, one made with a key added from another source among them, is left as it is.
  Each note is read and written in a transaction of its own (`rewriteNoteBody`), so one edited meanwhile is encrypted as it is then, and written as a user edit: dirty, and pushed as any edit is.
  It is written in from outside the editors, as a pull's body is, under a new `bodyOrigin`, so an editor open on the note shows the new armor, and an edit typed there just before is kept beside it rather than written over it (`saveNoteBody`).
- *It stops between notes where the device locks.*
  What is left still opens on this device, which keeps the old key, and is encrypted afresh the next time it unlocks.
  The dialog says how many secrets it encrypted, or that some are left.

*Other devices* learn that the key was replaced from the key file, as they learn that the source was set up (above).
Each keeps the keys it holds, and does not lock.
The plan was to lock it, but locking would protect nothing: the keys it holds are the ones it would hold after, and it would ask for the unlock again only to ask for the new key next.
A secret made with the new key says it was made with a different key, and "Add its key" says the source's key was replaced and asks for the new recovery key, or the key that secret was made with.
A key whose recipient is the one the folder names is kept as the source's, first, with the keys the device held beside it, and the key it replaces is remembered (`former`), as the Vault dialog does.
A new secret waits for it too ("Inserting a secret", above).

*Catching up* (`secrets/catchUp.ts`, started with the app).
A device that holds a key the source had before (`former`) encrypts afresh, to the key it has, what that key still opens (`resealSecrets`).
That covers what a replacement left when it stopped short, and what another device made with the old key, offline, while the key was being replaced.
It runs once a tab for each source and the keys it had before, as the source is unlocked, with three conditions:
- The folder names the key the device has: encrypting to a key that was itself replaced would only make more to catch up.
- The source's sync has reached the end of a pull.
  A note read before a pull brings another device's work would be encrypted again beside it, and the two would meet as a conflict.
  The window is narrowed, not closed: a pull still to come can bring a note another device encrypted meanwhile, and the two are then kept as a conflict copy, as any two edits are.
- A note a pull changes while it runs is read again as it is written (`rewriteNoteBody`), so nothing is written over.

It stops where the device locks and goes on at the next unlock.
A device that holds no earlier key never loads the age code for it.

**Notes from another source.**
A note moved or imported into a source keeps its blocks as they are.
Blocks made with another key open once that key is added ("Add its key"), which keeps it on this device beside the source's own key.
The button is beside "made with a different key" on the block, in either editor.
It unlocks the device first where it is locked, then asks for the key over the note (`components/secrets/AddKeyDialog.tsx`), with the same field the Vault dialog asks for a recovery key with (`PasteKey`).
A key that does not open that block is turned away as it is typed.
One that does is sealed with the keys the device holds, under the unlock it has, after them (`replaceKeys`, the recipient unchanged), and the block is revealed.
Where another window sealed the keys again meanwhile, nothing is kept and the device locks, as a changed unlock does.
A key added this way belongs to the device, so other devices ask for it when they meet such a block. age's stanzas do not say which key they were made for, so the app tries each key the device holds, which is cheap.
A device's keys for a source are deleted when that source's notes leave the device.

**Not built, and why:**
- *An unlock shared through the folder*, for one pattern on every device: it could be brute-forced offline, as said above.
- *A PIN whose tries the server counts* (an OPRF, as Signal's PIN works).
  It would make a short PIN safe in the folder, but it would put the server in every unlock, rule out unlocking offline, and have `apps/api` hold more than tokens and connection metadata (§1).
- *Secrets in the device's own notes*: there is no folder to keep the recipient in.
  Their blocks open once the notes move into a source set up with the same key.
- *Encrypted files beside a note*, and *a secret inside a sentence*: only whole blocks, for now.
- *Clearing the clipboard*: the owner's choice, above.
