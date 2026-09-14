import { drizzle } from 'drizzle-orm/d1';

import * as schema from './schema.js';

export const createDb = (binding: D1Database) => drizzle(binding, { schema, casing: 'snake_case' });

export type Database = ReturnType<typeof createDb>;

export { schema };
