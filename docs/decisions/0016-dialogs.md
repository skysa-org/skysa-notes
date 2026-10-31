# 0016. Dialogs

*2026-10-15. Cited in the code as §7, "Dialogs". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

**Every dialog is built one way** (`components/ui/Dialog.tsx`), by the owner's rules of 2026-10-15, asked for after the vault's dialogs, the unlock dialog and the secret panel in a note each placed their buttons their own way, and redrawn the same day after the owner tried them (the ✕, a press outside, the answer alone on the right, and a dialog that fits above a phone's keyboard):

- **One row of buttons, at the end** (`DialogActions`): the answer on the right, and everything else on the left — Cancel first, while something is asked, then whatever else can be done.
  On a line of its own, where the row wraps, the answer is still on the right.
  One answer at most, drawn filled (`primary`), or as what it is where it deletes or disconnects (`danger`).
  Until the redraw the whole row sat on the right, the way out first; before that the app had the answer first.
- **The row is for the answer; the rest is in the dialog's middle** (2026-10-15, the owner's ask for the Vault dialog, carried through the rest).
  Where a step goes on to another way of doing what it does, or to something else that can be done from it, that is a list in the step, a row each with a chevron (`.dialog-options`): the device's step in the Vault dialog has *Change how this device unlocks* and *Replace this source's key* there, and the step that finds secrets made with another key has *Use that key instead* and *Add it as well*.
  What is done with what a step shows or asks for is beside it (`.dialog-tools`): Print and Copy under a new key, Scan QR code under the key's groups.
  The row keeps to the way out, what leaves the step another way (Back, Lock now, Remove from this device) and the answer.
  Before, all of it was in the row, which on a phone ran to three lines.
- **A ✕ in the corner, and a press outside** (`Dialog`): a dialog with a way out has a ✕ beside its title, and a press on the page around it — begun there and let go there, so a drag across a field's text that ends outside is not one — is its way out too, as Escape is.
  Once nothing is asked, the ✕ is the only one: the row has no Close, and a dialog with nothing else to put in its row has no row.
  While something is under way that the way out would not stop, the three wait.
  A dialog that has to be answered has none of them.
  The Vault dialog had only Close until the owner found a press outside did nothing.
- **It fits in the window, and above a phone's keyboard.**
  As wide as the window allows, up to 28rem, whatever it holds — a short question as wide as a long one, so a phone's buttons have the window's width; and never taller than what can be seen.
  Its title and its row stay where they are and what is between them scrolls, with a line under the title and over the row only while there is more out of sight that way (`data-scrolled`, `data-more`).
  What can be seen is the visual viewport: where a phone's keyboard covers the bottom of the window rather than shortening it, as an iPhone's does, the backdrop is held to what the keyboard leaves (`--viewport-top`, `--viewport-height`); on Android the window itself gets shorter (`interactive-widget=resizes-content`).
  Either way, the field being typed in is scrolled back into sight above the row, a frame after the window got shorter (`revealField`), and a field the focus moves to is scrolled clear of the row (`scroll-padding`, the row's height).
- **The focus starts on the first field, else the answer.**
  A field is whatever is typed or drawn in, a pattern's grid included (`data-dialog-field`); with none, the answer; with no answer, the way out — the ✕.
  So Enter on a question that deletes deletes — the owner accepted that, and it replaces "Cancel has the focus", which the app's questions had until then.
  A step drawn in place of another takes the focus the same way, where the control that had it went with the old step; one that is only waiting, its answer disabled while a try is under way, is waited for, rather than the focus going on to the way out, where Enter would leave.
  The focus put on the ✕ for want of anything else — the Vault dialog while it reads the key file — goes on to the field or the answer the step then draws.
- **Escape is the way out, everywhere** — the secret panel in a note included, where it had been Done; Mod+Enter is Done there.
  A dialog that has to be answered, an import under way or a tab a newer build has replaced, has neither a way out nor Escape.
  Only the dialog on top answers a key, and a key a question inside it took is not taken again.
- **Over everything** (`Dialog`): at the end of the page, so no stacking context can put it under the toasts; modal, so Tab goes round what is in it and the shortcuts are held; the focus given back to what had it, or to `returnFocus`.
  `ConfirmDialog`, `InfoDialog` and `NameDialog` are it, as are the import's and the stale tab's notices, a notebook's attached files and the vault's dialogs.
- **Asked in place** (`InlineDialog`): the storage panel's questions — re-scan, disconnect and its steps, a move's second step, a detached source's discard — and Delete on a file in a notebook's attached files.
  Not modal, so neither Tab nor the shortcuts are held, and no ✕ — its Cancel is its way out — but the row, the focus and Escape are a dialog's.
  It takes the focus only where nothing else has it, or it is in the place the question was asked from: a question that comes after a push of some seconds does not pull a user out of the note they went back to.
  One asked inside another has an Escape of its own, which is its Cancel.
- **Not dialogs:** the command palette and a scratch note opened over the board, whose keys are an editor's.
  The toolbar's link panel has the row (Remove, then Apply), and closes as the toolbar's other panels do.
