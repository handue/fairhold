export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getServerEnv } = await import("@/server/lib/env");
    // Validating at boot makes a misconfigured deploy fail its health check instead of its
    // first request.
    const env = getServerEnv();
    if (env.ENGINE_ENABLED) {
      const { startEngineTick } = await import("@/server/engine/tick");
      startEngineTick();
    }
  }
}
