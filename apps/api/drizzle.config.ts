import { defineConfig } from 'drizzle-kit';

// Migrations are generated offline against the SQLite dialect and applied with
// `wrangler d1 migrations apply`, so no database credentials are needed here.
export default defineConfig({
	schema: './src/db/schema.ts',
	out: './migrations',
	dialect: 'sqlite',
	casing: 'snake_case',
});
