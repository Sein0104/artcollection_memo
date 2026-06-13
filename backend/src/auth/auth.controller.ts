import { Controller, Get, Post, Query, Req, Res } from "@nestjs/common";
import { AuthService } from "./auth.service";

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get("auth/google")
  google(@Res() response: any) {
    try {
      const { url, cookie } = this.auth.startGoogleLogin();
      response.setHeader("Set-Cookie", cookie);
      return response.redirect(url);
    } catch {
      return response.redirect(this.auth.frontendRedirectUrl("#login"));
    }
  }

  @Get("auth/google/status")
  googleStatus() {
    return this.auth.googleStatus();
  }

  @Get("auth/google/callback")
  async googleCallback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
    @Req() request: any,
    @Res() response: any,
  ) {
    if (error) return response.redirect(this.auth.frontendRedirectUrl("#login"));

    try {
      const result = await this.auth.completeGoogleLogin({
        code,
        state,
        cookieHeader: request.headers.cookie,
      });
      response.setHeader("Set-Cookie", result.cookies);
      return response.redirect(this.auth.frontendRedirectUrl("#scan"));
    } catch {
      return response.redirect(this.auth.frontendRedirectUrl("#login"));
    }
  }

  @Get("auth/me")
  me(@Req() request: any) {
    return this.auth.stateFromCookie(request.headers.cookie);
  }

  @Get("auth/state")
  state(@Req() request: any) {
    return this.auth.stateFromCookie(request.headers.cookie);
  }

  @Post("auth/logout")
  async logout(@Req() request: any, @Res({ passthrough: true }) response: any) {
    const result = await this.auth.logout(request.headers.cookie);
    response.setHeader("Set-Cookie", result.cookie);
    return result.session;
  }
}
