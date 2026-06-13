import { ConflictException, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../prisma.service";

const SESSION_COOKIE_NAME = "artcatch_session";
const OAUTH_STATE_COOKIE_NAME = "artcatch_oauth_state";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;
const OAUTH_STATE_MAX_AGE_SECONDS = 60 * 10;

const EMPTY_USER_STATE = {
  points: 0,
  totalEarnedPoints: 0,
  installedRewardId: null,
  collection: [],
  missionCollection: [],
  purchases: [],
};

type GoogleProfile = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  picture?: unknown;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async signup(nickname: string, password: string) {
    const existing = await this.prisma.user.findUnique({ where: { nickname } });
    if (existing && existing.passwordHash !== "seed") {
      throw new ConflictException("nickname_taken");
    }

    const { hash, salt } = this.hashPassword(password);
    const user = existing
      ? await this.prisma.user.update({
          where: { nickname },
          data: { passwordHash: hash, passwordSalt: salt },
        })
      : await this.prisma.user.create({
          data: { nickname, passwordHash: hash, passwordSalt: salt },
        });

    return this.sessionForUser(user.id);
  }

  async login(nickname: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { nickname } });
    if (!user || !this.verifyPassword(password, user.passwordSalt, user.passwordHash)) {
      throw new UnauthorizedException("login_failed");
    }
    return this.sessionForUser(user.id);
  }

  async stateFromCookie(cookieHeader?: string) {
    const token = this.readCookie(cookieHeader, SESSION_COOKIE_NAME);
    if (!token) return this.emptySession();

    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { user: true },
    });
    if (!session) return this.emptySession();

    if (session.expiresAt.getTime() <= Date.now()) {
      await this.prisma.authSession.delete({ where: { id: session.id } }).catch(() => undefined);
      return this.emptySession();
    }

    return this.sessionForUser(session.userId);
  }

  startGoogleLogin() {
    const clientId = this.googleClientId();
    if (!this.isGoogleConfigured()) throw new ServiceUnavailableException("google_oauth_not_configured");

    const state = randomBytes(24).toString("base64url");
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.googleCallbackUrl(),
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });

    return {
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      cookie: this.buildCookie(OAUTH_STATE_COOKIE_NAME, state, OAUTH_STATE_MAX_AGE_SECONDS),
    };
  }

  async completeGoogleLogin({ code, state, cookieHeader }: { code?: string; state?: string; cookieHeader?: string }) {
    const expectedState = this.readCookie(cookieHeader, OAUTH_STATE_COOKIE_NAME);
    if (!code || !state || !expectedState || !this.safeEqual(state, expectedState)) {
      throw new UnauthorizedException("google_oauth_state_invalid");
    }

    const profile = await this.fetchGoogleProfile(code);
    const user = await this.findOrCreateGoogleUser(profile);
    const token = await this.createSession(user.id);

    return {
      session: await this.sessionForUser(user.id),
      cookies: [
        this.buildCookie(SESSION_COOKIE_NAME, token, SESSION_MAX_AGE_SECONDS),
        this.clearCookie(OAUTH_STATE_COOKIE_NAME),
      ],
    };
  }

  async logout(cookieHeader?: string) {
    const token = this.readCookie(cookieHeader, SESSION_COOKIE_NAME);
    if (token) {
      await this.prisma.authSession.deleteMany({ where: { tokenHash: this.hashToken(token) } });
    }
    return {
      session: this.emptySession(),
      cookie: this.clearCookie(SESSION_COOKIE_NAME),
    };
  }

  frontendRedirectUrl(hash: "#scan" | "#login" = "#scan") {
    const origin = (this.config.get<string>("FRONTEND_ORIGIN") || "http://127.0.0.1:5173").replace(/\/$/, "");
    return `${origin}/${hash}`;
  }

  googleStatus() {
    return {
      configured: this.isGoogleConfigured(),
      callbackUrl: this.googleCallbackUrl(),
    };
  }

  async userState(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { collections: true, purchases: true },
    });
    if (!user) throw new UnauthorizedException("login_required");
    return {
      points: user.points,
      totalEarnedPoints: user.totalEarnedPoints,
      installedRewardId: user.installedRewardId,
      collection: user.collections
        .filter((entry) => entry.source === "GENERAL")
        .map((entry) => ({
          artworkId: entry.artworkId,
          source: "일반",
          createdAt: entry.createdAt,
        })),
      missionCollection: user.collections
        .filter((entry) => entry.source === "MISSION")
        .map((entry) => ({
          artworkId: entry.artworkId,
          source: "미션",
          dateKey: entry.missionKey,
          createdAt: entry.createdAt,
        })),
      purchases: user.purchases.map((purchase) => purchase.artworkId),
    };
  }

  private async sessionForUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("login_required");
    return {
      user: {
        id: user.id,
        nickname: user.nickname,
        email: user.email,
        avatarUrl: user.avatarUrl,
      },
      state: await this.userState(user.id),
    };
  }

  private emptySession() {
    return { user: null, state: EMPTY_USER_STATE };
  }

  private async fetchGoogleProfile(code: string) {
    const clientId = this.googleClientId();
    const clientSecret = this.googleClientSecret();
    if (!clientId || !clientSecret) throw new ServiceUnavailableException("google_oauth_not_configured");

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: this.googleCallbackUrl(),
        grant_type: "authorization_code",
      }),
    });
    const tokenPayload = (await tokenResponse.json().catch(() => ({}))) as Record<string, unknown>;
    if (!tokenResponse.ok || typeof tokenPayload.access_token !== "string") {
      throw new UnauthorizedException("google_oauth_token_failed");
    }

    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
    });
    const profile = (await profileResponse.json().catch(() => ({}))) as GoogleProfile;
    if (!profileResponse.ok || typeof profile.sub !== "string") {
      throw new UnauthorizedException("google_profile_failed");
    }
    if (profile.email_verified === false) {
      throw new UnauthorizedException("google_email_unverified");
    }

    return {
      googleId: profile.sub,
      email: typeof profile.email === "string" ? profile.email : null,
      name: typeof profile.name === "string" ? profile.name : "",
      picture: typeof profile.picture === "string" ? profile.picture : null,
    };
  }

  private async findOrCreateGoogleUser(profile: { googleId: string; email: string | null; name: string; picture: string | null }) {
    const byGoogleId = await this.prisma.user.findUnique({ where: { googleId: profile.googleId } });
    if (byGoogleId) {
      return this.prisma.user.update({
        where: { id: byGoogleId.id },
        data: {
          email: profile.email,
          avatarUrl: profile.picture,
        },
      });
    }

    const byEmail = profile.email ? await this.prisma.user.findUnique({ where: { email: profile.email } }) : null;
    if (byEmail) {
      return this.prisma.user.update({
        where: { id: byEmail.id },
        data: {
          googleId: profile.googleId,
          avatarUrl: profile.picture,
        },
      });
    }

    return this.prisma.user.create({
      data: {
        nickname: await this.uniqueGoogleNickname(profile.name, profile.email, profile.googleId),
        googleId: profile.googleId,
        email: profile.email,
        avatarUrl: profile.picture,
        passwordHash: "google",
        passwordSalt: "google",
      },
    });
  }

  private async uniqueGoogleNickname(name: string, email: string | null, googleId: string) {
    const fallback = email?.split("@")[0] || `u${googleId.slice(-6)}`;
    const rawBase = (name || fallback).normalize("NFKC").replace(/\s+/g, "");
    const cleaned = rawBase.replace(/[^\p{L}\p{N}_-]/gu, "") || "user";
    const base = cleaned.slice(0, 7);

    for (let index = 0; index < 100; index += 1) {
      const suffix = index ? String(index) : "";
      const candidate = `${base.slice(0, Math.max(1, 7 - suffix.length))}${suffix}`;
      const existing = await this.prisma.user.findUnique({ where: { nickname: candidate } });
      if (!existing) return candidate;
    }

    return `u${randomBytes(3).toString("hex")}`.slice(0, 7);
  }

  private async createSession(userId: string) {
    await this.prisma.authSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    const token = randomBytes(32).toString("base64url");
    await this.prisma.authSession.create({
      data: {
        userId,
        tokenHash: this.hashToken(token),
        expiresAt: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000),
      },
    });
    return token;
  }

  private googleClientId() {
    return this.config.get<string>("GOOGLE_CLIENT_ID")?.trim() || "";
  }

  private googleClientSecret() {
    return this.config.get<string>("GOOGLE_CLIENT_SECRET")?.trim() || "";
  }

  private isGoogleConfigured() {
    return Boolean(this.googleClientId() && this.googleClientSecret());
  }

  private googleCallbackUrl() {
    const explicit = this.config.get<string>("GOOGLE_CALLBACK_URL") || this.config.get<string>("GOOGLE_REDIRECT_URI");
    if (explicit?.trim()) return explicit.trim();

    const port = this.config.get<string>("PORT") || "3001";
    return `http://127.0.0.1:${port}/auth/google/callback`;
  }

  private hashPassword(password: string) {
    const salt = randomBytes(16).toString("hex");
    return { salt, hash: scryptSync(password, salt, 32).toString("hex") };
  }

  private verifyPassword(password: string, salt: string, expectedHash: string) {
    if (expectedHash === "seed" || expectedHash === "google") return false;
    const actual = Buffer.from(scryptSync(password, salt, 32).toString("hex"), "hex");
    const expected = Buffer.from(expectedHash, "hex");
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  }

  private hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  private readCookie(cookieHeader: string | undefined, name: string) {
    if (!cookieHeader) return "";
    const prefix = `${name}=`;
    const part = cookieHeader
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(prefix));
    if (!part) return "";
    return decodeURIComponent(part.slice(prefix.length));
  }

  private buildCookie(name: string, value: string, maxAgeSeconds: number) {
    const parts = [
      `${name}=${encodeURIComponent(value)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (this.secureCookies()) parts.push("Secure");
    return parts.join("; ");
  }

  private clearCookie(name: string) {
    const parts = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
    if (this.secureCookies()) parts.push("Secure");
    return parts.join("; ");
  }

  private secureCookies() {
    const explicit = this.config.get<string>("COOKIE_SECURE")?.toLowerCase();
    if (explicit === "true") return true;
    if (explicit === "false") return false;
    return (this.config.get<string>("FRONTEND_ORIGIN") || "").startsWith("https://");
  }

  private safeEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }
}
