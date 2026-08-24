import { Router } from 'express';

import {
  endCall,
  getCallHistory,
  getIceServers,
  getMessages,
  getProfessional,
  listConversations,
  listProfessionals,
  markConversationRead,
  openConversation,
  postMessage,
  registerDevice,
  unregisterDevice,
} from '../controllers/assistance.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import {
  markReadSchema,
  registerDeviceSchema,
  sendMessageSchema,
} from '../validators/assistance.validator.js';

/**
 * Everything behind the Assistance tab.
 *
 * All of it requires a signed-in user: coach portfolios are a paid product
 * surface, and every conversation and call endpoint is scoped to the
 * caller's own id, taken from the token rather than the request.
 */
const professionals = Router();
professionals.use(requireAuth);
professionals.get('/', listProfessionals);
professionals.get('/:id', getProfessional);
professionals.post('/:id/conversation', openConversation);

const conversations = Router();
conversations.use(requireAuth);
conversations.get('/', listConversations);
conversations.get('/:id/messages', getMessages);
conversations.post('/:id/messages', validate(sendMessageSchema), postMessage);
conversations.post('/:id/read', validate(markReadSchema), markConversationRead);

const calls = Router();
calls.use(requireAuth);
calls.get('/ice-servers', getIceServers);
calls.get('/history', getCallHistory);
calls.post('/:callId/end', endCall);

const devices = Router();
devices.use(requireAuth);
devices.post('/', validate(registerDeviceSchema), registerDevice);
devices.delete('/:token', unregisterDevice);

export { calls, conversations, devices, professionals };
