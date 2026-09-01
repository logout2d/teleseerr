import { config } from "../config.js";
import { log } from "../logger.js";
import type {
  ArrQueueItem,
  ArrQueueResponse,
  DownloadProgress,
  ProgressResponse,
} from "../types.js";

// ── Instance Configuration ──────────────────────

type ArrInstance = {
  name: string;
  url: string;
  apiKey: string;
  type: "radarr" | "sonarr";
};

export type SonarrQualityProfile = {
  id: number;
  name: string;
};

function getInstances(): { radarr: ArrInstance[]; sonarr: ArrInstance[] } {
  const radarr: ArrInstance[] = [];
  const sonarr: ArrInstance[] = [];

  if (config.RADARR_URL && config.RADARR_API_KEY) {
    radarr.push({
      name: "radarr",
      url: config.RADARR_URL,
      apiKey: config.RADARR_API_KEY,
      type: "radarr",
    });
  }
  if (config.RADARR_4K_URL && config.RADARR_4K_API_KEY) {
    radarr.push({
      name: "radarr4k",
      url: config.RADARR_4K_URL,
      apiKey: config.RADARR_4K_API_KEY,
      type: "radarr",
    });
  }
  if (config.SONARR_URL && config.SONARR_API_KEY) {
    sonarr.push({
      name: "sonarr",
      url: config.SONARR_URL,
      apiKey: config.SONARR_API_KEY,
      type: "sonarr",
    });
  }
  if (config.SONARR_4K_URL && config.SONARR_4K_API_KEY) {
    sonarr.push({
      name: "sonarr4k",
      url: config.SONARR_4K_URL,
      apiKey: config.SONARR_4K_API_KEY,
      type: "sonarr",
    });
  }

  return { radarr, sonarr };
}

export function isProgressEnabled(): { radarr: boolean; sonarr: boolean } {
  const { radarr, sonarr } = getInstances();
  return { radarr: radarr.length > 0, sonarr: sonarr.length > 0 };
}

// ── Cache ────────────────────────────────────────

type CacheEntry = {
  data: ArrQueueItem[];
  fetchedAt: number;
};

const CACHE_TTL = 10_000;
const cache = new Map<string, CacheEntry>();

const PROFILE_CACHE_TTL = 60_000;
let sonarrProfilesCache: { data: SonarrQualityProfile[]; fetchedAt: number } | null = null;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt > CACHE_TTL) cache.delete(key);
  }
}, 60_000);

// ── Fetch ────────────────────────────────────────

const MAX_PAGES = 3;
const PAGE_SIZE = 100;

async function fetchQueue(instance: ArrInstance): Promise<ArrQueueItem[]> {
  try {
    const params =
      instance.type === "radarr" ? "includeMovie=true" : "includeEpisode=true&includeSeries=true";

    const items: ArrQueueItem[] = [];
    let page = 1;
    let totalRecords = 0;

    do {
      const url = `${instance.url}/api/v3/queue?page=${page}&pageSize=${PAGE_SIZE}&${params}`;
      const start = Date.now();
      const res = await fetch(url, {
        headers: { "X-Api-Key": instance.apiKey },
        signal: AbortSignal.timeout(5000),
      });
      const ms = Date.now() - start;

      if (!res.ok) {
        log.warn({ instance: instance.name, status: res.status, ms }, "arr queue fetch failed");
        return items;
      }

      const data = (await res.json()) as ArrQueueResponse;
      log.debug(
        { instance: instance.name, page, records: data.records.length, ms },
        "arr queue fetch",
      );
      items.push(...data.records);
      totalRecords = data.totalRecords;
      page++;
    } while (items.length < totalRecords && page <= MAX_PAGES);

    return items;
  } catch (e) {
    log.warn(e, `Failed to fetch queue from ${instance.name}`);
    return [];
  }
}

async function getQueueCached(instance: ArrInstance): Promise<ArrQueueItem[]> {
  const cached = cache.get(instance.name);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.data;
  }

  const data = await fetchQueue(instance);
  cache.set(instance.name, { data, fetchedAt: Date.now() });
  return data;
}

// ── Helpers ──────────────────────────────────────

function parseTimeleft(timeleft: string | null): string | null {
  if (!timeleft) return null;
  const parts = timeleft.split(":").map(Number);
  if (parts.length < 3) return timeleft;
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const s = parts[2] ?? 0;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function calcPercent(size: number, sizeleft: number): number {
  if (size <= 0) return 0;
  return Math.round(Math.max(0, Math.min(100, ((size - sizeleft) / size) * 100)));
}

function mapStatus(item: ArrQueueItem): DownloadProgress["status"] {
  if (item.trackedDownloadState === "importPending" || item.trackedDownloadState === "importing") {
    return "importing";
  }
  if (item.status === "failed" || item.trackedDownloadState === "failedPending") {
    return "failed";
  }
  if (item.status === "warning") return "stalled";
  if (item.status === "paused") return "paused";
  if (item.status === "queued") return "queued";
  return "downloading";
}

function itemToProgress(item: ArrQueueItem): DownloadProgress {
  return {
    percent: calcPercent(item.size, item.sizeleft),
    eta: parseTimeleft(item.timeleft),
    status: mapStatus(item),
    title: item.title,
    sizeTotal: item.size,
    sizeDownloaded: item.size - item.sizeleft,
    ...(item.episode && {
      episode: {
        season: item.episode.seasonNumber,
        episode: item.episode.episodeNumber,
        title: item.episode.title,
      },
    }),
  };
}

// ── Public API ───────────────────────────────────

const EMPTY_RESPONSE: ProgressResponse = { available: false, items: [], isSeasonPack: false };

export async function getSonarrQualityProfiles(): Promise<SonarrQualityProfile[]> {
  const { sonarr } = getInstances();
  const instance = sonarr.find((item) => item.name === "sonarr") ?? sonarr[0];
  if (!instance) return [];

  if (sonarrProfilesCache && Date.now() - sonarrProfilesCache.fetchedAt < PROFILE_CACHE_TTL) {
    return sonarrProfilesCache.data;
  }

  try {
    const start = Date.now();
    const res = await fetch(`${instance.url}/api/v3/qualityprofile`, {
      headers: { "X-Api-Key": instance.apiKey },
      signal: AbortSignal.timeout(5000),
    });
    const ms = Date.now() - start;

    if (!res.ok) {
      log.warn({ instance: instance.name, status: res.status, ms }, "sonarr quality profiles fetch failed");
      return sonarrProfilesCache?.data ?? [];
    }

    const raw = (await res.json()) as Array<{ id?: number; name?: string }>;
    const data = raw
      .filter(
        (item): item is { id: number; name: string } =>
          typeof item.id === "number" && typeof item.name === "string" && item.name.startsWith("RU - "),
      )
      .map((item) => ({ id: item.id, name: item.name }))
      .sort((a, b) => {
        if (a.name === "RU - Auto") return -1;
        if (b.name === "RU - Auto") return 1;
        return a.name.localeCompare(b.name);
      });

    sonarrProfilesCache = { data, fetchedAt: Date.now() };
    log.debug({ instance: instance.name, count: data.length, ms }, "sonarr RU quality profiles fetched");
    return data;
  } catch (e) {
    log.warn(e, "Failed to fetch Sonarr quality profiles");
    return sonarrProfilesCache?.data ?? [];
  }
}

export async function getMovieProgress(tmdbId: number): Promise<ProgressResponse> {
  const { radarr } = getInstances();
  if (radarr.length === 0) return EMPTY_RESPONSE;

  const queues = await Promise.all(radarr.map(getQueueCached));
  const items = queues
    .flat()
    .filter((item) => item.movie?.tmdbId === tmdbId)
    .map(itemToProgress);

  return { available: true, items, isSeasonPack: false };
}

export async function getTvProgress(tmdbId: number, tvdbId?: number): Promise<ProgressResponse> {
  const { sonarr } = getInstances();
  if (sonarr.length === 0) return EMPTY_RESPONSE;

  const queues = await Promise.all(sonarr.map(getQueueCached));
  const items = queues
    .flat()
    .filter((item) => {
      if (item.series?.tmdbId && item.series.tmdbId === tmdbId) return true;
      if (tvdbId && item.series?.tvdbId === tvdbId) return true;
      return false;
    })
    .map(itemToProgress);

  // Season pack detection: all items share the same download title
  const titles = new Set(items.map((i) => i.title));
  const isSeasonPack = items.length > 1 && titles.size === 1;

  return { available: true, items, isSeasonPack };
}
