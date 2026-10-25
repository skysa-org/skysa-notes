---
'@skysa/core': patch
---

A pull whose token expires during the scan that replaces a dead cursor now refreshes the token and goes on, and so does a pull whose cursor turns out dead on the retry after a refresh. Before, either one ended the run as a retry, and the pull had to wait for the next one.
