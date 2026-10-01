---
'@skysa/web': patch
---

The app remembers, on this device and per source, which notebook was open and
which note was open in each notebook, and goes back there: when it opens at its
start URL, when a source is shown again, and when a notebook is clicked. Where
nothing is remembered, or what was has gone, it opens the first notebook and
its newest note — including for a notebook the app opened by itself, which
used to show an empty pane beside its list.
