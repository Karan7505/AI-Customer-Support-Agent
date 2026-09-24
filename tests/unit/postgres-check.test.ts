import { describe, it, expect, vi, afterEach } from "vitest";
import net from "node:net";
import { checkPostgresBoot } from "@/db/postgres-check";

/** Start a throwaway TCP server on 127.0.0.1:0; returns { server, port }. */
async function startTcpServer(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("expected a TCP address");
  return { server, port: addr.port };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Boot gate: checkPostgresBoot (TCP reachability probe)", () => {
  it("resolves when the URL's host:port is accepting connections", async () => {
    const { server, port } = await startTcpServer();
    try {
      vi.stubEnv("DATABASE_URL", `postgres://user:pass@127.0.0.1:${port}/db`);
      await expect(checkPostgresBoot()).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("rejects fast with a clear [boot] error when nothing listens on the port", async () => {
    // Bind then release a port so we know it is free, then point the probe at it.
    const { server, port } = await startTcpServer();
    await new Promise<void>((r) => server.close(() => r()));
    vi.stubEnv("DATABASE_URL", `postgres://user:pass@127.0.0.1:${port}/db`);
    await expect(checkPostgresBoot()).rejects.toThrow(/\[boot\] DATABASE_URL is set but Postgres is unreachable at 127.0.0.1:/);
  });

  it("rejects a malformed DATABASE_URL without touching the network", async () => {
    vi.stubEnv("DATABASE_URL", "definitely not a url");
    await expect(checkPostgresBoot()).rejects.toThrow(/\[boot\] DATABASE_URL is not a valid connection URL/);
  });
});
