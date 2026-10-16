---
'@skysa/web': minor
---

The fill window, the app's own page at `/fill`, and the bookmarklet that opens it over a site's sign-in page: what they say to each other, and what the window says while it waits for the page, cannot reach one, or is opened by a bookmarklet of another version. The window takes the page to be the origin the browser stamped on its message, never what the page says, and answers that origin alone. It does not fill anything yet, and the bookmarklet is not offered yet.
