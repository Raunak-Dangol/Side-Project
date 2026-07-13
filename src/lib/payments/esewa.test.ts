import { describe, it, expect } from "vitest";
import {
  buildEsewaFormPayload,
  verifyEsewaSignature,
  type EsewaCallbackPayload,
} from "./esewa";

const AMOUNT = "500";

function callbackFor(txUuid: string): EsewaCallbackPayload {
  const form = buildEsewaFormPayload({
    amount: AMOUNT,
    taxAmount: "0",
    totalAmount: AMOUNT,
    transactionUuid: txUuid,
  });
  return {
    transaction_uuid: txUuid,
    status: "COMPLETE",
    signed_field_names: "total_amount,transaction_uuid,product_code",
    signature: form.signature,
    total_amount: AMOUNT,
    product_code: form.product_code,
  };
}

describe("eSewa signature verification", () => {
  it("accepts a payload signed by our own builder (roundtrip)", () => {
    expect(verifyEsewaSignature(callbackFor("tx-1"))).toBe(true);
  });

  it("rejects a tampered amount", () => {
    const cb = callbackFor("tx-2");
    const tampered: EsewaCallbackPayload = { ...cb, total_amount: "99999" };
    expect(verifyEsewaSignature(tampered)).toBe(false);
  });

  it("rejects a missing/empty signature", () => {
    const cb = callbackFor("tx-3");
    expect(
      verifyEsewaSignature({ ...cb, signature: "", signed_field_names: "" }),
    ).toBe(false);
  });

  it("builds the canonical signed fields (total_amount, transaction_uuid, product_code)", () => {
    const form = buildEsewaFormPayload({
      amount: AMOUNT,
      taxAmount: "0",
      totalAmount: AMOUNT,
      transactionUuid: "tx-4",
    });
    // The signature must verify when reconstructed from the signed field list.
    expect(verifyEsewaSignature(callbackFor("tx-4"))).toBe(true);
    expect(form.product_code).toBeTruthy();
    expect(form.signature).toBeTruthy();
  });
});
