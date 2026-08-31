import type { Bot } from "grammy";
import { getRadarrMovieAvailability } from "./arr/availability.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { retrySeerrRequest } from "./retry.js";
import { accountStore } from "./stores.js";
import * as seerr from "./seerr/client.js";

// ── Seerr Webhook Payload ─────────────────────────

export type SeerrWebhookPayload = {
  notification_type: string;
  subject: string;
  message?: string;
  media?: {
    media_type?: string;
    tmdbId?: string;
    status?: string;
    status4k?: string;
  };
  request?: {
    request_id?: string;
  };
  extra?: unknown[];
};

type RetryState = {
  attempt: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
};

const retryStates = new Map<number, RetryState>();

// ── Helpers ───────────────────────────────────────

function escNotify(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

function findTelegramUserBySeerrId(seerrUserId: number): number | undefined {
  return accountStore.getAll().find((l) => l.seerrUserId === seerrUserId)?.telegramUserId;
}

function buildMessage(notificationType: string, subject: string): string | null {
  const title = escNotify(subject);

  switch (notificationType) {
    case "MEDIA_AVAILABLE":
      return `✅ *${title}* is now available\\! Time to watch, matey\\! 🏴‍☠️`;
    case "MEDIA_APPROVED":
    case "MEDIA_AUTO_APPROVED":
      return `⚙️ *${title}* has been approved and queued for processing\\!`;
    case "MEDIA_DECLINED":
      return `🔴 *${title}* request was declined by the admiral\\.`;
    case "MEDIA_FAILED":
      return `🔴 *${title}* request failed\\.`;
    default:
      return null;
  }
}

function parseReleaseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value.includes("T") ? value : `${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isFutureUtcDate(date: Date): boolean {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return date.getTime() > today.getTime();
}

function formatReleaseDate(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function buildWaitingForReleaseMessage(title: string, releaseDate?: string): string {
  const parsedDate = parseReleaseDate(releaseDate);
  if (parsedDate) {
    const formattedDate = escNotify(formatReleaseDate(parsedDate));
    return `🕒 *${title}* — запрос одобрен\\. По правилам Radarr фильм ещё недоступен; ожидаемая дата доступности — ${formattedDate}\\. Фильм останется на отслеживании и поиск начнётся автоматически, когда он станет доступен\\.`;
  }

  return `🕒 *${title}* — запрос одобрен\\. Radarr считает фильм ещё недоступным, поэтому он останется на отслеживании до появления релиза\\.`;
}

async function buildApprovalMessage(payload: SeerrWebhookPayload): Promise<string> {
  const title = escNotify(payload.subject);
  const mediaType = payload.media?.media_type;
  const tmdbId = payload.media?.tmdbId ? Number(payload.media.tmdbId) : NaN;

  if (mediaType === "movie" && Number.isFinite(tmdbId)) {
    // Radarr is the source of truth for movie availability because its `isAvailable`
    // already applies Minimum Availability, cinema/digital/physical dates, and availability delay.
    const radarrAvailability = await getRadarrMovieAvailability(tmdbId);
    if (radarrAvailability?.found) {
      log.info(
        {
          tmdbId,
          isAvailable: radarrAvailability.isAvailable,
          minimumAvailability: radarrAvailability.minimumAvailability,
          releaseDate: radarrAvailability.releaseDate,
        },
        "Radarr movie availability resolved",
      );

      if (!radarrAvailability.isAvailable) {
        return buildWaitingForReleaseMessage(title, radarrAvailability.releaseDate);
      }

      return `⚙️ *${title}* has been approved and queued for processing\\!`;
    }

    // Fallback for installations where direct Radarr API access is not configured yet.
    try {
      const details = await seerr.getMovieDetails(tmdbId);
      const releaseDate = parseReleaseDate(details.releaseDate);
      const status = details.status.trim().toLowerCase();
      const explicitlyUnreleased = ["planned", "in production", "post production"].includes(
        status,
      );

      if ((releaseDate && isFutureUtcDate(releaseDate)) || explicitlyUnreleased) {
        return buildWaitingForReleaseMessage(title, details.releaseDate);
      }
    } catch (e) {
      log.debug({ tmdbId, err: e }, "Could not determine movie release state");
    }
  }

  return `⚙️ *${title}* has been approved and queued for processing\\!`;
}

function formatDelay(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function clearRetryState(requestId: number | undefined): void {
  if (!requestId) return;
  const state = retryStates.get(requestId);
  if (state?.timer) clearTimeout(state.timer);
  retryStates.delete(requestId);
}

async function scheduleFailedRequestRetry(
  bot: Bot,
  telegramUserId: number,
  requestId: number,
  subject: string,
): Promise<void> {
  const current = retryStates.get(requestId) ?? { attempt: 0 };

  // Duplicate MEDIA_FAILED webhook while a retry is already scheduled.
  if (current.timer) return;

  if (current.attempt >= config.RETRY_DELAYS_SECONDS.length) {
    const title = escNotify(subject);
    await bot.api.sendMessage(
      telegramUserId,
      `🔴 *${title}* failed after ${current.attempt} automatic retries\\. Manual check required\\.`,
      { parse_mode: "MarkdownV2" },
    );
    retryStates.delete(requestId);
    log.warn({ requestId, attempts: current.attempt }, "Automatic request retries exhausted");
    return;
  }

  const attempt = current.attempt + 1;
  const delaySeconds = config.RETRY_DELAYS_SECONDS[current.attempt]!;
  const title = escNotify(subject);

  await bot.api.sendMessage(
    telegramUserId,
    `⚠️ *${title}* request failed\\. Automatic retry ${attempt}/${config.RETRY_DELAYS_SECONDS.length} in ${escNotify(formatDelay(delaySeconds))}\\.`,
    { parse_mode: "MarkdownV2" },
  );

  const state: RetryState = { attempt };
  state.timer = setTimeout(() => {
    state.timer = undefined;
    retryStates.set(requestId, state);

    void retrySeerrRequest(requestId)
      .then((accepted) => {
        if (!accepted) {
          void scheduleFailedRequestRetry(bot, telegramUserId, requestId, subject);
        }
      })
      .catch((e: unknown) => {
        log.warn({ requestId, attempt, err: e }, "Automatic request retry failed");
        void scheduleFailedRequestRetry(bot, telegramUserId, requestId, subject);
      });
  }, delaySeconds * 1000);

  retryStates.set(requestId, state);
  log.info({ requestId, attempt, delaySeconds }, "Automatic request retry scheduled");
}

// ── Webhook Handler ───────────────────────────────

export async function handleWebhook(payload: SeerrWebhookPayload, bot: Bot): Promise<void> {
  const { notification_type, subject, request } = payload;

  log.info({ notification_type, subject }, "Seerr webhook received");

  // Resolve Telegram user via Seerr request → requestedBy user ID → account link
  const requestId = request?.request_id ? Number(request.request_id) : undefined;
  let telegramUserId: number | undefined;

  if (requestId) {
    const seerrRequest = await seerr.getRequest(requestId);
    if (seerrRequest) {
      telegramUserId = findTelegramUserBySeerrId(seerrRequest.requestedBy.id);
    }
  }

  if (!telegramUserId) {
    const message = buildMessage(notification_type, subject);
    if (!message) {
      log.debug({ notification_type }, "Ignoring unhandled webhook type");
      return;
    }
    log.warn({ notification_type, requestId }, "No linked Telegram user for webhook notification");
    return;
  }

  if (notification_type === "MEDIA_FAILED" && config.AUTO_RETRY_FAILED && requestId) {
    await scheduleFailedRequestRetry(bot, telegramUserId, requestId, subject);
    return;
  }

  if (notification_type === "MEDIA_AVAILABLE" || notification_type === "MEDIA_DECLINED") {
    clearRetryState(requestId);
  }

  const message =
    notification_type === "MEDIA_APPROVED" || notification_type === "MEDIA_AUTO_APPROVED"
      ? await buildApprovalMessage(payload)
      : buildMessage(notification_type, subject);

  if (!message) {
    log.debug({ notification_type }, "Ignoring unhandled webhook type");
    return;
  }

  try {
    await bot.api.sendMessage(telegramUserId, message, {
      parse_mode: "MarkdownV2",
    });
    log.info(
      { telegramUser: telegramUserId, notification_type, subject },
      "Webhook notification sent",
    );
  } catch (e) {
    log.warn(
      { telegramUser: telegramUserId, notification_type, err: e },
      "Failed to send webhook notification",
    );
  }
}

// ── Auto-Approve Notification ─────────────────────

export function sendAutoApproveNotification(
  bot: Bot,
  telegramUserId: number,
  mediaType: "movie" | "tv",
  tmdbId: number,
): void {
  // When webhooks are enabled, Seerr is the source of truth for approval notifications.
  // This avoids duplicate messages and avoids claiming a download has started before *arr accepts it.
  if (config.WEBHOOK_SECRET) return;

  (async () => {
    let title: string;
    try {
      if (mediaType === "movie") {
        const details = await seerr.getMovieDetails(tmdbId);
        title = details.title ?? `TMDB#${tmdbId}`;
      } else {
        const details = await seerr.getTvDetails(tmdbId);
        title = details.name ?? `TMDB#${tmdbId}`;
      }
    } catch {
      title = `TMDB#${tmdbId}`;
    }

    const escaped = escNotify(title);
    await bot.api.sendMessage(
      telegramUserId,
      `⚙️ *${escaped}* has been approved and queued for processing\\!`,
      { parse_mode: "MarkdownV2" },
    );
    log.info({ telegramUser: telegramUserId, mediaType, tmdbId }, "Auto-approve notification sent");
  })().catch((e: unknown) => {
    log.warn(
      { telegramUser: telegramUserId, mediaType, tmdbId, err: e },
      "Failed to send auto-approve notification",
    );
  });
}
