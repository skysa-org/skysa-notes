---
'@skysa/web': patch
---

The brand's documentation now says what colours the installed app's navigation bar on Android, which 1.0.9 got wrong. On Android 15 and later it is `colors.background` in `brand.json`, the splash screen's colour, in both light and dark mode; the light theme's `brand` colours it only on Android 14 and older. To change the bar on current phones, change `background`: a light one is a pale strip under the app in dark mode, and the light `brand`'s value gives one bar on every phone. Nothing changes in the app itself.
