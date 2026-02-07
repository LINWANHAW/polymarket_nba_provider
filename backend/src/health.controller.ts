import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

@Controller("health")
@ApiTags("Health")
export class HealthController {
  @Get()
  @ApiOperation({ summary: "Health check" })
  @ApiOkResponse({
    description: "Service health status.",
    schema: {
      type: "object",
      properties: {
        status: { type: "string", example: "ok" }
      }
    }
  })
  health() {
    return {
      status: "ok"
    };
  }
}
