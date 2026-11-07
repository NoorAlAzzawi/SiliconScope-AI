import express from 'express';
import cookieParser from 'cookie-parser';
import { runsRouter } from './routes/runs';
import { comparisonsRouter } from './routes/comparisons';
import { registerRouter } from './routes/register';
import { dashboardRouter } from './routes/dashboard';
import { securityHeaders } from './middleware/securityHeaders';
import { generalRateLimit, registerRateLimit, loginRateLimit } from './middleware/rateLimit';
import { logger } from './middleware/logger';

const app = express();

app.use(securityHeaders);
app.use(generalRateLimit);

// Request logger — explicit allowlist of safe fields (§14.2).
// NEVER reads req.headers, req.body, req.cookies, or req.socket.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method:      req.method,
      path:        req.path,
      status:      res.statusCode,
      duration_ms: Date.now() - start,
      device_id:   req.deviceId,   // set by auth middleware; undefined for unauthenticated
    }, 'API request');
  });
  next();
});

// 25 MiB limit for POST /api/v1/runs; 1 MiB for all other routes.
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/v1/runs') {
    express.json({ limit: '25mb' })(req, res, next);
  } else {
    express.json({ limit: '1mb' })(req, res, next);
  }
});

app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/version', (_req, res) => {
  res.json({ api_version: 'v1', min_agent_version: '0.1.0' });
});

app.use('/dashboard', loginRateLimit, dashboardRouter);
app.use('/api/v1/register', registerRateLimit, registerRouter);
app.use('/api/v1/runs', runsRouter);
app.use('/api/v1/comparisons', comparisonsRouter);

// Generic 413 handler for body-parser rejections.
app.use((err: Error & { status?: number; type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Body-parser parse failure — malformed JSON
  if (
    (err as { type?: string }).type === 'entity.parse.failed' ||
    (err as { status?: number }).status === 400
  ) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON.' } });
    return;
  }
  if (err.status === 413 || err.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds size limit.' } });
    return;
  }
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
});

export default app;
