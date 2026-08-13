import type { UserDocument } from '../models/user.model.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireAuth` / `optionalAuth`. */
      user?: UserDocument;
      userId?: string;
    }
  }
}

export {};
