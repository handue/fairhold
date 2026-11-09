export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getServerEnv } = await import("@/server/lib/env");
    // Validating at boot makes a misconfigured deploy fail its health check instead of its
    // first request.
    const env = getServerEnv();
    if (env.ENGINE_ENABLED) {
      const { startEngineTick } = await import("@/server/engine/tick");
      const { createDirectorTickTask } = await import("@/server/director/task");
      const { createEventCardTickTask } = await import("@/server/chat/task");
      const { createSettlementTickTask } = await import("@/server/settlement");
      // Event cards ahead of the autopilot, so a fact's card always comes before what Glim did about it.
      const extraTasks: import("@/server/engine/tick").TickTask[] = [createDirectorTickTask(), createEventCardTickTask()];
      // Glim's autopilot runs in the process that ticks; GLIM_AUTOPILOT=off leaves confirmed plans as they are.
      if (env.GLIM_AUTOPILOT === "on") {
        const { createAutopilotTickTask } = await import("@/server/plans/task");
        extraTasks.push(createAutopilotTickTask());
      }
      extraTasks.push(createSettlementTickTask());
      startEngineTick(extraTasks);
    }
  }
}
