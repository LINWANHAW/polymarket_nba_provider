import { Controller, Get } from "@nestjs/common";

@Controller("x402")
export class X402Controller {
  @Get("one-time")
  getOneTimeAccess() {
    return {
      ok: true,
      message: "Access granted (paid once per session).",
      timestamp: new Date().toISOString()
    };
  }
}
