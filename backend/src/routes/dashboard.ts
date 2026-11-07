import express, { Router, Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { createSession, invalidateSession, requireDashboardAuth } from '../middleware/auth';

export const dashboardRouter = Router();

const dashboardPasswordHash = process.env.SSCOPE_DASHBOARD_PASSWORD ?? null;
delete process.env.SSCOPE_DASHBOARD_PASSWORD;

dashboardRouter.use(express.urlencoded({ extended: false }));

// POST /dashboard/login
dashboardRouter.post('/login', async (req: Request, res: Response): Promise<void> => {
  if (dashboardPasswordHash === null) {
    res.status(503).json({
      error: {
        code: 'NOT_CONFIGURED',
        message: 'Dashboard authentication is not configured. Set SSCOPE_DASHBOARD_PASSWORD.',
      },
    });
    return;
  }

  const password = req.body.password as unknown;
  if (typeof password !== 'string' || password.length === 0) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'password is required.' } });
    return;
  }

  const match = await bcrypt.compare(password, dashboardPasswordHash);
  if (!match) {
    res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid password.' } });
    return;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  createSession(token, 'dashboard', 86_400_000);

  const cookieParts = [
    `sscope_session=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=86400',
  ];
  if (process.env.NODE_ENV === 'production') cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));
  res.status(200).json({ ok: true });
});

// POST /dashboard/logout
dashboardRouter.post('/logout', requireDashboardAuth, (req: Request, res: Response): void => {
  invalidateSession(req.sessionId!);
  res.setHeader('Set-Cookie', 'sscope_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.status(200).json({ ok: true });
});
