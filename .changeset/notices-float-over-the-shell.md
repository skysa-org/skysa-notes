---
'@skysa/web': patch
---

The notice after connecting a storage account, and the one saying why a note or
a notebook could not be made, are now cards floated over the page rather than a
thin grey bar across the top of the frame.

The bar was missable, which was found the way these things are: an account was
connected with Google's files permission unticked, the app said so correctly,
and the line was read only after being looked for.

Each card is coloured by what it is — success, warning or error — as a bar down
its leading edge and a wash mixed into the surface behind it. The words stay
`--fg` on what is within a few percent of the colour they were designed
against, so the message's contrast does not depend on its tone, and a warning
or an error is bold as well as coloured: the colour is the one thing a reader
may not be able to see. `role` follows the tone — `status` for a success,
`alert` for the other two — so what a screen reader does is unchanged.

Giving them colour meant deciding what each message *is*, which turned up one
that had been wrong all along: a note brought back into the source it was
deleted from was announced as an `alert` alongside the genuine failures, and is
a success. Restored into a source that is now disconnected is a warning, and an
unticked permission is a warning too — everything worked exactly as asked and a
tickbox fixes it — where a server that will not have the account is an error,
because trying again cannot help.

Three ways out and no timer: Dismiss, touching anything else on the page, or
navigating. Pointers only, so an error can be read with the cursor still in the
note it is about. The undo-delete notice deliberately does none of this — a
click anywhere taking away the only route back from a delete would lose work —
but it does join the same stack instead of placing itself 5rem up to dodge the
new-version prompt, so two notices at once sit above one another rather than on
one another. The card the four of them share is one rule; only the placing and
the tone differ.
