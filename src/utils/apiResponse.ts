import type { Response } from 'express';

/**
 * Uniform success envelope. The Flutter `ApiClient` unwraps `data`, so
 * anything nested under it arrives at the service layer as the raw object.
 */
export interface ApiEnvelope<T> {
  success: true;
  message?: string;
  data: T;
}

export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
  message?: string,
): Response {
  const body: ApiEnvelope<T> = { success: true, data };
  if (message) body.message = message;
  return res.status(statusCode).json(body);
}

export function sendCreated<T>(
  res: Response,
  data: T,
  message?: string,
): Response {
  return sendSuccess(res, data, 201, message);
}
