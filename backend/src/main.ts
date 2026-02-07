import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { createX402Middleware } from "./infra/x402/x402.middleware";

async function bootstrap() {
  const corsOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    : [];
  const app = await NestFactory.create(AppModule, {
    cors: {
      origin: corsOrigins.length ? corsOrigins : true,
      credentials: true,
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "PAYMENT-SIGNATURE",
        "X-PAYMENT",
        "Access-Control-Expose-Headers"
      ],
      exposedHeaders: [
        "PAYMENT-REQUIRED",
        "PAYMENT-RESPONSE",
        "X-PAYMENT-RESPONSE",
        "X402-DEBUG-HAS-PAYMENT",
        "X402-DEBUG-PAYMENT-LEN"
      ]
    }
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Polymarket NBA API")
    .setDescription("Backend API documentation for NBA ingestion and Polymarket sync.")
    .setVersion("0.1.0")
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("docs", app, document);

  const x402Middleware = createX402Middleware();
  if (x402Middleware) {
    app.use(x402Middleware);
  }

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
}

bootstrap();
