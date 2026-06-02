/**
 * Phase 0 unit tests for the plaintext-gap closure plan.
 *
 * Covers the new "optional free-text envelope" helpers
 * (encryptOptional/decryptOptional) and the rule field crypto
 * (encryptRuleFields/decryptRuleFields). Pure functions — no DB mock needed.
 *
 * See plan/encryption-plaintext-gaps.md Phase 0.
 */

import { describe, it, expect } from "vitest";
import { randomBytes } from "crypto";
import { encryptOptional, decryptOptional } from "@/lib/crypto/encrypted-columns";
import { encryptRuleFields, decryptRuleFields } from "@/lib/rules/crypto";
import { isEncrypted } from "@/lib/crypto/envelope";
import type { ConditionGroup, Action } from "@/lib/rules/schema";

const dek = randomBytes(32);

describe("encryptOptional / decryptOptional", () => {
  it("round-trips a string and emits v1: ciphertext", () => {
    const ct = encryptOptional(dek, "secret note");
    expect(ct).not.toBeNull();
    expect(ct).toMatch(/^v1:/);
    expect(ct).not.toBe("secret note");
    expect(decryptOptional(dek, ct)).toBe("secret note");
  });

  it("passes null/empty through unchanged", () => {
    expect(encryptOptional(dek, null)).toBeNull();
    expect(encryptOptional(dek, undefined)).toBeNull();
    expect(encryptOptional(dek, "")).toBe("");
    expect(decryptOptional(dek, null)).toBeNull();
  });

  it("passes plaintext through when dek is null (cold-DEK write)", () => {
    expect(encryptOptional(null, "secret")).toBe("secret");
    // Decrypt with a null DEK returns the stored value unchanged.
    expect(decryptOptional(null, "secret")).toBe("secret");
  });

  it("decryptOptional returns legacy plaintext unchanged", () => {
    expect(decryptOptional(dek, "legacy plaintext")).toBe("legacy plaintext");
  });
});

describe("encryptRuleFields / decryptRuleFields", () => {
  const conditions: ConditionGroup = {
    all: [
      { field: "payee", op: "contains", value: "Starbucks" },
      { field: "currency", op: "is", value: "USD" },
      { field: "amount", op: "lt", value: -5 },
    ],
  };
  const actions: Action[] = [
    { kind: "rename_payee", to: "Coffee" },
    { kind: "set_tags", tags: "coffee,treats" },
    { kind: "set_category", categoryId: 42 },
  ];

  it("round-trips name + payee value + rename_payee.to + set_tags.tags", () => {
    const enc = encryptRuleFields(dek, { name: "Coffee rule", conditions, actions });

    // Sensitive fields are now ciphertext.
    expect(isEncrypted(enc.name!)).toBe(true);
    const encPayee = enc.conditions!.all[0] as { value: string };
    expect(isEncrypted(encPayee.value)).toBe(true);
    const encRename = enc.actions!.find((a) => a.kind === "rename_payee") as { to: string };
    expect(isEncrypted(encRename.to)).toBe(true);
    const encSetTags = enc.actions!.find((a) => a.kind === "set_tags") as { tags: string };
    expect(isEncrypted(encSetTags.tags)).toBe(true);

    const dec = decryptRuleFields(dek, enc);
    expect(dec.name).toBe("Coffee rule");
    expect((dec.conditions!.all[0] as { value: string }).value).toBe("Starbucks");
    expect((dec.actions!.find((a) => a.kind === "rename_payee") as { to: string }).to).toBe("Coffee");
    expect((dec.actions!.find((a) => a.kind === "set_tags") as { tags: string }).tags).toBe("coffee,treats");
  });

  it("leaves currency / amount conditions + FK ids byte-identical", () => {
    const enc = encryptRuleFields(dek, { name: "X", conditions, actions });

    const currencyCond = enc.conditions!.all[1] as { value: string };
    expect(currencyCond.value).toBe("USD"); // NOT encrypted
    const amountCond = enc.conditions!.all[2] as { value: number };
    expect(amountCond.value).toBe(-5); // NOT encrypted
    const setCat = enc.actions!.find((a) => a.kind === "set_category") as { categoryId: number };
    expect(setCat.categoryId).toBe(42); // FK id untouched
  });

  it("does not mutate the input rule", () => {
    const input = { name: "Coffee rule", conditions, actions };
    encryptRuleFields(dek, input);
    expect(input.name).toBe("Coffee rule");
    expect((input.conditions.all[0] as { value: string }).value).toBe("Starbucks");
    expect((input.actions[0] as { to: string }).to).toBe("Coffee");
  });

  it("passes plaintext through when dek is null", () => {
    const enc = encryptRuleFields(null, { name: "X", conditions, actions });
    expect(enc.name).toBe("X");
    expect((enc.conditions!.all[0] as { value: string }).value).toBe("Starbucks");
  });

  it("does not double-encrypt an already-encrypted rule", () => {
    const once = encryptRuleFields(dek, { name: "Coffee rule", conditions, actions });
    const twice = encryptRuleFields(dek, once);
    // Second pass is a no-op on the already-v1: values; one decrypt recovers plaintext.
    const dec = decryptRuleFields(dek, twice);
    expect(dec.name).toBe("Coffee rule");
    expect((dec.conditions!.all[0] as { value: string }).value).toBe("Starbucks");
  });

  it("a rule with only non-string conditions round-trips unchanged", () => {
    const onlyCurrency: ConditionGroup = { all: [{ field: "currency", op: "is", value: "CAD" }] };
    const onlyCat: Action[] = [{ kind: "set_category", categoryId: 7 }];
    const enc = encryptRuleFields(dek, { name: "C", conditions: onlyCurrency, actions: onlyCat });
    // name is the only thing encrypted.
    expect(isEncrypted(enc.name!)).toBe(true);
    expect((enc.conditions!.all[0] as { value: string }).value).toBe("CAD");
    const dec = decryptRuleFields(dek, enc);
    expect(dec.name).toBe("C");
  });
});
