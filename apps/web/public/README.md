The app icons are the page-with-a-curled-corner artwork on its blue
(`#007aff`, `--brand` in `src/styles.css`, which is also the primary button's
fill and the colour of links). The page was keyed off the source image and set
on a flat blue, so the JPEG's noise is not in them. The favicons are a rounded
tile; every other icon is a full square, since the platforms that show them
round or crop it themselves (the maskable one keeps the page inside the central
80% circle). No generator is checked in: they were rendered once from the
source image, and a change to the artwork means rendering all six again at
these sizes. See `TRADEMARK.md` on branding.
