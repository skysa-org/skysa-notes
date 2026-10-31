# 0011. The app's words

*2026-10-07. Cited in the code as §7, "The app's words". A `§` here means a section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).*

**Every word the app shows or reads out comes from one catalog**, `apps/web/src/i18n/`, rather than being written where it is said, so that a translation is a second catalog and not a change to every component.
The owner asked for it on 2026-10-07, ahead of any translation, and chose the answers below.
English is the only catalog so far, and the locale (`LOCALE` in `i18n/t.ts`) is settled when the page loads and never changes under it: choosing a language would be a reload, so nothing has to tell React that the words moved.

- **Hand-rolled, with no dependency.**
  A catalog is plain data, in the shape a translation platform reads as JSON: a message is a string, or one string per plural category when it counts something, grouped into namespaces by the part of the app that says them (`en/*.ts`, put together in `en/index.ts`).
  `t(key, params)` looks one up by its dotted key.
  Nothing is compiled into a function at runtime, which would need the `eval` or `new Function` that `script-src 'self'` refuses (§9), and nothing a translator edits is code. i18next was the alternative: a dependency, and tens of kilobytes, for what is a hundred lines here.
- **Typed.**
  The keys are the English catalog's, so a key that is not there, a placeholder not given, or params given to a message that takes none fails `tsc`.
  A catalog in another language is a `Translation<English>`: the same keys, each a string or a plural as in English, with words of its own.
- **Placeholders** are `{name}`.
  A number is written in the catalog's locale (`Intl.NumberFormat`, so "1,028 notes"); one that is not a quantity, such as a year, is passed as a string.
- **A plural is whole sentences.**
  `{ one, other }`, or whichever CLDR categories the language has, chosen by `Intl.PluralRules` from `count`.
  English's grammar used to be code — `count === 1 ? 'it' : 'them'`, a sentence glued from fragments — and no translation could have got past it.
  A message is a sentence or more, never a fragment the code puts together.
  A namespace may not have a key named after a plural category, since an object with `other` in it is read as a plural (`tests/i18n.test.tsx` holds the catalog to this and to closed tags and braces).
- **Rich text** is `<name>…</name>` in the message and `rich(key, { name: (words) => … }, params)` where it is said.
  The tags are split out before the placeholders are filled, so a note named `<b>` stays a name.
- **Text written into the user's files comes from the catalog too** — a pasted picture's alt text and the link text of a file whose name says nothing (`editor.attach.linkText`), the folder a notebook gets when the name typed for it has nothing usable in it (`notebooks.unnamed`), the names a download is given — the owner's choice.
  `packages/core` writes none of it: it takes the words from its caller (`attachmentLabel`'s `words`, `sanitizeFolderName`'s `unnamed`) and is English only where nobody says otherwise.
- **A note with nothing to take a name from is the exception, by the owner's choice (2026-10-07):** it is `untitled.md` and its title `UNTITLED_TITLE` (`'Untitled'`) in every language, because the app reads them back — a note at that filename with no title of its own is unnamed (`isUnnamed`), a heading of `Untitled` does not name one, and a device built in another language has to agree.
  Only what is shown is in the user's language: `titleShown` turns `UNTITLED_TITLE` into `notes.untitled` wherever a title reaches the screen, the search index included, and the title field does not take the shown word, given back, for a new name.
  **Where one line has to say which note it is, a note with no name goes by its first words instead (2026-10-13, the owner's choice):** the compact bar's note dropdown, a scratch card's name in the bar, and the notice a delete leaves (and the one an undo leaves when the note goes back to another source).
  They are its opening line as its row in the list shows it (`noteOpening`, a picture's words included, but no line passed over for saying "Untitled"), cut to 40 characters after the last whole word and the punctuation ending it, with "…" (`shownName` in `store/titles.ts`).
  The bar cuts them at their end, not in their middle as it does a name, since it is how they start that tells two notes apart, and takes them as they were last stored rather than as they are typed: the bar is as wide as what it says, the panels open out of where its triggers are, and the shell holds that, so words that moved with each keystroke drew the whole shell again with each.
  A name being typed still shows as it is typed.
  One with no words is still `notes.untitled`.
  "No name" is no `title` the user gave, and `UNTITLED_TITLE` or, at the fallback filename, a title only that filename says (`nameless`), as another device reads `untitled.md` back: as `untitled`.
  The list row still says "Untitled" over its preview, which already shows the words.
  A clipboard item is the same: its name keeps the stems `text` and `image`, and `ClipName.label` is none for them, so the panel says `clipboard.text` and `clipboard.image`.
- **What is protocol stays English whatever the language:** the conflict suffix (§7, "Conflict rule"), the app folder and its marker (§8, "Brand"), and the words that keep a name off one Windows reserves (`con-note.md`, `CON folder`), which are the owner's choice too.
- **ESLint refuses words written into JSX** in `apps/web/src`: text, and the text of the props that are shown or read out (`INLINE_WORDS` in `eslint.config.js`).
  A string in a `.ts` file cannot be told from a key by its syntax, so those are review's to catch.
