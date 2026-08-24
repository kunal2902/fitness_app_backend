/**
 * Creates (or updates) the coaching team.
 *
 * Idempotent: run it as often as you like. Accounts are matched on email,
 * profiles on the user they belong to, so re-running refreshes the
 * portfolio content without duplicating anyone or resetting passwords.
 *
 * Run with:  npm run seed:pros
 */
import mongoose from 'mongoose';

import { env } from '../src/config/env.js';
import {
  Professional,
  type IProfessional,
} from '../src/models/professional.model.js';
import { User } from '../src/models/user.model.js';
import { connectToDB, disconnectFromDB } from '../src/utils/dbConnect.js';

interface Seed {
  username: string;
  fullName: string;
  email: string;
  /** Only used when the account is created for the first time. */
  initialPassword: string;
  profile: Omit<IProfessional, 'user' | 'createdAt' | 'updatedAt'>;
}

const SEEDS: Seed[] = [
  {
    username: 'coach_dhruv',
    fullName: 'Dhruv Sharma',
    email: 'dhruv@fitnessapp.com',
    initialPassword: 'changeme123',
    profile: {
      displayName: 'Dhruv Sharma',
      headline: 'Calisthenics & bodyweight strength coach',
      bio:
        'I got into calisthenics because I could not afford a gym, and I ' +
        'stayed because nothing else builds control like your own bodyweight. ' +
        'Ten years later I have coached over 400 people from their first ' +
        'hanging knee raise to a clean muscle-up. My approach is unglamorous: ' +
        'progressions you can actually hold, volume you can actually recover ' +
        'from, and a plan that survives a bad week.',
      avatarUrl: null,
      specialities: ['calisthenics', 'strength', 'mobility'],
      languages: ['English', 'Hindi'],
      yearsExperience: 10,
      certifications: [
        {
          title: 'Certified Strength & Conditioning Specialist (CSCS)',
          issuer: 'NSCA',
          year: 2018,
          credentialUrl: null,
        },
        {
          title: 'Level 3 Calisthenics Coach',
          issuer: 'World Calisthenics Organization',
          year: 2019,
          credentialUrl: null,
        },
        {
          title: 'Functional Range Conditioning (FRC) Mobility Specialist',
          issuer: 'Functional Anatomy Seminars',
          year: 2021,
          credentialUrl: null,
        },
      ],
      transformations: [
        {
          clientName: 'Arjun M.',
          durationLabel: '16 weeks',
          summary:
            'Came in unable to do a single strict pull-up after two years of ' +
            'machine-only training. Finished with 12 strict reps and his first ' +
            'muscle-up.',
          beforeImageUrl: null,
          afterImageUrl: null,
          highlights: [
            '0 to 12 strict pull-ups',
            'First muscle-up in week 14',
            'Lost 7 kg while gaining upper-body size',
          ],
        },
        {
          clientName: 'Priya K.',
          durationLabel: '24 weeks',
          summary:
            'Returned to training after a shoulder injury. Rebuilt overhead ' +
            'capacity from scratch with a rehab-first progression, then moved ' +
            'into full handstand work.',
          beforeImageUrl: null,
          afterImageUrl: null,
          highlights: [
            'Pain-free overhead range restored',
            '45-second freestanding handstand',
            'Zero flare-ups across the whole block',
          ],
        },
      ],
      achievements: [
        {
          title: 'National Calisthenics Championship — 2nd place',
          description:
            'Placed second in the freestyle category at the 2022 national ' +
            'championship in Mumbai.',
          year: 2022,
        },
        {
          title: '400+ clients coached',
          description:
            'Across in-person and remote programming since 2016, with a 91% ' +
            'programme completion rate.',
          year: null,
        },
      ],
      sessionRateMinor: 150000,
      currency: 'INR',
      ratingAverage: 4.9,
      ratingCount: 187,
      clientsCoached: 412,
      isAcceptingClients: true,
      isPublished: true,
      sortOrder: 1,
    },
  },
  {
    username: 'coach_kunal',
    fullName: 'Kunal Bhardwaj',
    email: 'kunal.coach@fitnessapp.com',
    initialPassword: 'changeme123',
    profile: {
      displayName: 'Kunal Bhardwaj',
      headline: 'Strength, hypertrophy & fat-loss coach',
      bio:
        'I work with people who are busy and tired of programmes written for ' +
        'someone with four spare hours a day. Most of my clients train three ' +
        'or four times a week around a job, and still add serious strength. ' +
        'I plan around your actual week, not an ideal one, and I would rather ' +
        'give you something boring you will finish than something clever you ' +
        'will quit.',
      avatarUrl: null,
      specialities: ['strength', 'muscle_gain', 'weight_loss', 'nutrition'],
      languages: ['English', 'Hindi', 'Punjabi'],
      yearsExperience: 8,
      certifications: [
        {
          title: 'Certified Personal Trainer (CPT)',
          issuer: 'ACE',
          year: 2017,
          credentialUrl: null,
        },
        {
          title: 'Precision Nutrition Level 1',
          issuer: 'Precision Nutrition',
          year: 2020,
          credentialUrl: null,
        },
        {
          title: 'Certified Sports Nutritionist (CISSN)',
          issuer: 'International Society of Sports Nutrition',
          year: 2022,
          credentialUrl: null,
        },
      ],
      transformations: [
        {
          clientName: 'Rohit S.',
          durationLabel: '20 weeks',
          summary:
            'Desk job, two young kids, three sessions a week. Recomposition ' +
            'without a crash diet — down 11 kg of fat while adding strength on ' +
            'every main lift.',
          beforeImageUrl: null,
          afterImageUrl: null,
          highlights: [
            '-11 kg fat mass, +2 kg lean mass',
            'Deadlift 90 kg to 145 kg',
            'Never trained more than 4 hours a week',
          ],
        },
        {
          clientName: 'Meera T.',
          durationLabel: '12 weeks',
          summary:
            'First structured programme after years of cardio-only training. ' +
            'Built a base of real strength and finally stopped fearing the ' +
            'squat rack.',
          beforeImageUrl: null,
          afterImageUrl: null,
          highlights: [
            'First bodyweight squat for reps',
            '+6 kg lean mass',
            'Resting heart rate down 9 bpm',
          ],
        },
      ],
      achievements: [
        {
          title: 'Coached 3 athletes to national powerlifting qualification',
          description:
            'Three clients qualified for national-level powerlifting meets ' +
            'between 2021 and 2024.',
          year: 2024,
        },
        {
          title: 'Featured nutrition contributor',
          description:
            'Regular contributor on evidence-based nutrition for busy ' +
            'professionals.',
          year: 2023,
        },
      ],
      sessionRateMinor: 180000,
      currency: 'INR',
      ratingAverage: 4.8,
      ratingCount: 143,
      clientsCoached: 296,
      isAcceptingClients: true,
      isPublished: true,
      sortOrder: 2,
    },
  },
];

async function main(): Promise<void> {
  await connectToDB();
  console.log(`\nSeeding professionals into ${env.mongoUri}\n`);

  for (const seed of SEEDS) {
    let user = await User.findOne({ email: seed.email });

    if (!user) {
      user = await User.create({
        username: seed.username,
        fullName: seed.fullName,
        email: seed.email,
        // The pre-save hook hashes this.
        passwordHash: seed.initialPassword,
        role: 'professional',
        isEmailVerified: true,
      });
      console.log(`  + created account ${seed.email}`);
    } else if (user.role !== 'professional') {
      // Promote an existing account rather than refusing to seed.
      user.role = 'professional';
      await user.save({ validateBeforeSave: false });
      console.log(`  ~ promoted ${seed.email} to professional`);
    } else {
      console.log(`  = account ${seed.email} already exists`);
    }

    const existing = await Professional.findOne({ user: user._id });
    if (existing) {
      // Refresh curated content, leave engagement metrics alone if they
      // have started accumulating for real.
      Object.assign(existing, seed.profile, { user: user._id });
      await existing.save();
      console.log(`  ~ updated profile for ${seed.profile.displayName}`);
    } else {
      await Professional.create({ ...seed.profile, user: user._id });
      console.log(`  + created profile for ${seed.profile.displayName}`);
    }
  }

  const count = await Professional.countDocuments({ isPublished: true });
  console.log(`\nDone. ${count} published professional(s).\n`);
  console.log(
    'Sign-in for testing: the emails above with password "changeme123".\n' +
      'Change these before the app is public.\n',
  );

  await disconnectFromDB();
  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
