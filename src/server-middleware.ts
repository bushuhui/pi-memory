/**
 * HTTP Middleware
 * API key authentication, CORS, request logging.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

// ============================================================================
// Types
// ============================================================================

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

// ============================================================================
// Request Logging
// ============================================================================

function formatTimestamp(): string {
  return new Date().toISOString();
}

export function requestLogger(): Middleware {
  return (req, _res, next) => {
    const start = Date.now();
    // Capture the original end to log after response
    const originalEnd = res => {
      const duration = Date.now() - start;
      console.log(
        `[http] ${req.method} ${req.url} ${res.statusCode} ${duration}ms`
      );
    };

    // We need to hook into res.on('finish') but res type is ServerResponse
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = (statusCode: number, ...rest: unknown[]) => {
      res.on("finish", () => {
        const duration = Date.now() - start;
        console.log(
          `[http] ${req.method} ${req.url} ${statusCode} ${duration}ms`
        );
      });
      return origWriteHead(statusCode, ...rest as [any]);
    };

    next();
  };
}

// ============================================================================
// CORS
// ============================================================================

export function corsMiddleware(origins?: string[]): Middleware {
  return (_req, res, next) => {
    if (origins && origins.length > 0) {
      res.setHeader("Access-Control-Allow-Origin", origins.join(", "));
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, PATCH, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
      res.setHeader("Access-Control-Max-Age", "86400");
    }
    next();
  };
}

// ============================================================================
// API Key Authentication
// ============================================================================

export function apiKeyMiddleware(apiKey?: string): Middleware {
  if (!apiKey) {
    // No key configured — skip auth
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    const provided = req.headers["authorization"]?.replace(/^Bearer\s+/i, "")
      ?? req.headers["x-api-key"] as string | undefined;

    if (!provided || provided !== apiKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Unauthorized" }));
      return;
    }

    next();
  };
}
