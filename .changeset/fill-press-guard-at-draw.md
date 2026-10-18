---
'@skysa/web': patch
---

The fill window times its guard against a stray press from the moment its logins are drawn, rather than after the browser has painted them, so a press that lands on logins just drawn is not taken as one meant for them.
