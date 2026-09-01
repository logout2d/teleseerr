import { api, getCurrentDetail } from "./state.js";

const ANIME_KEYWORD_ID = 210024;
const PROFILE_PREFIX = "RU - ";
const SELECT_ID = "voice-profile-select";
const WRAP_ID = "voice-profile-picker";

/** @type {{ available: boolean, defaultProfileId: number|null, profiles: Array<{id:number,name:string}> } | null} */
let profileCache = null;
let profileLoad = null;

function isAnimeDetail(detail) {
  return detail?.data?.keywords?.some?.((keyword) => keyword?.id === ANIME_KEYWORD_ID) === true;
}

function displayName(name) {
  const short = name.startsWith(PROFILE_PREFIX) ? name.slice(PROFILE_PREFIX.length) : name;
  if (short === "Auto") return "Авто";
  if (short === "Kurazh Bambej") return "Кураж Бамбей";
  return short;
}

async function loadProfiles() {
  if (profileCache) return profileCache;
  if (profileLoad) return profileLoad;

  profileLoad = api("/api/tv/profiles")
    .then((data) => {
      profileCache = data;
      return data;
    })
    .finally(() => {
      profileLoad = null;
    });

  return profileLoad;
}

function addStyles() {
  if (document.getElementById("voice-profile-styles")) return;

  const style = document.createElement("style");
  style.id = "voice-profile-styles";
  style.textContent = `
    .voice-profile-picker {
      margin: 14px 16px 4px;
      padding: 14px;
      border: 1px solid var(--border, rgba(128,128,128,.22));
      border-radius: 12px;
      background: var(--card, rgba(255,255,255,.04));
    }
    .voice-profile-label {
      display: block;
      margin-bottom: 7px;
      font-size: 13px;
      font-weight: 600;
      opacity: .78;
    }
    .voice-profile-select {
      width: 100%;
      min-height: 42px;
      padding: 9px 34px 9px 11px;
      border: 1px solid var(--border, rgba(128,128,128,.28));
      border-radius: 10px;
      background: var(--bg, #111);
      color: var(--text, inherit);
      font: inherit;
      font-size: 15px;
    }
    .voice-profile-note {
      margin-top: 7px;
      font-size: 12px;
      line-height: 1.35;
      opacity: .58;
    }
  `;
  document.head.appendChild(style);
}

async function ensurePicker() {
  const detail = getCurrentDetail();
  const view = document.getElementById("detail-view");
  const seasonPicker = view?.querySelector(".season-picker");

  if (!detail || detail.type !== "tv" || !view?.classList.contains("active") || !seasonPicker) {
    return;
  }

  // Anime keeps the existing automatic anime routing/profile.
  if (isAnimeDetail(detail)) {
    document.getElementById(WRAP_ID)?.remove();
    return;
  }

  if (document.getElementById(WRAP_ID)) return;

  let data;
  try {
    data = await loadProfiles();
  } catch {
    return;
  }

  // User may have navigated away while profiles were loading.
  const latest = getCurrentDetail();
  if (!latest || latest.type !== "tv" || latest.id !== detail.id || isAnimeDetail(latest)) return;
  if (!data?.available || !Array.isArray(data.profiles) || data.profiles.length === 0) return;
  if (document.getElementById(WRAP_ID)) return;

  const wrapper = document.createElement("div");
  wrapper.id = WRAP_ID;
  wrapper.className = "voice-profile-picker";

  const label = document.createElement("label");
  label.className = "voice-profile-label";
  label.htmlFor = SELECT_ID;
  label.textContent = "Озвучка";

  const select = document.createElement("select");
  select.id = SELECT_ID;
  select.className = "voice-profile-select";

  for (const profile of data.profiles) {
    const option = document.createElement("option");
    option.value = String(profile.id);
    option.textContent = displayName(profile.name);
    if (profile.id === data.defaultProfileId) option.selected = true;
    select.appendChild(option);
  }

  const note = document.createElement("div");
  note.className = "voice-profile-note";
  note.textContent = "Авто — любая распознанная русская озвучка. Выбор студии — только релизы с этой озвучкой.";

  wrapper.append(label, select, note);
  seasonPicker.parentNode?.insertBefore(wrapper, seasonPicker);
}

addStyles();

const observer = new MutationObserver(() => {
  void ensurePicker();
});
observer.observe(document.body, { childList: true, subtree: true });
void ensurePicker();

// Keep detail.js unchanged: enrich only TV request payloads immediately before they are sent.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  try {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    const method = init?.method?.toUpperCase() ?? (input instanceof Request ? input.method.toUpperCase() : "GET");

    if (method === "POST" && url.includes("/api/request") && typeof init?.body === "string") {
      const body = JSON.parse(init.body);
      if (body?.mediaType === "tv") {
        const select = document.getElementById(SELECT_ID);
        const profileId = select instanceof HTMLSelectElement ? Number(select.value) : NaN;
        if (Number.isInteger(profileId) && profileId > 0) {
          body.profileId = profileId;
          init = { ...init, body: JSON.stringify(body) };
        }
      }
    }
  } catch {
    // Never block the original request if UI enhancement fails.
  }

  return nativeFetch(input, init);
};
