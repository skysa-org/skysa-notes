-- The old `connections` table, superseded by `storage_connections` in 0004.
--
-- Its own file, and one statement, because 0004 must never destroy the table it
-- copies from: a failure anywhere in 0004 has to leave a state 0004 can be run
-- against again. Here there is nothing to half-do.
--
-- `users` and `identities` stay. They are Phase 9's (docs/PLAN.md §10) and
-- nothing reads them today; `connections` was their only other referent, and
-- with it gone the cascade from `users` reaches nothing.
DROP TABLE IF EXISTS `connections`;
