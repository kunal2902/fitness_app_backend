# Fitness App — backend (Phase 1)

Express 5 + TypeScript + Mongoose. Covers authentication and the onboarding
fitness profile; workouts, community and subscriptions mount into the same
router in later phases.

---

## Setup

```bash
cd C:\fitness-app\app_backend
npm install
cp .env.example .env      # then edit it
npm run dev               # tsx watch, restarts on save
```

Check it is alive:

```bash
curl http://localhost:3000/api/v1/health
```

### `.env`

The existing `.env` has `MONGO_URI=mongodb://localhost:27017/` with **no
database name**, which silently lands everything in Mongo's default `test`
database. Add one:

```
MONGO_URI=mongodb://127.0.0.1:27017/fitness_app
```

`MONGODB_URI` is accepted as an alias if you prefer that spelling.

Before deploying, replace both JWT secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

In production the server **refuses to boot** without them, rather than
falling back to a well-known development value.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Watch mode |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run selfcheck` | 48 checks that need no database |
| `npm run smoke` | Full auth round-trip against a real MongoDB |
| `npm test` | typecheck + selfcheck |

`npm run smoke` uses a separate `fitness_app_test` database and drops it at
the end, so your dev data is untouched.

---

## API

Base path `/api/v1`. Every response is enveloped:

```jsonc
// success
{ "success": true, "message": "Account created", "data": { /* ... */ } }

// failure
{ "success": false, "message": "…", "code": "EMAIL_TAKEN",
  "errors": { "email": "An account with this email already exists" } }
```

`errors` is keyed by **form field name** — including for nested failures
(`fitnessProfile.heightCm` is reported as `heightCm`), so the Flutter form
can highlight the exact input regardless of which validation layer rejected
it.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | — | Liveness + database state |
| `POST` | `/auth/signup` | — | Create account **and** fitness profile |
| `POST` | `/auth/login` | — | `identifier` accepts username or email |
| `POST` | `/auth/refresh` | — | Rotate the token pair |
| `POST` | `/auth/logout` | — | Revoke this device's refresh token |
| `GET` | `/auth/me` | Bearer | Current user |
| `GET` | `/auth/check-availability` | — | `?username=&email=` |

### `POST /auth/signup`

```jsonc
{
  "username": "iron_kunal",
  "fullName": "Kunal Bhardwaj",
  "email": "kunal@example.com",
  "password": "strongpass1",
  "fitnessProfile": {
    "gender": "male",                    // male | female
    "heightCm": 178,                     // canonical, 120–230
    "heightUnit": "cm",                  // cm | in — display only
    "weightKg": 74.5,                    // canonical, 30–200
    "weightUnit": "kg",                  // kg | lbs — display only
    "goals": ["build_strength", "learn_calisthenics"],   // 1–3
    "maxPullUps": "11_15",               // lt_6 | 6_10 | 11_15 | gt_15
    "maxPushUps": "21_30",               // lt_11 | 11_20 | 21_30 | gt_30
    "maxSquats": "31_40",                // lt_21 | 21_30 | 31_40 | gt_40
    "maxDips": "9_15",                   // lt_9 | 9_15 | 16_25 | gt_25
    "fitnessLevel": "intermediate"       // newbie | beginner | intermediate | advanced
  }
}
```

Returns `201` with `{ user, tokens: { accessToken, refreshToken } }`.

> These enum strings are the contract with the client. They must stay
> byte-identical to `apiValue` in `app_frontend/lib/models/enums.dart` —
> changing one on either side alone breaks signup.

Goals are capped at 3 so the future programme generator has a priority
rather than "everything".

---

## Layout

```
src/
├── index.ts                 Boot: connect DB → listen → graceful shutdown
├── app.ts                   Express wiring (helmet, cors, routes, errors)
├── config/env.ts            Validated environment, fails loudly at boot
├── models/
│   ├── user.model.ts        User + embedded fitness profile + enums
│   └── refreshToken.model.ts
├── validators/              Zod schemas — the authority on input shape
├── middleware/              auth, validate, error, rateLimit
├── controllers/             Thin: parse → delegate → respond
├── services/auth.service.ts All the auth business logic
├── routes/                  Router composition
└── utils/                   ApiError, envelope, asyncHandler, jwt, db
```

---

## Security notes

- Passwords: bcrypt, 12 rounds by default. `passwordHash` has
  `select: false` **and** is stripped in the `toJSON` transform, so it
  cannot leak even if a query selects it.
- Login returns the same message for "no such user" and "wrong password",
  so the endpoint is not a user-enumeration oracle.
- Refresh tokens rotate on every use and are stored server-side by `jti`.
  Presenting an already-rotated token revokes the **whole chain** for that
  user, on the assumption the token leaked.
- Signup and login are rate-limited to 10 attempts per 15 minutes in
  production (relaxed in development so you can test repeatedly).
- `trust proxy` is on so `req.ip` is the real client behind a load
  balancer — the rate limiter depends on it.

### Still to do before production

- Email verification (`isEmailVerified` exists but nothing sets it).
- Password reset.
- Refresh-token revocation on password change.
- Structured logging (morgan is dev-only right now).
