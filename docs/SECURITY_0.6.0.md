# Security hardening — 0.6.0

This release hardens the portal against the major OWASP Top 10:2025 classes that are directly applicable to the current Fastify application. It is not a substitute for an external penetration test.

## Implemented

- Defensive HTTP headers: CSP, HSTS when HTTPS cookies are enabled, `X-Content-Type-Options`, `X-Frame-Options`, strict referrer policy, Permissions Policy, COOP and CORP.
- Same-origin protection for browser cookie-authenticated state-changing API requests.
- In-process request throttling, with a much tighter window for login/password-reset/set-password endpoints.
- Stronger password policy: 12–128 characters plus upper-case, lower-case and numeric characters.
- Stronger scrypt password hashing for new/reset passwords, with transparent upgrade of legacy hashes after successful login.
- Password-reset/setup tokens are stored as SHA-256 digests; existing plaintext tokens remain temporarily compatible so existing links are not broken.
- Password reset invalidates existing sessions for the account.
- Expired sessions are deleted opportunistically when encountered.
- Fixed an authorization gap in score-history: users must be entitled to the requested employer, not merely signed in.
- Mobile/tablet/laptop/desktop responsive layer with touch targets, reduced accidental horizontal overflow, accessible focus states, reduced-motion support, and responsive analytical grids.

## Still recommended before production

- Run `npm audit --audit-level=high` in CI and pin/upgrade dependencies based on the resulting advisory set.
- Add centralized distributed rate limiting (Redis) if the app is scaled horizontally; the current limiter is process-local.
- Add automated dependency update/lockfile review and secret scanning in CI.
- Perform a production penetration test and verify Railway database/network permissions.
- Keep database credentials and integration secrets in Railway Variables; Railway supports sealed variables for values that should not be retrievable from the UI/API.
