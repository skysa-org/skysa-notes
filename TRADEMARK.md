# Trademark policy

> **Draft — not reviewed by counsel.** This states the project's intent. It has
> not been checked by a lawyer and may change. See `docs/ARCHITECTURE.md` §13.

The code in this repository is licensed under [AGPL-3.0](LICENSE). That licence
covers the **code**. It does not grant any right to the **names and marks** the
project goes by:

- **Skysa**
- **skysa-notes**
- the Skysa logo and wordmark, and the Skysa Notes app icons (the curled page
  on Skysa blue)
- names close enough to be confused with these (`Skysa Notes Pro`,
  `skysanotes`, `skysa-notes-plus`, …)

This is the ordinary split for an open-source project, and it exists for one
reason: someone running a modified instance should not be able to make users
believe it is the one the project publishes. The licence is meant to let you
change the software freely; it is not meant to let you speak in the project's
name.

## What you may do without asking

- **Say what your thing is built from.** "Based on skysa-notes", "a fork of
  skysa-notes", "compatible with skysa-notes". Nominative use — naming the
  project to refer to it truthfully — needs no permission and this policy does
  not try to restrict it.
- **Run an unmodified instance** for yourself, your family, your team or your
  company, and call it what it is.
- **Keep the name in the source tree.** Package names, directory names, import
  paths, test fixtures and the `wrangler.toml` app name are part of the code
  you received under AGPL-3.0. Renaming them is not required, and nothing here
  asks you to. This is about what a *user* sees: the app's own name, its icons,
  and how you describe it.

## The default brand

The app as this repository builds it is called **Notes**, in gray, with the
curled-page icons on that gray (`apps/web/brand/`). None of that is a mark this
policy claims: it is part of the code you received, and you may ship it as it
is. To give your instance its own name, colours, icons and fonts, set
`NOTES_BRAND` when you build (`docs/self-hosting.md`, "Your own brand"); that
is how the project's own hosted service, Skysa Notes, gets its name and look,
so a deployment never has to edit the code to rebrand.

## What needs a different name

- **A public service running modified code.** If you change the software and
  offer it to other people over a network, give it your own name. AGPL-3.0
  already requires you to offer your users the modified source (§13); this asks
  you not to present it as the project's own release. Both obligations exist
  because the user at the other end cannot see which one they are using.
- **A published fork** — an app store listing, a hosted product, a distribution
  package. Rebrand it.
- **Anything that implies endorsement**: "official", "certified", "the team
  behind", a logo used as your own, a domain that reads as ours.

## Accuracy, not permission

None of the above is a licence fee or an approval queue. If you have rebranded
and are describing your relationship to the project accurately, you are within
this policy and do not need to contact anyone.

## Other companies' marks

The app shows the marks of the storage providers it connects to — Dropbox,
OneDrive and Google Drive — so a user can tell which storage a set of notes is
in (`apps/web/src/assets/providers/`). They belong to Dropbox, Inc., Microsoft
Corporation and Google LLC. They are not part of what AGPL-3.0 grants and not
part of this policy: they are here unaltered, to identify those services, as
each company's brand guidelines allow, and their use is governed by those
guidelines. A fork that shows them takes on the same guidelines.

## Questions

Open a GitHub Discussion, or an issue if Discussions are not enabled yet.
