-- What device each grant is, as a label (docs/ARCHITECTURE.md §6): "Safari on
-- iPhone", for the device list. Nullable, and null for every grant made before
-- it: those say "A device" until they next connect. One statement, so there is
-- no partial state for a re-run to start from.
ALTER TABLE `grants` ADD `device` text;