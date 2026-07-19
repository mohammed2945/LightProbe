export class TokenBucket {
  readonly #ratePerSecond: number;
  readonly #capacity: number;
  readonly #now: () => number;
  #tokens: number;
  #lastRefill: number;

  constructor(ratePerSecond: number, now: () => number = () => performance.now()) {
    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
      throw new RangeError("ratePerSecond must be positive and finite");
    }
    this.#ratePerSecond = ratePerSecond;
    this.#capacity = ratePerSecond;
    this.#tokens = ratePerSecond;
    this.#now = now;
    this.#lastRefill = now();
  }

  tryTake(): boolean {
    const now = this.#now();
    const elapsedSeconds = Math.max(0, now - this.#lastRefill) / 1000;
    this.#lastRefill = now;
    this.#tokens = Math.min(
      this.#capacity,
      this.#tokens + elapsedSeconds * this.#ratePerSecond,
    );
    if (this.#tokens < 1) {
      return false;
    }
    this.#tokens -= 1;
    return true;
  }
}
