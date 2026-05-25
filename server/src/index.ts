/**
 * @layer server
 *
 * Express entry-point.
 *
 * Routes:
 *   GET  /health        — liveness probe
 *   ALL  /mcp           — MCP host (Streamable HTTP), the only way external agents drive the document
 *
 * No business logic lives here — the MCP router forwards external tool calls to
 * the same command registry the UI uses (architecture L1, L6).
 */

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { buildMcpRouter } from './mcp';

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();

app.use(express.json({ limit: '2mb' }));

// Allow the Vite dev server and common localhost origins.
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. curl, Postman, same-origin).
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// MCP endpoint — Streamable HTTP, guarded by bearer auth + rate limiting.
// See server/src/mcp.ts for the implementation.
app.use('/mcp', buildMcpRouter());

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env['PORT'] ? parseInt(process.env['PORT'], 10) : 3001;

app.listen(PORT, () => {
  if (!process.env['MCP_AUTH_TOKEN']) {
    console.warn('[warn] MCP_AUTH_TOKEN is not set — /mcp endpoint is unprotected. Set it in production.');
  }
});

export { app };
