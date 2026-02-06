import { Module } from "@nestjs/common";
import { X402Controller } from "./x402.controller";

@Module({
  controllers: [X402Controller]
})
export class X402Module {}
