---
'@skysa/web': patch
---

The rich editor now fills the pane it appears to fill. The editable surface was
only as tall as the words in it: everything below the last paragraph looked like
the note and was not, so a click there put the cursor nowhere. Milkdown puts a
container of its own between the element it is handed and ProseMirror's, and
with no height on it the surface's `min-height: 100%` had nothing to resolve
against. Every element in that chain now grows.

Above it there is a formatting toolbar, grouped the way Atlassian's editor
groups one: text style, then bold and italic with the rest of the marks behind
a "More formatting" button, then the three kinds of list, then indentation,
then the link.

What is missing from it is missing because markdown cannot hold it — there is
no text colour, no highlight and no alignment in a `.md` file. Insert is not
duplicated either: a table, a code block, a quote or a divider still comes from
the `/` menu. The style menu offers headings down to six, two deeper than `/`
does.

Indentation is list nesting, which is all indentation means in markdown, and
both buttons are grey wherever nesting would not happen — including the first
item of a list, where there is nothing above to nest under. A lit mark button
means the next press takes that mark off.

The bar is one stop in the tab order with the arrows moving inside it, so it is
not fourteen presses of Tab between a note's title and its text, and it appears
only in rich mode: raw mode is markdown, where the characters are the
formatting.

Lists work properly as well, which they did not before. Switching a bulleted
list to a numbered or task list — or back — now changes the list, where the
preset's commands would only wrap a second list around it and so appeared to do
nothing. Pressing the button for the list you are already in takes the list off.

A new item beside task items is now a task item, and an unticked one. Pressing
Enter at the end of a finished task used to hand back a second task already
ticked, and a double Enter two levels into a checklist left a plain bullet
behind.

Task checkboxes can be ticked. The box used to be a character drawn in the
stylesheet, which nothing can press; it is a real checkbox now, and `Mod+Enter`
does the same from the keyboard. Ticking an item ticks everything under it, and
unticking a child unticks the item above it, as far up as that goes — nothing
above an unfinished task is finished. Unticking an item leaves its children
alone: that says the item is not done, which says nothing about work already
finished. Adding a
new sub-item unticks the item above it for the same reason: adding to what
something consists of is saying there is more to do. A note that arrives from
elsewhere with a finished parent over an unfinished child is left as it is —
only a parent your own edit left that way is corrected.

Ticking the last of a parent's children does not tick the parent: that is a
task in its own right, and may have a step nobody wrote down.
