The default brand: what the app is called and how it looks when nothing else
is given (`docs/ARCHITECTURE.md` §8, "Brand"). A deployment that wants its own
points `NOTES_BRAND` at a `brand.json` of its own when it builds, and changes
nothing here (`docs/self-hosting.md`, "Your own brand").

- `brand.json`: the name ("Notes"), the colours, and where the icons are. No
  fonts, so the app keeps the system's. `brand.schema.json` is its JSON Schema,
  for an editor; `tests/brand.test.ts` holds it to `brandSchema` in `brand.ts`.
- `icons/`: the six icons, at the names and sizes in `BRAND_ICONS`. They are the
  page-with-a-curled-corner artwork the app shipped with up to v0.5.2, on the
  default brand's gray (`#4B5563`, its light `brand`) instead of that release's
  blue. The favicons are a rounded tile; every other icon is a full square,
  since the platforms that show them round or crop it themselves (the maskable
  one keeps the page inside the central 80% circle).
- `recolour.mjs`: how they were made from that release's, and how to make a set
  on another colour. Its header has the commands.

See `TRADEMARK.md` on names and marks.
