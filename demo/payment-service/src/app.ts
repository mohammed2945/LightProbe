import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";

import {
  InsufficientFundsError,
  PaymentDatabaseError,
  type PaymentInput,
  PaymentProcessor,
  type UserTier,
} from "./payments.js";

export interface PaymentCounters {
  requests: number;
  succeeded: number;
  insufficientFunds: number;
  databaseErrors: number;
  invalidRequests: number;
  freeTierRequests: number;
  premiumTierRequests: number;
  enterpriseTierRequests: number;
  inFlight: number;
}

export interface PaymentAppOptions {
  serviceId: string;
  bugEnabled: boolean;
  processor: PaymentProcessor;
  log?: (line: string) => void;
}

const USER_TIERS = new Set<UserTier>(["free", "premium", "enterprise"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePaymentInput(value: unknown): PaymentInput | null {
  if (!isRecord(value) || !isRecord(value["user"])) {
    return null;
  }

  const user = value["user"];
  const id = user["id"];
  const tier = user["tier"];
  const amountCents = value["amountCents"];
  if (
    typeof id !== "string" ||
    id.length < 1 ||
    id.length > 100 ||
    typeof tier !== "string" ||
    !USER_TIERS.has(tier as UserTier) ||
    typeof amountCents !== "number" ||
    !Number.isSafeInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents > 1_000_000
  ) {
    return null;
  }

  return {
    user: { id, tier: tier as UserTier },
    amountCents,
  };
}

function requestId(request: Request, sequence: number): string {
  const supplied = request.header("x-request-id");
  if (supplied === undefined || supplied.length === 0 || supplied.length > 100) {
    return `req_${String(sequence).padStart(6, "0")}`;
  }
  return supplied.replace(/[^\w.-]/gu, "_");
}

export function createPaymentApp(options: PaymentAppOptions): Express {
  const app = express();
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const counters: PaymentCounters = {
    requests: 0,
    succeeded: 0,
    insufficientFunds: 0,
    databaseErrors: 0,
    invalidRequests: 0,
    freeTierRequests: 0,
    premiumTierRequests: 0,
    enterpriseTierRequests: 0,
    inFlight: 0,
  };

  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb", strict: true }));

  app.get("/health", (_request, response) => {
    response.status(200).json({
      status: "ok",
      serviceId: options.serviceId,
      bug: options.bugEnabled ? "on" : "off",
    });
  });

  app.get("/stats", (_request, response) => {
    response.status(200).json({
      serviceId: options.serviceId,
      bug: options.bugEnabled ? "on" : "off",
      counters: { ...counters },
      pool: {
        active: options.processor.pool.active,
        capacity: options.processor.pool.capacity,
      },
    });
  });

  app.post("/pay", async (request, response) => {
    counters.requests += 1;
    counters.inFlight += 1;
    const id = requestId(request, counters.requests);
    const startedAt = performance.now();
    let status = 500;
    let outcome = "InternalError";
    let tier = "invalid";

    try {
      const input = parsePaymentInput(request.body as unknown);
      if (input === null) {
        counters.invalidRequests += 1;
        status = 400;
        outcome = "InvalidPayment";
        response.status(status).json({
          requestId: id,
          error: {
            code: outcome,
            message: "user.id, user.tier, and a positive integer amountCents are required",
          },
        });
        return;
      }

      tier = input.user.tier;
      counters[`${input.user.tier}TierRequests`] += 1;
      const receipt = await options.processor.pay(input);
      counters.succeeded += 1;
      status = 201;
      outcome = "PaymentAccepted";
      response.status(status).json({ requestId: id, receipt });
    } catch (error: unknown) {
      if (error instanceof InsufficientFundsError) {
        counters.insufficientFunds += 1;
        status = 402;
        outcome = error.code;
        response.status(status).json({
          requestId: id,
          error: {
            code: error.code,
            message: error.message,
            amountCents: error.amountCents,
            availableBalanceCents: error.availableBalanceCents,
          },
        });
        return;
      }
      if (error instanceof PaymentDatabaseError) {
        counters.databaseErrors += 1;
        status = 503;
        outcome = error.code;
        response.status(status).json({
          requestId: id,
          error: { code: error.code, message: error.message },
        });
        return;
      }

      response.status(status).json({
        requestId: id,
        error: {
          code: outcome,
          message: "The payment could not be processed",
        },
      });
    } finally {
      counters.inFlight -= 1;
      const durationMs = Math.max(0, performance.now() - startedAt);
      log(
        `[payment] request=${id} tier=${tier} status=${String(status)} ` +
          `outcome=${outcome} durationMs=${durationMs.toFixed(1)} ` +
          `requests=${String(counters.requests)}`,
      );
    }
  });

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      const message =
        error instanceof SyntaxError ? "Request body must be valid JSON" : "Invalid request";
      response.status(400).json({
        error: { code: "InvalidJson", message },
      });
    },
  );

  return app;
}
