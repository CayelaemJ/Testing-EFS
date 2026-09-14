// ════════════════════════════════════════════════════════════════════
//  AUTH SERVICE
//  Password hashing (scrypt, built into Node — no native deps to break the
//  Railway build), session tokens, login, and access-control helpers.
//
//  Access model:
//    • Role gates which MODULES you reach (admin console / dashboard / portfolio).
//    • UserEmployer links gate WHICH employers you see.
//    • ADMIN bypasses the links entirely (sees everything).
//  This same link table will power the future broker view with no rework.
// ════════════════════════════════════════════════════════════════════

import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const prisma = new PrismaClient();

const SESSION_DAYS = 7;          // default session length
const SESSION_DAYS_REMEMBER = 30; // "remember me" session length

// ── password hashing (scrypt) ──
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }).toString("hex");
  return `v2$${salt}:${hash}`;
}
export function verifyPassword(plain: string, stored: string): boolean {
  const v2 = stored.startsWith("v2$");
  const encoded = v2 ? stored.slice(3) : stored;
  const [salt, hash] = encoded.split(":");
  if (!salt || !hash) return false;
  const candidate = v2
    ? scryptSync(plain, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM })
    : scryptSync(plain, salt, 64);
  const original = Buffer.from(hash, "hex");
  return candidate.length === original.length && timingSafeEqual(candidate, original);
}

// Setup/reset tokens are high-entropy secrets. Store only a SHA-256 digest so
// a database read does not immediately expose a live password-reset link.
export function digestSetupToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// ── sessions ──
export async function createSession(userId: string, days: number = SESSION_DAYS) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + days * 864e5);
  await prisma.session.create({ data: { userId, token, expiresAt } });
  return { token, expiresAt };
}

export async function resolveSession(token?: string) {
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { token },
    include: { user: { include: { links: true } } },
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await prisma.session.deleteMany({ where: { token } });
    return null;
  }
  if (!session.user.active) return null;
  return session.user;
}

export async function destroySession(token?: string) {
  if (!token) return;
  await prisma.session.deleteMany({ where: { token } });
}

// used when an account is deactivated (self or admin) so access ends immediately
// rather than waiting for the existing session to expire
export async function destroyAllSessionsForUser(userId: string) {
  await prisma.session.deleteMany({ where: { userId } });
}

// ── login ──
// `remember` controls session lifetime: 30 days when the user checked "Remember
// me", 7 days otherwise. The cookie itself (persistent vs session-only) is set
// by the caller in server.ts, based on the same flag.
export async function login(email: string, password: string, remember: boolean = false) {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user || !user.active || !user.passwordHash) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  // Successful login upgrades legacy password hashes to the stronger v2 scrypt
  // parameters without forcing a password reset for existing users.
  if (!user.passwordHash.startsWith("v2$")) {
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(password) } });
  }
  const { token, expiresAt } = await createSession(user.id, remember ? SESSION_DAYS_REMEMBER : SESSION_DAYS);
  return { user, token, expiresAt };
}

// ── access helpers ──
export type AuthUser = NonNullable<Awaited<ReturnType<typeof resolveSession>>>;

export function isAdmin(user: AuthUser) {
  return user.role === "ADMIN";
}

/** employer ids this user may see. Admin => null meaning "all". */
export function allowedEmployerIds(user: AuthUser): string[] | null {
  if (user.role === "ADMIN") return null; // all
  return (user.links ?? []).map((l: any) => l.employerId);
}

/** can this user view a specific employer's dashboard? */
export function canViewEmployer(user: AuthUser, employerId: string): boolean {
  if (user.role === "ADMIN") return true;
  if (user.role !== "EMPLOYER_VIEW" && user.role !== "PORTFOLIO_VIEW") return false;
  return (user.links ?? []).some((l: any) => l.employerId === employerId);
}

export function canAccessModule(user: AuthUser, module: "admin" | "dashboard" | "portfolio"): boolean {
  if (user.role === "ADMIN") return true;
  if (module === "admin") return false; // only admins
  if (module === "dashboard") return user.role === "EMPLOYER_VIEW" || user.role === "PORTFOLIO_VIEW";
  if (module === "portfolio") return user.role === "PORTFOLIO_VIEW";
  return false;
}

export { prisma };
