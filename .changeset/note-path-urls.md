---
'@skysa/web': minor
---

The browser's Back and Forward buttons now move between the notes and notebooks you opened, including back into another source after switching to it. The address bar names the open note by its notebooks and its name, as lowercase words joined by hyphens, such as `/#/work-stuff/projects/q3-plan`. A link or bookmark to a note opens it, including one typed with the names as they are, and the address follows the note when it is renamed. The page title says where you are: `Work > Projects > Q3 plan`. Notebook and note names stay in the part of the address after `#`, which the browser never sends to the server. Links from earlier versions, which named a note by `?note=`, now open wherever you last were.
