import { Body, Controller, Post, Req } from "@nestjs/common";
import { AiDocentService } from "./ai-docent.service";
import { AskDocentDto } from "./dto";

type RequestWithCookie = {
  headers: {
    cookie?: string;
  };
};

@Controller("ai-docent")
export class AiDocentController {
  constructor(private readonly docent: AiDocentService) {}

  @Post("chat")
  chat(@Body() body: AskDocentDto, @Req() request: RequestWithCookie) {
    return this.docent.chat(body, request.headers.cookie);
  }
}
