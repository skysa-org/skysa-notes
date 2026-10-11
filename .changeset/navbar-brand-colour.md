---
'@skysa/web': patch
---

On Android, the installed app's navigation bar is now the brand's colour (the light theme's `brand` in `brand.json`), in both light and dark mode. Since 1.0.6 it was the splash background, which was a pale bar under the app in dark mode, as the light title-bar colour had been before. A phone picks this up once Android updates the installed app, which can take a day or more; `chrome://webapks` → "Update" makes it sooner.
