import { pingDb } from "../repositories/health.repository.js";

const dbTimeoutMs = Number(
  process.env.HEALTH_DB_TIMEOUT_MS ?? 2000,
);

export type HealthResult =
  | { healthy: true }
  | { healthy: false; error: unknown };

export async function checkHealth(): Promise<HealthResult> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `database check timed out after ${dbTimeoutMs}ms`,
        ),
      );
    }, dbTimeoutMs);
  });

  try {
    await Promise.race([pingDb(), timeout]);

    return {
      healthy: true,
    };
  } catch (error) {
    return {
      healthy: false,
      error,
    };
  } finally {
    clearTimeout(timer);
  }
}
