/**
 * HTTP Response Helpers
 * Unified JSON response formatting for REST API.
 */

// ============================================================================
// Types
// ============================================================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// ============================================================================
// Response Serialization
// ============================================================================

export function jsonResponse(res: NodeJS.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json).toString(),
  });
  res.end(json);
}

export function ok<T>(res: NodeJS.ServerResponse, data: T): void {
  jsonResponse(res, 200, { success: true, data } satisfies ApiResponse<T>);
}

export function created(res: NodeJS.ServerResponse, data: unknown): void {
  jsonResponse(res, 201, { success: true, data, message: "Created" } satisfies ApiResponse);
}

export function badRequest(res: NodeJS.ServerResponse, message: string): void {
  jsonResponse(res, 400, { success: false, error: message } satisfies ApiResponse);
}

export function unauthorized(res: NodeJS.ServerResponse): void {
  jsonResponse(res, 401, { success: false, error: "Unauthorized" } satisfies ApiResponse);
}

export function notFound(res: NodeJS.ServerResponse, message = "Not found"): void {
  jsonResponse(res, 404, { success: false, error: message } satisfies ApiResponse);
}

export function serverError(res: NodeJS.ServerResponse, message: string): void {
  jsonResponse(res, 500, { success: false, error: message } satisfies ApiResponse);
}

export function methodNotAllowed(res: NodeJS.ServerResponse): void {
  jsonResponse(res, 405, { success: false, error: "Method not allowed" } satisfies ApiResponse);
}
