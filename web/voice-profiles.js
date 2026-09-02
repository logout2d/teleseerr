import { api, getCurrentDetail } from "./state.js";

const ANIME_KEYWORD_ID = 210024;
const PROFILE_PREFIX = "RU - ";
const AUTO_PROFILE_NAME = "RU - Auto";
const SELECT_ID = "voice-profile-select";
const WRAP_ID = "voice-profile-picker";

/** @type {{ available: boolean, defaultProfileId: number|null, profiles: Array<{id:number,name:string}> } | null} */
let profileCache = null;
let profileLoad = null;
/** @type {number|null} */
let selectedProfileId = null;
/** @type {string|null} */
let selectedDetailKey = null;

function isAnimeDetail(detail) {
  return detail?.data?.keywords?.some?.((keyword) => keyword?.id === ANIME_KEYWORD_ID) === true;
}

function detailKey(detail) {
  return detail?.type === "tv" && Number.isInteger(detail?.id) ? `tv:${detail.id}` : null;
}

function displayName(name) {
  const short = name.startsWith(PROFILE_PREFIX) ? name.slice(PROFILE_PREFIX.length) : name;
  if (short === "Auto") return "Авто";
  if (short === "Kurazh Bambej") return "Кураж Бамбей";
  return short;
}

function getAutoProfileId(data) {
  const auto = data?.profiles?.find?.((profile) => profile?.name === AUTO_PROFILE_NAME);
  return Number.isInteger(auto?.id) && auto.id > 0 ? auto.id : null;
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
    .voice-profile-select:disabled {
      opacity: .55;
    }
    .voice-profile-note {
      margin-top: 7px;
      font-size: 12px;
      line-height: 1.35;
      opacity: .58;
    }
    .voice-profile-error {
      border-color: rgba(220,80,80,.45);
    }
  `;
  document.head.appendChild(style);
}

function removePicker() {
  document.getElementById(WRAP_ID)?.remove();
}

function insertPicker(wrapper, view) {
  const seasonPicker = view.querySelector(".season-picker");
  if (seasonPicker?.parentNode) {
    seasonPicker.parentNode.insertBefore(wrapper, seasonPicker);
    return;
  }

  const progress = view.querySelector("#download-progress-container");
  if (progress) {
    progress.after(wrapper);
    return;
  }

  view.appendChild(wrapper);
}

async function ensurePicker() {
  const detail = getCurrentDetail();
  const view = document.getElementById("detail-view");

  if (!detail || detail.type !== "tv" || !view?.classList.contains("active")) {
    removePicker();
    return;
  }

  if (isAnimeDetail(detail)) {
    selectedProfileId = null;
    selectedDetailKey = detailKey(detail);
    removePicker();
    return;
  }

  const key = detailKey(detail);
  if (key && key !== selectedDetailKey) {
    selectedDetailKey = key;
    selectedProfileId = null;
    removePicker();
  }

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
  select.disabled = true;

  const loading = document.createElement("option");
  loading.value = "";
  loading.textContent = "Загрузка профилей…";
  select.appendChild(loading);

  const note = document.createElement("div");
  note.className = "voice-profile-note";
  note.textContent = "Профиль выбирается до отправки запроса.";

  wrapper.append(label, select, note);
  insertPicker(wrapper, view);

  let data;
  try {
    data = await loadProfiles();
  } catch {
    wrapper.classList.add("voice-profile-error");
    note.textContent = "Не удалось загрузить профили Sonarr. Запрос сериала будет заблокирован.";
    return;
  }

  const latest = getCurrentDetail();
  if (!latest || latest.type !== "tv" || latest.id !== detail.id || isAnimeDetail(latest)) {
    removePicker();
    return;
  }

  const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
  const autoProfileId = getAutoProfileId(data);

  select.innerHTML = "";

  if (!data?.available || profiles.length === 0 || !autoProfileId) {
    wrapper.classList.add("voice-profile-error");
    const option = document.createElement("option");
    option.value = "";
    option.textContent = !autoProfileId ? "RU - Auto не найден" : "Профили недоступны";
    select.appendChild(option);
    select.disabled = true;
    selectedProfileId = null;
    note.textContent = "Запрос не будет отправлен, пока профиль RU - Auto недоступен.";
    return;
  }

  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = String(profile.id);
    option.textContent = displayName(profile.name);
    if (profile.id === autoProfileId) option.selected = true;
    select.appendChild(option);
  }

  selectedProfileId = autoProfileId;
  select.disabled = false;
  note.textContent = "Авто — любая распознанная русская озвучка. Выбор студии — только релизы с этой озвучкой.";

  select.addEventListener("change", () => {
    const value = Number(select.value);
    selectedProfileId = Number.isInteger(value) && value > 0 ? value : null;
  });
}

addStyles();

let ensureQueued = false;
function scheduleEnsurePicker() {
  if (ensureQueued) return;
  ensureQueued = true;
  queueMicrotask(() => {
    ensureQueued = false;
    void ensurePicker();
  });
}

const observer = new MutationObserver(scheduleEnsurePicker);
observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
window.addEventListener("pageshow", scheduleEnsurePicker);
document.addEventListener("visibilitychange", scheduleEnsurePicker);
scheduleEnsurePicker();

function jsonFailure(message, status = 503) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Keep detail.js unchanged for this bounded patch. Every ordinary TV request is
// enriched with an explicit allowed RU profile before it reaches Teleseerr API.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
  const method = init?.method?.toUpperCase() ?? (input instanceof Request ? input.method.toUpperCase() : "GET");

  if (method !== "POST" || !url.includes("/api/request") || typeof init?.body !== "string") {
    return nativeFetch(input, init);
  }

  let body;
  try {
    body = JSON.parse(init.body);
  } catch {
    return nativeFetch(input, init);
  }

  if (body?.mediaType !== "tv") {
    return nativeFetch(input, init);
  }

  const detail = getCurrentDetail();
  if (isAnimeDetail(detail)) {
    return nativeFetch(input, init);
  }

  let data;
  try {
    data = await loadProfiles();
  } catch {
    return jsonFailure("Не удалось загрузить профили Sonarr. Запрос не отправлен.");
  }

  const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
  const autoProfileId = getAutoProfileId(data);
  if (!autoProfileId) {
    return jsonFailure("Профиль RU - Auto недоступен в Sonarr. Запрос не отправлен.");
  }

  const select = document.getElementById(SELECT_ID);
  const domValue = select instanceof HTMLSelectElement ? Number(select.value) : NaN;
  const requestedProfileId = Number.isInteger(domValue) && domValue > 0
    ? domValue
    : selectedProfileId ?? autoProfileId;

  const allowed = profiles.some((profile) => profile.id === requestedProfileId);
  if (!allowed) {
    return jsonFailure("Выбранный профиль озвучки недоступен. Запрос не отправлен.");
  }

  selectedProfileId = requestedProfileId;
  body.profileId = requestedProfileId;
  return nativeFetch(input, { ...init, body: JSON.stringify(body) });
};
