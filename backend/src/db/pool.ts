import { Pool } from 'pg';
import { logger } from '../middleware/logger';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

export const pool = new Pool({ connectionString });

// Verify connection on module load.
pool.query('SELECT 1').catch((err: Error) => {
  // Log only the message, never the connection string.
  throw new Error(`Database connection failed: ${err.message}`);
});

pool.on('error', (err: NodeJS.ErrnoException) => {
  // Log only the error code — never the connection string, password, or SQL text.
  logger.error({ code: err.code ?? 'UNKNOWN' }, 'Database pool error');
});
