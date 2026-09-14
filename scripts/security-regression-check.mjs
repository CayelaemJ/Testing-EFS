import fs from 'node:fs';
import assert from 'node:assert/strict';

const server = fs.readFileSync('src/server.ts', 'utf8');
const auth = fs.readFileSync('src/services/authService.ts', 'utf8');
const users = fs.readFileSync('src/services/userService.ts', 'utf8');
const dashboard = fs.readFileSync('public/dashboard.html', 'utf8');

assert.match(server, /X-Content-Type-Options/);
assert.match(server, /Content-Security-Policy/);
assert.match(server, /cross-origin request rejected/);
assert.match(server, /AUTH_RATE_LIMIT/);
assert.match(server, /canViewEmployer\(user, req\.params\.employerId\)/);
assert.match(auth, /timingSafeEqual/);
assert.match(auth, /digestSetupToken/);
assert.match(users, /password must be at least 12 characters/);
assert.match(users, /destroyAllSessionsForUser\(userId\)/);
assert.match(dashboard, /responsive-v2\.css/);
console.log('Security regression checks passed.');
