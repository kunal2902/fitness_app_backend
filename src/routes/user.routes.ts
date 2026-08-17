import { Router } from 'express';

import {
  deleteAvatarImage,
  getProfile,
  updateProfile,
  uploadAvatarImage,
} from '../controllers/user.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { uploadAvatar } from '../middleware/upload.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { updateProfileSchema } from '../validators/user.validator.js';

const router = Router();

// Everything here is the signed-in user acting on their own record; the id
// always comes from the token, never from the request.
router.use(requireAuth);

router.get('/me', getProfile);
router.patch('/me', validate(updateProfileSchema), updateProfile);

router.post('/me/avatar', uploadAvatar, uploadAvatarImage);
router.delete('/me/avatar', deleteAvatarImage);

export default router;
