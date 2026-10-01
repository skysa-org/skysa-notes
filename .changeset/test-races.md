---
---

Nothing ships in this change: two test races are made to stop failing runs in
which every test passed.

Milkdown's start-up timeouts, which are never cleared, could fire after a test
file's jsdom was torn down and call a `removeEventListener` that was no longer
there; the test setup now holds a file until they have fired. And the panel's
sync-status tests could change the status before the panel had subscribed to
it; their helper now waits until it has.
