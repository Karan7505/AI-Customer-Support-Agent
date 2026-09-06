import { randomBytes } from "node:crypto";

/**
 * Generate a human-readable, collision-resistant id like `TCK-5231ab3c`.
 * Seeded rows use fixed ids (ORD-1001) so demos are reproducible; rows created
 * at runtime use this generator.
 */
export function genId(prefix: string): string {
  const n = 1000 + Math.floor(Math.random() * 8999);
  const r = randomBytes(2).toString("hex");
  return `${prefix}-${n}${r}`;
}
