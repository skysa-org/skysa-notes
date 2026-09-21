---
'@skysa/core': patch
---

The provider contract suite no longer assumes a change feed is immediate and
reports each thing once. Google Drive's is neither: measured against a live
account, a new file took 1.4–2.8s to reach `changes.list` and one creation was
reported twice about two seconds apart with the same version.

Three additions, all test-only. `changesLagMs` says how far behind a feed may
run, and is 0 for every stub and for Dropbox and Graph. `drainUntil` polls the
feed until what the caller is waiting for appears, which is sound for an
expectation that something turns up and is what a fixed wait cannot do
reliably. `quietCursor` drains until a round comes back empty before taking a
baseline, which is what a feed that echoes needs and what polling cannot give
an assertion about emptiness. The live Drive harness also waits for its own
deletions to leave the search index, so the next scenario's cold-start scan
does not find files whose parent it has already removed.

No adapter changed. Unlike the Dropbox and OneDrive live runs, Drive's failures
were all the suite's assumptions rather than the adapter's behaviour.
