import { databaseUrl } from "@/lib/env";

/**
 * Boot-time reachability probe (blueprint §5.2): when Postgres mode is
 * requested (DATABASE_URL set) but the database is not accepting connections,
 * fail fast at boot with a clear error instead of failing on the first
 * request.
 *
 * EDGE-SAFETY CONSTRAINT: this module is imported from src/instrumentation.ts,
 * which Next.js also compiles for the edge runtime. The `postgres` driver
 * cannot be imported here (it requires net/tls, which the edge bundler
 * cannot resolve), so the probe is a raw TCP connect to the URL's host:port,
 * with node:net resolved at RUNTIME via process.getBuiltinModule — no static
 * node: imports anywhere in this module (same technique as env.ts).
 *
 * Scope: reachability only (host up, port accepting). Credential and
 * database-name validation still happen on first query and via
 * `npm run db:migrate` (which the deploy pipeline runs before serving) —
 * both fail closed with driver-level errors.
 */
export async function checkPostgresBoot(): Promise<void> {
  const url = databaseUrl();
  if (!url) throw new Error("checkPostgresBoot: DATABASE_URL is not set.");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new Error(`[boot] DATABASE_URL is not a valid connection URL: ${e instanceof Error ? e.message : String(e)}`);
  }
  const host = parsed.hostname || "localhost";
  const port = Number(parsed.port || 5432);

  const net = (
    process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule?.("node:net") as typeof import("node:net") | undefined;
  if (!net) throw new Error("checkPostgresBoot: node:net is unavailable in this runtime.");

  try {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port, timeout: 5000 });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("timeout", () => {
        socket.destroy();
        reject(new Error(`connect timed out after 5s to ${host}:${port}`));
      });
      socket.once("error", (err) => reject(err));
    });
  } catch (e) {
    throw new Error(
      `[boot] DATABASE_URL is set but Postgres is unreachable at ${host}:${port}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
