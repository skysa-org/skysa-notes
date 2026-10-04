---
'@skysa/web': patch
---

A note with a picture in it opens in the rich editor again. A picture with no title broke the rich editor with prosemirror-model 1.25.12, so a note was sent to markdown mode with "This note uses markdown the rich editor has no way to show" once it was opened again, or switched to markdown and back. A picture just added was shown fine until then. The workspace now resolves prosemirror-model 1.25.12 and prosemirror-view 1.42.6, so the tests run against the versions a fresh install gets.
