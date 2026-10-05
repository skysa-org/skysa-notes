---
'@skysa/core': minor
'@skysa/web': minor
---

A note's dates come from its frontmatter in every browser. A `created` written as `2014-02-20 14:00:10 UTC`, as OneNote's exporters write it, is now read in Safari and on iPhones too, where it was taken for the day the note was imported. The date a note shows as edited is read from `updated`, or else from `modified`, `date modified` or `lastmod`, as other tools write it, or else from when the note was made, rather than being the day it was imported. Notes already imported keep the dates they were given; importing them again dates them by their frontmatter.
