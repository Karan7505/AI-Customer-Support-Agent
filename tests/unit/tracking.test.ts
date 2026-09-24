import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveTracking, mockTracking, clearTrackingCache } from "@/lib/tracking";
import { makeEnv } from "../helpers";

function easypostResponse(): Response {
  return new Response(
    JSON.stringify({
      tracking: {
        status: "in_transit",
        carrier: "UPS",
        service: "Ground",
        estimated_delivery_date: "2026-05-20T00:00:00Z",
        tracking_history: [
          { description: "Picked up", status: "pre_transit", status_date: "2026-05-10T14:00:00Z", destination_city: "SF", destination_country: "US" },
          { description: "In transit", status: "in_transit", status_date: "2026-05-12T08:00:00Z", destination_city: "Oakland", destination_country: "US" },
        ],
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("order tracking provider (blueprint §5.3)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearTrackingCache();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses mock tracking by default (no key)", async () => {
    const env = makeEnv();
    const order = (await env.repo.getOrder("ORD-1"))!;
    const { tracking, source, cacheHit } = await resolveTracking(order);
    expect(source).toBe("mock");
    expect(cacheHit).toBe(false);
    expect(tracking).toEqual(mockTracking(order));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches from EasyPost and caches for 1h (second call is a cache hit)", async () => {
    vi.stubEnv("EASYPOST_API_KEY", "EP1");
    fetchSpy.mockResolvedValueOnce(easypostResponse());
    const env = makeEnv();
    const order = (await env.repo.getOrder("ORD-1"))!;

    const first = await resolveTracking(order);
    expect(first.source).toBe("easypost");
    expect(first.cacheHit).toBe(false);
    expect(first.tracking.status).toBe("shipped"); // in_transit maps to our "shipped"
    expect(first.tracking.events).toHaveLength(2);
    expect(first.tracking.events[0].location).toBe("SF, US");
    expect(first.tracking.eta).toBe("May 20");

    // Auth: Basic base64("EP1:")
    const headers = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((headers.headers as Record<string, string>).Authorization).toBe(
      "Basic " + Buffer.from("EP1:").toString("base64"),
    );
    expect(fetchSpy.mock.calls[0][0]).toMatch(/\/v2\/trackings\/TRK-1$/);

    const second = await resolveTracking(order);
    expect(second.cacheHit).toBe(true);
    expect(second.tracking).toEqual(first.tracking);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // cache hit, no second fetch
  });

  it("falls back to mock with a warning when the provider errors", async () => {
    vi.stubEnv("EASYPOST_API_KEY", "EP1");
    fetchSpy.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const env = makeEnv();
    const order = (await env.repo.getOrder("ORD-1"))!;

    const { tracking, source, cacheHit } = await resolveTracking(order);
    expect(source).toBe("mock");
    expect(cacheHit).toBe(false);
    expect(tracking).toEqual(mockTracking(order));
    // Provider failure must NOT be cached (next call retries the provider).
    fetchSpy.mockResolvedValueOnce(easypostResponse());
    const again = await resolveTracking(order);
    expect(again.source).toBe("easypost");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("TRACKING_PROVIDER=mock forces mock even with a key", async () => {
    vi.stubEnv("EASYPOST_API_KEY", "EP1");
    vi.stubEnv("TRACKING_PROVIDER", "mock");
    const env = makeEnv();
    const order = (await env.repo.getOrder("ORD-1"))!;
    const { source } = await resolveTracking(order);
    expect(source).toBe("mock");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
