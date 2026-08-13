/**
 * Every error the API returns on purpose is one of these. The error
 * middleware turns it into the JSON shape the Flutter `ApiException`
 * knows how to parse:
 *
 * ```json
 * { "success": false, "message": "...", "code": "EMAIL_TAKEN",
 *   "errors": { "email": "Already registered" } }
 * ```
 */
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly fieldErrors: Record<string, string>;
  public readonly isOperational = true;

  constructor(
    statusCode: number,
    message: string,
    code = 'ERROR',
    fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.fieldErrors = fieldErrors;
    Error.captureStackTrace?.(this, this.constructor);
  }

  static badRequest(
    message: string,
    code = 'BAD_REQUEST',
    fieldErrors: Record<string, string> = {},
  ) {
    return new ApiError(400, message, code, fieldErrors);
  }

  static unauthorized(message = 'Not authenticated', code = 'UNAUTHORIZED') {
    return new ApiError(401, message, code);
  }

  static forbidden(message = 'Not allowed', code = 'FORBIDDEN') {
    return new ApiError(403, message, code);
  }

  static notFound(message = 'Not found', code = 'NOT_FOUND') {
    return new ApiError(404, message, code);
  }

  static conflict(
    message: string,
    code = 'CONFLICT',
    fieldErrors: Record<string, string> = {},
  ) {
    return new ApiError(409, message, code, fieldErrors);
  }

  static validation(
    fieldErrors: Record<string, string>,
    message = 'Please check the highlighted fields',
  ) {
    return new ApiError(422, message, 'VALIDATION_ERROR', fieldErrors);
  }

  static tooManyRequests(message = 'Too many attempts. Please wait a moment.') {
    return new ApiError(429, message, 'RATE_LIMITED');
  }

  static internal(message = 'Something went wrong') {
    return new ApiError(500, message, 'INTERNAL_ERROR');
  }
}
