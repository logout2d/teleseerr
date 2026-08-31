import { config } from "./config.js";
import { log } from "./logger.js";

export async function retrySeerrRequest(requestId: number): Promise<boolean> {
  const res = await fetch(`${config.SEERR_URL}/api/v1/request/${requestId}/retry`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": config.SEERR_API_KEY,
    },
  });

  if (!res.ok) {
    log.warn({ requestId, status: res.status }, "Seerr request retry failed");
    return false;
  }

  log.info({ requestId, status: res.status }, "Seerr request retry accepted");
  return true;
}
