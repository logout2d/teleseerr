import { config } from "../config.js";
import { log } from "../logger.js";

export type RadarrMovieAvailability = {
  found: boolean;
  isAvailable: boolean;
  minimumAvailability?: string;
  status?: string;
  inCinemas?: string;
  digitalRelease?: string;
  physicalRelease?: string;
  releaseDate?: string;
};

type RadarrMovieResource = {
  tmdbId?: number;
  isAvailable?: boolean;
  minimumAvailability?: string;
  status?: string;
  inCinemas?: string;
  digitalRelease?: string;
  physicalRelease?: string;
  releaseDate?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMovie(tmdbId: number): Promise<RadarrMovieResource | null> {
  if (!config.RADARR_URL || !config.RADARR_API_KEY) return null;

  const url = `${config.RADARR_URL}/api/v3/movie?tmdbId=${tmdbId}`;
  const res = await fetch(url, {
    headers: { "X-Api-Key": config.RADARR_API_KEY },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    log.warn({ tmdbId, status: res.status }, "Radarr availability request failed");
    return null;
  }

  const data = (await res.json()) as RadarrMovieResource[];
  return data.find((movie) => movie.tmdbId === tmdbId) ?? data[0] ?? null;
}

export async function getRadarrMovieAvailability(
  tmdbId: number,
): Promise<RadarrMovieAvailability | null> {
  if (!config.RADARR_URL || !config.RADARR_API_KEY) return null;

  try {
    // Seerr may emit the approval webhook immediately after handing the request to Radarr.
    // Give Radarr a short window to persist the movie before falling back to Seerr/TMDB state.
    for (const delayMs of [0, 500, 1500]) {
      if (delayMs > 0) await sleep(delayMs);

      const movie = await fetchMovie(tmdbId);
      if (!movie) continue;

      return {
        found: true,
        isAvailable: movie.isAvailable === true,
        ...(movie.minimumAvailability && { minimumAvailability: movie.minimumAvailability }),
        ...(movie.status && { status: movie.status }),
        ...(movie.inCinemas && { inCinemas: movie.inCinemas }),
        ...(movie.digitalRelease && { digitalRelease: movie.digitalRelease }),
        ...(movie.physicalRelease && { physicalRelease: movie.physicalRelease }),
        ...(movie.releaseDate && { releaseDate: movie.releaseDate }),
      };
    }

    return { found: false, isAvailable: false };
  } catch (e) {
    log.warn({ tmdbId, err: e }, "Failed to determine Radarr movie availability");
    return null;
  }
}
