# 0017. Filling in on a site

*2026-10-16. Cited in the code as §7, "Filling in on a site". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

**A bookmarklet fills a site's login from the passwords, and remembers one typed there.**
The owner asked for it on 2026-10-16, and chose the answers below.

**Which logins a site is offered** (`vault/sites.ts` in core; the owner's choice): only the page's own site.
A login fills the site its Site names and the sites under it: one saved for `example.com` fills `login.example.com`, never the other way about.
One saved over `https:` never fills a page over `http:`, which would send it in the clear; one saved over `http:` fills either.
The port is the one it was saved for.
An address (`192.168.1.1`, `[::1]`) or a name of one label (`localhost`) fills only itself, and a bare one is taken to be over `https:`, as any bare host is, so a router's page over `http:` needs its Site written with `http://`.
A name in any script is compared as the browser's URL parser writes it, in ASCII, so a look-alike written with a Cyrillic `а` is another site, as it is to the browser; so is `example.com.evil.example`, and an address with a user in it (`https://example.com@evil.example`) names no site at all.
- *`www.`*: a login saved for `www.example.com` also fills `example.com`, the same site with or without it, but not the other sites under `example.com`.
  Saving from a page keeps the page's own host, so a login saved on `www.tumblr.com` does not fill `someone.tumblr.com`.
- *Only the encrypted Site fills* (the owner's choice, made on learning what a label allows).
  A label is plain text in the file's name, so anyone who can write the folder could rename `bank.com` to a look-alike's name and have the bank's password offered there; a Site is inside the item's one secret, with the password, and cannot be moved to another item's.
- *No list of public suffixes.*
  The Public Suffix List is MPL-2.0, which the repository does not take (CLAUDE.md), and a partial one would be wrong in the way that matters.
  So a Site of `github.io` fills every site under it.
  Saving from a page keeps its own host, so a parent fills its children only where the user wrote it in.

**The Site** is a field of the item, after its label, encrypted with the username and password (`urls`, §3).
It says it is "The web address it fills in on, and the sites under it", or, holding what is not one (`siteOf`), that it fills in nowhere.
It edits the first of the item's sites and keeps the rest, which a later version may write; emptied, it stays the first while others follow it, so the field goes on editing it.
An item whose `urls` this version cannot read shows no Site, and keeps it as it is.
A new item with only a Site in it is kept by Done, as one with a field is.
Where the Site is empty and the label is a web address (`labelLink`), the form offers "Use github.com as the site", which writes the label's origin in: what an item made before Sites needs to fill in, in one press, since a label never fills.
Opened, the item shows its Site's address with Open, as a label's is shown (§7, "Passwords in the vault"), in place of the label's; locked, the Site is not known, and the label's address is shown as before.

**The bookmarklet and the fill window** (`src/fill/`).
The bookmarklet is a `javascript:` address the user keeps as a bookmark, run in the page of the site they are on.
It and the fill window, a page of the app's own at `/fill` (§8), speak a small protocol by `postMessage` (`protocol.ts`):
1. The bookmarklet finds the login's fields and opens `/fill` in a window of its own, with its opener (`_blank`, never a named window, which anything on the page could reach by name).
   It listens only to that window, at the app's origin.
2. The window, as it starts and before anything else on its page, tells its opener it is `ready`, to any origin: it says nothing else.
3. The bookmarklet answers `hello`, to the app's origin alone, with what the fields hold — the username, the password, a new password where the form asks for one — and which it found, so a login typed there can be remembered.
4. The window takes the page to be **the origin the browser stamped on the `hello`**, never anything the page says about itself (`channel.ts`).
   Trusting what a page said of itself is how bookmarklet password managers gave one site another's logins (Li et al., "The Emperor's New Password Manager", USENIX Security 2014).
   It takes a `hello` only from its opener, from a page on the web and not the app's own, and only the first: that fixes the page, and every message after it is let be.
5. Its login chosen, the window sends `fill` to that origin alone, the origin as the browser said it, and closes.
   An opener gone on to another site since does not get it; the browser drops it.
   The bookmarklet finds the fields again, a re-render having perhaps replaced them, sets each with the input's own value setter and sends `input` and `change`, as typing would, which React and Vue hear, and stops listening.

`v` is the protocol's version and `b` the bookmarklet's revision.
A `hello` of a later version is not read, and the window says the app is behind; of an earlier one, that the bookmarklet is out of date; of an older revision, that a newer one is there to be set up, while it goes on working.
A `hello` slow to come is waited for, the window saying so after three seconds.
A window no page opened, or one cut off from its page by the site's `Cross-Origin-Opener-Policy`, says it could not reach a page and offers the way to Passwords, where a password can be copied.

**The window's logins** (`FillLogins.tsx`, over `matches.ts`).
The window looks only once it has taken a `hello`: a page that opens `/fill` without the bookmarklet's answer never sets off the device's lock.
It looks in each source that is connected, and not let go of, whose passwords this browser shows (the Vault dialog's switch) and whose vault this device can open, in their tabs' order, and asks each one's unlock in turn, as the app does (`UnlockDialog`, naming the source where there are two); a source with no passwords in it is not asked.
Only the Site says where an item fills in, and it is encrypted, so every item of a source is opened, the page let draw between them, with copies of the keys wiped after.
A row is the item's label and username, the site above the page's it is for where it is one ("For example.com"), and its source where there are two.
Fill in reads the item again, as it is then, checks again that its Site fills in on the page, and sends that: an item changed meanwhile fills in only where it still would.
Where the page had no fields to fill, or has gone on since, a row offers Copy username and Copy password instead.
A press within 500 ms of the window being shown or focused, or of what it lists changing, is let be, so a press meant for what was there before, or one a page timed to land as the window opened, fills in nothing.
The window is used once: filled, it closes, and it closes as its lock locks, which is the app's own (hidden, or 30 s idle).
It never asks for the recovery key: where only that is left, it says to use it in the app.
It says where no source shows its passwords in this browser, naming the place that surprises — on iOS and macOS, a web app added to the Home Screen or the Dock keeps storage of its own, apart from Safari's — and counts the items it could not open: made with another key, or holding a Site in a shape this version does not know.

**Remembering a password typed there** (`Remember.tsx`, over `remembering.ts`).
Where the page's fields held a password — the new password, where the form asks for one — the window offers, once it has looked: nothing more, where a login there holds it already; **Update**, naming the login, where exactly one login saved for the page's own site, not one above it, has the username typed, which is not empty; else **Save**.
Update puts the typed password in place of that login's, and keeps the one it replaces with it, newest first, five at most (`previousPasswords`, §3), so a password typed wrong, or put in the field by a script on the page, never loses the one it replaced; it writes through `rewriteNoteBody`, under a new origin, so an editor open on the item takes it in, and only while the item's body is still the one it read, else it says it changed and writes nothing.
Where two logins have that username, or the one is saved for a site above the page's, which it would replace is not known, so it is not offered, and Save, which loses nothing, is.
Save is a form of the label (the page's host, without `www.`), the username, the password, the Site (the page's own address, so a login saved from a page fills that host alone unless the user writes a parent in), and the source, where there is more than one; it writes a new item, as Passwords' `+` does.
Both are user edits, dirty and owed to the remote, which a tab of the app sends; both seal to the recipient this device enrolled with, where it is still the source's (`notHere`, now `secrets/sealHere.ts`, which the editor's new secrets ask too), which needs no unlock, so a source with nothing in it is saved to without one.
Passwords shows what an Update kept under the password, a "Previous password" field each, with the day it was replaced, hidden until shown, with Copy.

**What it finds.**
The fields that are drawn, enabled and writable, of the form that has the focus where that holds a password, else of the page.
The password is the field marked `current-password`, else a password field not marked `new-password`; the new password, the field marked `new-password`.
The username is the field marked `username` or `email` (`autocomplete` read as a list, so `username webauthn` is one), else one named for a user, an e-mail or a login, else the field nearest before the password; on a page that asks for the username first, with no password, the one field there is.

**The bookmarklet is plain JavaScript taken as it is written** (`bookmarkletCode.js`, imported `?raw`, and every byte of the address percent-encoded): what the tests run is what a bookmark holds.
Built from a function's `toString()`, it would be what the bundler made of the function, which the tests never see.
It uses only the page globals its lint block names; it writes nothing into the page and shows nothing there but the browser's own alert where the window is blocked, in the catalog's words, written into the address as it is made.
It answers nothing, so the page is not replaced by what it returns (`void`).

**Setting it up** (`FillSetupDialog`, from the bookmark button in Passwords' header, "Fill on sites").
The bookmarklet is a link, to drag to the bookmarks bar, named for the bookmark it becomes ("Fill with ‹app›", the build's name; "Fill in" where it has none), and Copy, for a phone, where a bookmark is made of any page and its address replaced: Safari opens it from Bookmarks, and Chrome on Android runs it by its name typed in the address bar.
The dialog says that only a password with a Site fills in, that the fill window never asks for the recovery key (so a window that does is not the app's), what browsers allow (below), that the bookmarklet works with the app at its origin only, and to set it up again where the window says it is out of date.
**The link is the one `javascript:` address in the app, and is never run there.**
React refuses to write one into an `href`, and `jsx-a11y` refuses one in JSX, so it is made by hand (`setAttribute`); a press on it in the app is stopped, and says to drag it instead, and the shell's `script-src 'self'` would refuse to run it anyway.

**What browsers allow.**
Chrome and Edge run a bookmarklet on any page.
Firefox does not run one on a page whose `script-src` refuses inline script (bug 866522, open), and Safari may not either, so on such a site (GitHub's sign-in, for one) nothing happens.
Firefox for Android does not run them reliably.
A form inside a shadow root or a frame from another origin is not reached.
**On iOS and macOS, a web app added to the Home Screen or the Dock keeps its storage apart from Safari's**, so the bookmarklet, in Safari, sees the sources set up in Safari, not the app's.
And the site's own scripts see what is filled, as they see what is typed.
