import { randomBytes, randomInt } from "node:crypto";

/**
 * Generate a human-readable, collision-resistant id like `TCK-5231ab3c`.
 * All entropy comes from the CSPRNG (no Math.random): access control never
 * relies on id secrecy, but predictable ids are still an enumeration aid.
 * Seeded rows use fixed ids (ORD-1001) so demos are reproducible; rows
 * created at runtime use this generator.
 */
export function genId(prefix: string): string {
  const n = randomInt(1000, 9999);
  const r = randomBytes(2).toString("hex");
  return `${prefix}-${n}${r}`;
}
