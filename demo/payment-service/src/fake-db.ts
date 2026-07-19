const DEFAULT_BALANCE_CENTS = 10_000;
const QUERY_LATENCY_MS = 4;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class FakeDbPool {
  public readonly capacity: number;
  public active = 0;

  readonly #balances = new Map<string, number>();

  public constructor(capacity = 5) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError("pool capacity must be a positive safe integer");
    }
    this.capacity = capacity;
  }

  public exhaust(): () => void {
    const releases: Array<() => void> = [];
    while (this.active < this.capacity) {
      const release = this.#tryAcquire();
      if (release === null) {
        break;
      }
      releases.push(release);
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      for (const release of releases.reverse()) {
        release();
      }
    };
  }

  public async getBalance(userId: string): Promise<number | null> {
    const release = this.#tryAcquire();
    if (release === null) {
      return null;
    }

    try {
      await delay(QUERY_LATENCY_MS);
      return this.#balances.get(userId) ?? DEFAULT_BALANCE_CENTS;
    } finally {
      release();
    }
  }

  public async debit(userId: string, amountCents: number): Promise<boolean> {
    const release = this.#tryAcquire();
    if (release === null) {
      return false;
    }

    try {
      await delay(QUERY_LATENCY_MS);
      const balance = this.#balances.get(userId) ?? DEFAULT_BALANCE_CENTS;
      if (balance < amountCents) {
        return false;
      }
      this.#balances.set(userId, balance - amountCents);
      return true;
    } finally {
      release();
    }
  }

  #tryAcquire(): (() => void) | null {
    if (this.active >= this.capacity) {
      return null;
    }

    this.active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
    };
  }
}
