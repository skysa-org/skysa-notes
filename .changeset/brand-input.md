---
'@skysa/web': minor
---

The app's name, colours, icons and fonts come from a brand file read when it is
built. Point `NOTES_BRAND` at a `brand.json` of your own to set them
(`docs/self-hosting.md`, "Your own brand"); nothing in the repo needs editing.

**Without one, the app now builds as "Notes", in gray, with the curled-page
icons on that gray**, where it was "Skysa Notes" in blue. An instance that
wants its old look back sets `NOTES_BRAND`. Nothing about data changes: the
folder in storage and the local database keep their names, so connected
libraries are found as before. The page also gets a title-bar colour for each
of the light and dark themes, and the brand colour a dark-theme value of its
own.
