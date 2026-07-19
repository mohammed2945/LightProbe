import assert from "node:assert/strict";
import test from "node:test";

import { FakeDbPool } from "../src/fake-db.js";
import {
  InsufficientFundsError,
  PaymentProcessor,
} from "../src/payments.js";

test("the five-slot pool reports null while exhausted", async () => {
  const pool = new FakeDbPool(5);
  const release = pool.exhaust();

  assert.equal(pool.active, 5);
  assert.equal(await pool.getBalance("free-user"), null);

  release();
  assert.equal(pool.active, 0);
  assert.equal(await pool.getBalance("free-user"), 10_000);
});

test("BUG=on turns a free-tier null balance into InsufficientFunds", async () => {
  const pool = new FakeDbPool(5);
  const processor = new PaymentProcessor(pool, true);

  await assert.rejects(
    processor.pay({
      user: { id: "free-user", tier: "free" },
      amountCents: 2_500,
    }),
    (error: unknown) => {
      assert.ok(error instanceof InsufficientFundsError);
      assert.equal(error.availableBalanceCents, 0);
      return true;
    },
  );
  assert.equal(pool.active, 0);
});

test("BUG=off and paid tiers process deterministically", async () => {
  const fixedPool = new FakeDbPool(5);
  const fixedProcessor = new PaymentProcessor(fixedPool, false);
  const paidPool = new FakeDbPool(5);
  const paidProcessor = new PaymentProcessor(paidPool, true);

  const freeReceipt = await fixedProcessor.pay({
    user: { id: "free-user", tier: "free" },
    amountCents: 2_500,
  });
  const premiumReceipt = await paidProcessor.pay({
    user: { id: "premium-user", tier: "premium" },
    amountCents: 2_500,
  });

  assert.equal(freeReceipt.remainingBalanceCents, 7_500);
  assert.equal(premiumReceipt.remainingBalanceCents, 7_500);
});
