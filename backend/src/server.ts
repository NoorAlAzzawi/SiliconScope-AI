import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import app from './app';
import { setPool } from './middleware/auth';
import { initRegistration } from './routes/register';
import { pool } from './db/pool';
import { logger } from './middleware/logger';

setPool(pool);

const PORT = parseInt(process.env.PORT ?? '3000', 10);

(async (): Promise<void> => {
  const setupToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = await bcrypt.hash(setupToken, 12);
  initRegistration(tokenHash);

  if (!process.stdout.isTTY) {
    process.stderr.write(
      'WARNING: setup token is being written to a non-terminal (stdout is redirected).\n' +
      'Treat any log file or journal entry containing this output as a secret.\n'
    );
  }

  process.stdout.write(
    `SiliconScope registration token: ${setupToken}\n` +
    'Keep this safe — it is shown only once and expires after first use.\n'
  );

  app.listen(PORT, () => {
    // §14.2 Startup log: version + listen address only. Never DB password or setup token.
    logger.info({ version: '0.1.0', listen_address: `0.0.0.0:${PORT}` }, 'Backend startup');
  });
})();
