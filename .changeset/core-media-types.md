---
'@skysa/core': patch
---

What the app knows of each file extension (its kind, its media type, whether it is drawn inline, told to a provider, or given to a nameless file) is one table, `files/mediaTypes.ts`, in place of six hand-kept ones. What opens in a tab is still named extension by extension.
