/**
 * Lightweight HTTP Router
 * Method/path matching with URL param extraction. No dependencies.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

// ============================================================================
// Types
// ============================================================================

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

// ============================================================================
// Router
// ============================================================================

export class Router {
  private routes: Route[] = [];

  /** Register a route with method and path pattern */
  route(method: string, path: string, handler: Handler): void {
    const { pattern, paramNames } = compilePath(path);
    this.routes.push({ method: method.toUpperCase(), pattern, paramNames, handler });
  }

  /** GET route */
  get(path: string, handler: Handler): void { this.route("GET", path, handler); }

  /** POST route */
  post(path: string, handler: Handler): void { this.route("POST", path, handler); }

  /** DELETE route */
  delete(path: string, handler: Handler): void { this.route("DELETE", path, handler); }

  /** PATCH route */
  patch(path: string, handler: Handler): void { this.route("PATCH", path, handler); }

  /** Handle OPTIONS for CORS preflight */
  options(path: string, handler: Handler): void { this.route("OPTIONS", path, handler); }

  /** Find matching route and execute handler */
  dispatch(req: IncomingMessage, res: ServerResponse): boolean {
    const method = req.method?.toUpperCase() || "GET";
    const urlPath = stripQuery(req.url || "/");

    for (const route of this.routes) {
      // OPTIONS matches any registered path for CORS
      if (method === "OPTIONS" && route.method !== "OPTIONS") continue;

      const match = route.pattern.exec(urlPath);
      if (match) {
        // Must match both method and path
        if (route.method !== method) continue;

        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          params[route.paramNames[i]] = match[i + 1] || "";
        }
        const result = route.handler(req, res, params);
        if (result instanceof Promise) {
          result.catch(err => {
            console.error(`[router] unhandled error in ${method} ${urlPath}:`, err);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: false, error: "Internal server error" }));
            }
          });
        }
        return true;
      }
    }

    return false;
  }

  /** List all registered routes */
  list(): string[] {
    return this.routes.map(r => `${r.method} ${r.pattern.source}`);
  }
}

// ============================================================================
// Path Compilation
// ============================================================================

/**
 * Convert a path like `/api/memory/:id` into a RegExp and param names.
 * Supports:
 *   /api/stats           → exact match
 *   /api/memory/:id      → named param
 *   /api/knowledge/:action → named param
 */
function compilePath(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const patternStr = path
    .replace(/\/:([a-zA-Z0-9_]+)/g, (_match, name: string) => {
      paramNames.push(name);
      return "/([^/]+)";
    })
    .replace(/\//g, "\\/");

  return {
    pattern: new RegExp(`^${patternStr}$`),
    paramNames,
  };
}

function stripQuery(url: string): string {
  const idx = url.indexOf("?");
  return idx >= 0 ? url.slice(0, idx) : url;
}
