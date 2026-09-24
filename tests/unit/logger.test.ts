import { describe, it, expect, vi, afterEach } from "vitest";
import {
  logger,
  newCorrelationId,
  getCorrelationId,
  runWithCorrelation,
} from "@/lib/logger";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function captureJsonLines(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as never);
  return lines;
}

describe("Structured logger (blueprint §10.1)", () => {
  it("emits single-line JSON with ts/level/msg fields", () => {
    vi.stubEnv("LOG_FORMAT", "json");
    const lines = captureJsonLines();
    logger.info("hello world", { foo: "bar", n: 42 });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("hello world");
    expect(entry.foo).toBe("bar");
    expect(entry.n).toBe(42);
    expect(new Date(entry.ts).toString()).not.toBe("Invalid Date");
  });

  it("filters below LOG_LEVEL and keeps at-or-above", () => {
    vi.stubEnv("LOG_FORMAT", "json");
    vi.stubEnv("LOG_LEVEL", "warn");
    const lines = captureJsonLines();
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    const levels = lines.map((l) => JSON.parse(l).level);
    expect(levels).toEqual(["warn", "error"]);
  });

  it("defaults to text format in non-production", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LOG_FORMAT", "text");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("turn done", { durationMs: 12 });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    expect(line).toContain("[INFO]");
    expect(line).toContain("turn done");
    expect(line).toContain("durationMs=12");
  });

  it("routes error/fatal to console.error in text mode", () => {
    vi.stubEnv("LOG_FORMAT", "text");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("boom", { err: new Error("kaboom") });
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = errSpy.mock.calls[0][0] as string;
    expect(line).toContain('"message":"kaboom"');
  });

  it("propagates the correlation id through async boundaries", async () => {
    vi.stubEnv("LOG_FORMAT", "json");
    const lines = captureJsonLines();
    const id = "corr-123";
    await runWithCorrelation(id, async () => {
      expect(getCorrelationId()).toBe(id);
      logger.info("inside");
      await new Promise((r) => setTimeout(r, 1));
      logger.info("after-await");
      // Nested run replaces the id only inside its scope.
      await runWithCorrelation("inner-9", () => {
        logger.info("nested");
      });
      logger.info("back-outside-nested");
    });
    logger.info("outside");
    const entries = lines.map((l) => JSON.parse(l));
    expect(entries.filter((e) => e.corr === id).map((e) => e.msg)).toEqual([
      "inside",
      "after-await",
      "back-outside-nested",
    ]);
    expect(entries.find((e) => e.msg === "nested")?.corr).toBe("inner-9");
    expect(entries.find((e) => e.msg === "outside")?.corr).toBeUndefined();
  });

  it("generates unique 16-hex correlation ids", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});
