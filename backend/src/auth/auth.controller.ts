import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { AuthDto } from "./dto";
import { AuthService } from "./auth.service";

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("auth/signup")
  signup(@Body() body: AuthDto) {
    return this.auth.signup(body.nickname, body.password);
  }

  @Post("auth/login")
  login(@Body() body: AuthDto) {
    return this.auth.login(body.nickname, body.password);
  }

  @Get("auth/state")
  state(@Query("nickname") nickname: string) {
    return this.auth.state(nickname);
  }
}
