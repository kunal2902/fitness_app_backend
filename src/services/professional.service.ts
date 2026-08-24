import mongoose from 'mongoose';

import {
  Professional,
  toPublicProfessional,
  type PublicProfessional,
} from '../models/professional.model.js';
import { presence } from '../realtime/presence.js';
import { ApiError } from '../utils/apiError.js';

export const professionalService = {
  /** Published coaches, in curated order. */
  async list(): Promise<PublicProfessional[]> {
    const docs = await Professional.find({ isPublished: true }).sort({
      sortOrder: 1,
      createdAt: 1,
    });

    return docs.map((doc) =>
      toPublicProfessional(doc, presence.snapshot(doc.user.toString())),
    );
  },

  async getById(id: string): Promise<PublicProfessional> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw ApiError.notFound('Professional not found', 'NO_PRO');
    }

    const doc = await Professional.findById(id);
    if (!doc || !doc.isPublished) {
      throw ApiError.notFound('Professional not found', 'NO_PRO');
    }

    return toPublicProfessional(doc, presence.snapshot(doc.user.toString()));
  },

  /** Resolves a profile id to the login it belongs to, for conversations. */
  async userIdFor(professionalId: string): Promise<mongoose.Types.ObjectId> {
    if (!mongoose.Types.ObjectId.isValid(professionalId)) {
      throw ApiError.notFound('Professional not found', 'NO_PRO');
    }
    const doc = await Professional.findById(professionalId);
    if (!doc || !doc.isPublished) {
      throw ApiError.notFound('Professional not found', 'NO_PRO');
    }
    return doc.user;
  },
};
