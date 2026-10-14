---
'@skysa/core': patch
---

Google Drive: "Checking for changes…" no longer takes a long time after a device has been away while the account was busy. When the check would take longer than a full re-scan, it re-scans instead, which is what pausing and re-scanning by hand did. Each page of the check also takes about half as long as before.

Every provider: a re-scan can no longer delete a note another device made. Before, this could happen when the other device had put its note at the name of one you had just deleted here.
