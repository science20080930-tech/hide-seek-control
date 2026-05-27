import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_CONFIG } from "./supabase-config.js";

const DEFAULT_CENTER = { lat: 25.0478, lng: 121.5319 };
const ACTIVE_PLAYER_MS = 20_000;
const REFRESH_PLAYERS_MS = 5_000;

const state = {
  supabase: createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  }),
  session: null,
  roomCode: "main",
  map: null,
  channel: null,
  players: [],
  markers: new Map(),
  refreshTimer: null,
};

const el = {
  statusText: document.querySelector("#statusText"),
  loginPanel: document.querySelector("#loginPanel"),
  roomPanel: document.querySelector("#roomPanel"),
  emailInput: document.querySelector("#emailInput"),
  passwordInput: document.querySelector("#passwordInput"),
  loginButton: document.querySelector("#loginButton"),
  logoutButton: document.querySelector("#logoutButton"),
  watchButton: document.querySelector("#watchButton"),
  roomCode: document.querySelector("#roomCode"),
  loginMessage: document.querySelector("#loginMessage"),
  totalCount: document.querySelector("#totalCount"),
  redCount: document.querySelector("#redCount"),
  greenCount: document.querySelector("#greenCount"),
  playerList: document.querySelector("#playerList"),
  map: document.querySelector("#map"),
};

boot();

async function boot() {
  initMap();
  bindEvents();
  const { data } = await state.supabase.auth.getSession();
  state.session = data.session;
  state.supabase.auth.onAuthStateChange(async (_event, session) => {
    state.session = session;
    renderShell();
    if (session) {
      await watchRoom();
    }
  });
  renderShell();
  if (state.session) {
    await watchRoom();
  }
}

function initMap() {
  state.map = L.map(el.map, {
    zoomControl: true,
    attributionControl: false,
    preferCanvas: true,
  }).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], 17);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
  }).addTo(state.map);
}

function bindEvents() {
  el.loginButton.addEventListener("click", login);
  el.logoutButton.addEventListener("click", logout);
  el.watchButton.addEventListener("click", watchRoom);
  el.roomCode.addEventListener("change", () => {
    state.roomCode = cleanRoomCode(el.roomCode.value);
    el.roomCode.value = state.roomCode;
  });

  state.refreshTimer = window.setInterval(() => {
    if (state.session) {
      loadPlayers();
    }
  }, REFRESH_PLAYERS_MS);
}

async function login() {
  const email = el.emailInput.value.trim();
  const password = el.passwordInput.value;
  if (!email || !password) {
    setMessage("請輸入控制員 email 和密碼。");
    return;
  }

  const { error } = await state.supabase.auth.signInWithPassword({ email, password });
  if (error) {
    setMessage(error.message);
  }
}

async function logout() {
  if (state.channel) {
    await state.supabase.removeChannel(state.channel);
    state.channel = null;
  }
  state.players = [];
  await state.supabase.auth.signOut();
  render();
}

async function watchRoom() {
  if (!state.session) return;

  state.roomCode = cleanRoomCode(el.roomCode.value);
  el.roomCode.value = state.roomCode;
  await loadPlayers();

  if (state.channel) {
    await state.supabase.removeChannel(state.channel);
  }

  state.channel = state.supabase
    .channel(`control-${state.roomCode}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "game_players",
        filter: `room_code=eq.${state.roomCode}`,
      },
      (payload) => {
        applyRealtimePayload(payload);
        render();
      },
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        el.statusText.textContent = `正在監看 ${state.roomCode} 房間`;
      }
      if (status === "CHANNEL_ERROR") {
        el.statusText.textContent = "Realtime 連線失敗";
      }
    });
}

async function loadPlayers() {
  const { data, error } = await state.supabase
    .from("game_players")
    .select("user_id,email,display_name,team,room_code,lat,lng,accuracy,is_online,updated_at")
    .eq("room_code", state.roomCode)
    .eq("is_online", true)
    .gte("updated_at", getActiveSinceIso())
    .order("updated_at", { ascending: false });

  if (error) {
    setMessage(`${error.message}。請確認此帳號已加入 control_operators。`);
    state.players = [];
    render();
    return;
  }

  state.players = data.map(fromDatabasePlayer);
  render();
}

function applyRealtimePayload(payload) {
  if (payload.eventType === "DELETE" && payload.old?.user_id) {
    state.players = state.players.filter((player) => player.userId !== payload.old.user_id);
    return;
  }

  if (!payload.new?.user_id) return;

  const next = fromDatabasePlayer(payload.new);
  if (!isPlayerActive(next)) {
    state.players = state.players.filter((player) => player.userId !== next.userId);
    return;
  }

  const index = state.players.findIndex((player) => player.userId === next.userId);
  if (index >= 0) {
    state.players[index] = next;
  } else {
    state.players.push(next);
  }
}

function fromDatabasePlayer(record) {
  return {
    id: record.user_id,
    userId: record.user_id,
    email: record.email || "",
    name: record.display_name || record.email || "玩家",
    team: record.team === "green" ? "green" : "red",
    roomCode: record.room_code || state.roomCode,
    lat: Number(record.lat || DEFAULT_CENTER.lat),
    lng: Number(record.lng || DEFAULT_CENTER.lng),
    accuracy: record.accuracy || 0,
    isOnline: record.is_online !== false,
    updatedAt: record.updated_at,
  };
}

function renderShell() {
  const loggedIn = Boolean(state.session);
  el.loginPanel.classList.toggle("hidden", loggedIn);
  el.roomPanel.classList.toggle("hidden", !loggedIn);
  el.statusText.textContent = loggedIn
    ? state.channel
      ? `正在監看 ${state.roomCode} 房間`
      : "已登入，等待監看"
    : "等待登入";
}

function render() {
  renderShell();
  renderStats();
  renderList();
  renderMarkers();
}

function renderStats() {
  const players = getActivePlayers();
  el.totalCount.textContent = players.length;
  el.redCount.textContent = players.filter((player) => player.team === "red").length;
  el.greenCount.textContent = players.filter((player) => player.team === "green").length;
}

function renderList() {
  const players = getActivePlayers();

  if (!players.length) {
    el.playerList.innerHTML = `
      <div class="player-row">
        <span class="player-dot"></span>
        <span>
          <strong>目前沒有在線玩家</strong>
          <small>玩家登入、選隊並持續同步定位後會出現在這裡</small>
        </span>
      </div>
    `;
    return;
  }

  el.playerList.innerHTML = players
    .map((player) => {
      const teamLabel = player.team === "red" ? "紅隊" : "綠隊";
      const onlineLabel = player.isOnline ? "在線" : "離線";
      const time = player.updatedAt ? new Date(player.updatedAt).toLocaleTimeString("zh-TW") : "--";
      return `
        <div class="player-row">
          <span class="player-dot ${player.team === "red" ? "red-dot" : "green-dot"}"></span>
          <span>
            <strong>${escapeHtml(player.name)}</strong>
            <small>${teamLabel} · ${onlineLabel} · ±${player.accuracy || "--"}m · ${time}</small>
          </span>
        </div>
      `;
    })
    .join("");
}

function renderMarkers() {
  const players = getActivePlayers();
  const visibleIds = new Set(players.map((player) => player.id));

  state.markers.forEach((marker, id) => {
    if (!visibleIds.has(id)) {
      marker.remove();
      state.markers.delete(id);
    }
  });

  players.forEach((player) => {
    const icon = L.divIcon({
      html: `<span class="control-marker ${player.team}">${player.team === "red" ? "紅" : "綠"}</span>`,
      className: "",
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    const latLng = [player.lat, player.lng];

    if (!state.markers.has(player.id)) {
      state.markers.set(player.id, L.marker(latLng, { icon }).addTo(state.map));
    } else {
      state.markers.get(player.id).setLatLng(latLng).setIcon(icon);
    }
  });

  if (players.length) {
    const group = L.featureGroup([...state.markers.values()]);
    state.map.fitBounds(group.getBounds().pad(0.2), { maxZoom: 17 });
  }
}

function getActivePlayers() {
  return state.players.filter(isPlayerActive);
}

function isPlayerActive(player) {
  if (!player.isOnline) return false;
  if (!player.updatedAt) return false;
  const updatedAt = Date.parse(player.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt <= ACTIVE_PLAYER_MS;
}

function getActiveSinceIso() {
  return new Date(Date.now() - ACTIVE_PLAYER_MS).toISOString();
}

function setMessage(message) {
  el.loginMessage.textContent = message;
}

function cleanRoomCode(value) {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return cleaned || "main";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
