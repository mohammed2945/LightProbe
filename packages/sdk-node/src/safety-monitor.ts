import { monitorEventLoopDelay } from "node:perf_hooks";

interface DelayHistogram {
  disable(): boolean;
  enable(): boolean;
  percentile(percentile: number): number;
  reset(): void;
}

interface SafetyMonitorOptions {
  maxLagMs: number;
  sampleIntervalMs: number;
  cooldownMs: number;
  onRed(p95Ms: number): void | Promise<void>;
  onRearm(): void | Promise<void>;
  histogram?: DelayHistogram;
}

export class EventLoopSafetyMonitor {
  readonly #maxLagMs: number;
  readonly #sampleIntervalMs: number;
  readonly #cooldownMs: number;
  readonly #onRed: SafetyMonitorOptions["onRed"];
  readonly #onRearm: SafetyMonitorOptions["onRearm"];
  readonly #histogram: DelayHistogram;
  #state: "green" | "red" = "green";
  #interval: NodeJS.Timeout | undefined;
  #cooldown: NodeJS.Timeout | undefined;
  #started = false;

  constructor(options: SafetyMonitorOptions) {
    if (!Number.isFinite(options.maxLagMs) || options.maxLagMs <= 0) {
      throw new RangeError("maxLagMs must be positive and finite");
    }
    this.#maxLagMs = options.maxLagMs;
    this.#sampleIntervalMs = options.sampleIntervalMs;
    this.#cooldownMs = options.cooldownMs;
    this.#onRed = options.onRed;
    this.#onRearm = options.onRearm;
    this.#histogram =
      options.histogram ?? monitorEventLoopDelay({ resolution: 20 });
  }

  get state(): "green" | "red" {
    return this.#state;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#histogram.enable();
    this.#interval = setInterval(() => this.sampleNow(), this.#sampleIntervalMs);
    this.#interval.unref();
  }

  sampleNow(): void {
    if (!this.#started || this.#state === "red") return;
    const p95Ms = this.#histogram.percentile(95) / 1_000_000;
    this.#histogram.reset();
    if (!Number.isFinite(p95Ms) || p95Ms <= this.#maxLagMs) return;

    this.#state = "red";
    void Promise.resolve(this.#onRed(p95Ms)).catch(() => {
      // The state remains RED even when cleanup reports an error.
    });
    this.#cooldown = setTimeout(() => {
      if (!this.#started) return;
      this.#histogram.reset();
      this.#state = "green";
      void Promise.resolve(this.#onRearm()).catch(() => {
        // A later poll or script event gets another chance to re-arm.
      });
    }, this.#cooldownMs);
    this.#cooldown.unref();
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    if (this.#interval !== undefined) clearInterval(this.#interval);
    if (this.#cooldown !== undefined) clearTimeout(this.#cooldown);
    this.#interval = undefined;
    this.#cooldown = undefined;
    this.#histogram.disable();
    this.#state = "green";
  }
}
