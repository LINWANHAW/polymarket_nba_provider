declare module "@x402/express" {
  import type { RequestHandler } from "express";

  export type RoutesConfig = Record<string, unknown>;

  export class x402ResourceServer {
    constructor(facilitator: unknown);
    register(network: string, scheme: unknown): this;
  }

  export function paymentMiddleware(
    routes: RoutesConfig,
    server: x402ResourceServer
  ): RequestHandler;
}

declare module "@x402/core/server" {
  export interface FacilitatorConfig {
    url?: string;
    createAuthHeaders?: () => Promise<{
      verify: Record<string, string>;
      settle: Record<string, string>;
      supported: Record<string, string>;
    }>;
  }

  export class HTTPFacilitatorClient {
    constructor(config?: FacilitatorConfig);
  }
}

declare module "@x402/evm/exact/server" {
  export class ExactEvmScheme {
    constructor();
  }
}
