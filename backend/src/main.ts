import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { createX402Middleware } from "./infra/x402/x402.middleware";
import helmet from "helmet";
import { NestExpressApplication } from "@nestjs/platform-express";

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    // Accept values like "https://localhost:3001/" or "https://example.com/path"
    // and normalize them to a comparable Origin string.
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

async function bootstrap() {
  const isProd = process.env.NODE_ENV === "production";
  const corsOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",")
        .map((origin) => normalizeOrigin(origin))
        .filter(Boolean)
    : [];

  // In production, require an explicit allowlist. In non-prod, default to allow-all for local dev.
  const allowAllOrigins = !isProd && corsOrigins.length === 0;
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: {
      origin: (origin, cb) => {
        // Allow non-browser clients (curl, server-to-server) with no Origin header.
        if (!origin) return cb(null, true);
        const normalized = normalizeOrigin(origin);
        if (allowAllOrigins) return cb(null, true);
        if (corsOrigins.includes(normalized)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "PAYMENT-SIGNATURE",
        "X-PAYMENT",
        "X-CHAIN-ID",
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

  // Needed when running behind nginx / a load balancer.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(
    helmet({
      // Avoid breaking Swagger and other dynamic pages; add CSP at nginx if you want stricter control.
      contentSecurityPolicy: false
    })
  );

  const swaggerEnabled = !isProd || process.env.SWAGGER_ENABLED === "true";
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("Polymarket NBA API")
      .setDescription(
        "Backend API documentation for NBA ingestion and Polymarket sync."
      )
      .setVersion("0.1.0")
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup("docs", app, document);
  }

  const x402Middleware = createX402Middleware();
  if (x402Middleware) {
    app.use(x402Middleware);
  }

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
}

bootstrap();
