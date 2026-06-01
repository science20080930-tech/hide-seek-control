import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_CONFIG } from "./supabase-config.js";

const DEFAULT_CENTER = { lat: 25.0478, lng: 121.5319 };
const ACTIVE_PLAYER_MS = 15_000;
const REFRESH_PLAYERS_MS = 10_000;
const CONTROL_READ_TIMEOUT_MS = 45_000;
const CONTROL_WRITE_TIMEOUT_MS = 30_000;
const ROOM_SELECT = "*";

const state = {
  supabase: createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  }),
  session: null,
  roomCode: "main",
  room: null,
  map: null,
  channel: null,
  channelToken: 0,
  players: [],
  markers: new Map(),
  refreshTimer: null,
  autoFitMap: true,
  isAutoFitting: false,
  followedPlayerId: "",
  isRoomBusy: false,
  isPolling: false,
  realtimeHealthy: false,
  seenActivePlayerIds: new Set(),
  notifiedDisconnectedIds: new Set(),
  disconnectToastTimer: null,
  suppressDisconnectNotifications: false,
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
  roomMessage: document.querySelector("#roomMessage"),
  redSlots: document.querySelector("#redSlots"),
  greenSlots: document.querySelector("#greenSlots"),
  startGameButton: document.querySelector("#startGameButton"),
  endGameButton: document.querySelector("#endGameButton"),
  broadcastMessage: document.querySelector("#broadcastMessage"),
  sendBroadcastButton: document.querySelector("#sendBroadcastButton"),
  broadcastStatus: document.querySelector("#broadcastStatus"),
  cancelFollowButton: document.querySelector("#cancelFollowButton"),
  loginMessage: document.querySelector("#loginMessage"),
  totalCount: document.querySelector("#totalCount"),
  redCount: document.querySelector("#redCount"),
  greenCount: document.querySelector("#greenCount"),
  playerList: document.querySelector("#playerList"),
  disconnectToast: document.querySelector("#disconnectToast"),
  disconnectToastText: document.querySelector("#disconnectToastText"),
  closeDisconnectToastButton: document.querySelector("#closeDisconnectToastButton"),
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
    render();
    if (session) {
      await watchRoom();
    }
  });
  render();
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
    maxNativeZoom: 20,
    maxZoom: 22,
  }).addTo(state.map);

  state.map.on("zoomstart dragstart", () => {
    if (!state.isAutoFitting) {
      state.autoFitMap = false;
      state.followedPlayerId = "";
      renderFollowControls();
    }
  });
}

function bindEvents() {
  el.loginButton.addEventListener("click", login);
  el.logoutButton.addEventListener("click", logout);
  el.watchButton.addEventListener("click", createOrWatchRoom);
  el.startGameButton.addEventListener("click", startGame);
  el.endGameButton.addEventListener("click", endGame);
  el.sendBroadcastButton.addEventListener("click", sendBroadcast);
  el.closeDisconnectToastButton.addEventListener("click", hideDisconnectToast);
  el.cancelFollowButton.addEventListener("click", cancelFollow);
  el.redSlots.addEventListener("input", render);
  el.greenSlots.addEventListener("input", render);
  el.playerList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-player-id]");
    if (row) {
      followPlayer(row.dataset.playerId);
    }
  });
  el.roomCode.addEventListener("change", () => {
    state.roomCode = cleanRoomCode(el.roomCode.value);
    el.roomCode.value = state.roomCode;
  });

  state.refreshTimer = window.setInterval(() => {
    if (state.session && state.room) {
      refreshRoomSnapshot();
    }
  }, REFRESH_PLAYERS_MS);
}

async function login() {
  const email = el.emailInput.value.trim();
  const password = el.passwordInput.value;
  if (!email || !password) {
    setLoginMessage("請輸入控制員 email 和密碼。");
    return;
  }

  el.loginButton.disabled = true;
  setLoginMessage("正在登入...");
  const { data, error } = await state.supabase.auth.signInWithPassword({ email, password });
  el.loginButton.disabled = false;
  if (error) {
    setLoginMessage(error.message);
    return;
  }

  state.session = data.session;
  setLoginMessage("");
  render();
  await watchRoom();
}

async function logout() {
  await stopWatching();
  state.players = [];
  state.room = null;
  resetDisconnectNotifications();
  await state.supabase.auth.signOut();
  render();
}

async function createOrWatchRoom() {
  if (!state.session) return;
  if (state.isRoomBusy) return;

  const roomCode = cleanRoomCode(el.roomCode.value);
  el.roomCode.value = roomCode;
  state.isRoomBusy = true;
  render();
  setRoomMessage("正在建立或監看房間...");

  try {
    const restRoomSnapshot = await ensureRoomViaRest(roomCode);
    await watchRoom(roomCode, { roomSnapshot: restRoomSnapshot, skipInitialPlayers: true });
    return;

    let roomSnapshot = null;
    const { data: existingRoom, error: readError } = await withTimeout(
      state.supabase
        .from("game_rooms")
        .select("room_code,status,red_slots,green_slots,created_by,updated_at,started_at,ended_at")
        .eq("room_code", roomCode)
        .maybeSingle(),
      "讀取房間逾時，請再按一次建立/監看。",
    );

    if (readError) {
      setRoomMessage(`${readError.message}。請確認 Supabase schema 已更新。`);
      return;
    }

    if (!existingRoom) {
      if (!(await clearRoomSessionData(roomCode))) return;

      const roomPayload = {
        room_code: roomCode,
        status: "lobby",
        created_by: state.session.user.id,
        updated_at: new Date().toISOString(),
        started_at: null,
        ended_at: null,
      };

      const { data, error } = await withTimeout(
        state.supabase.from("game_rooms").insert(roomPayload).select("room_code,status,red_slots,green_slots,created_by,updated_at,started_at,ended_at").single(),
        "建立房間逾時，請再按一次建立/監看。",
      );

      if (error) {
        setRoomMessage(`${error.message}。請確認 Supabase schema 已更新，且此帳號是控制員。`);
        return;
      }
      roomSnapshot = data || roomPayload;
    } else if (existingRoom.status === "ended") {
      if (!(await clearRoomSessionData(roomCode))) return;

      const { data, error } = await withTimeout(
        state.supabase
          .from("game_rooms")
          .update({
            status: "lobby",
            red_slots: null,
            green_slots: null,
            updated_at: new Date().toISOString(),
            started_at: null,
            ended_at: null,
          })
          .eq("room_code", roomCode)
          .select("room_code,status,red_slots,green_slots,created_by,updated_at,started_at,ended_at")
          .single(),
        "重開房間逾時，請再按一次建立/監看。",
      );

      if (error) {
        setRoomMessage(error.message);
        return;
      }
      roomSnapshot = data || { ...existingRoom, status: "lobby", red_slots: null, green_slots: null, started_at: null, ended_at: null };
    } else {
      roomSnapshot = existingRoom;
    }

    await watchRoom(roomCode, { roomSnapshot, skipInitialPlayers: true });
  } catch (error) {
    setRoomMessage(error.message || "建立或監看房間失敗，請再試一次。");
  } finally {
    state.isRoomBusy = false;
    render();
  }
}

async function clearRoomSessionData(roomCode) {
  const { error: playerError } = await withTimeout(
    state.supabase
      .from("game_players")
      .delete()
      .eq("room_code", roomCode),
    "清除上一局玩家資料逾時，房間尚未開放加入。",
  );

  if (playerError) {
    setRoomMessage(playerError.message);
    return false;
  }

  return true;
}

async function ensureRoomViaRest(roomCode) {
  const selectPath = `game_rooms?select=${ROOM_SELECT}&room_code=eq.${encodeURIComponent(roomCode)}&limit=1`;
  const existingRows = await restRequest(selectPath, { method: "GET" }, "讀取房間逾時，請再按一次建立/監看。");
  const existingRoom = Array.isArray(existingRows) ? existingRows[0] : null;

  if (!existingRoom) {
    await restRequest(
      `game_players?room_code=eq.${encodeURIComponent(roomCode)}`,
      { method: "DELETE", headers: { prefer: "return=minimal" } },
      "清除上一局玩家資料逾時，房間尚未開放加入。",
    );

    const roomPayload = {
      room_code: roomCode,
      status: "lobby",
      created_by: state.session.user.id,
      updated_at: new Date().toISOString(),
      started_at: null,
      ended_at: null,
    };
    const insertedRows = await restRequest(
      `game_rooms?select=${ROOM_SELECT}`,
      {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(roomPayload),
      },
      "建立房間逾時，請再按一次建立/監看。",
    );
    return Array.isArray(insertedRows) ? insertedRows[0] : roomPayload;
  }

  if (existingRoom.status !== "ended") {
    return existingRoom;
  }

  await restRequest(
    `game_players?room_code=eq.${encodeURIComponent(roomCode)}`,
    { method: "DELETE", headers: { prefer: "return=minimal" } },
    "清除上一局玩家資料逾時，房間尚未開放加入。",
  );

  const patchPayload = {
    status: "lobby",
    red_slots: null,
    green_slots: null,
    updated_at: new Date().toISOString(),
    started_at: null,
    ended_at: null,
  };
  const updatedRows = await restRequest(
    `game_rooms?select=${ROOM_SELECT}&room_code=eq.${encodeURIComponent(roomCode)}`,
    {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify(patchPayload),
    },
    "重開房間逾時，請再按一次建立/監看。",
  );
  return Array.isArray(updatedRows) ? updatedRows[0] : { ...existingRoom, ...patchPayload };
}

async function watchRoom(nextRoomCode = state.roomCode, options = {}) {
  if (!state.session) return;

  const roomCode = cleanRoomCode(nextRoomCode);
  state.roomCode = roomCode;
  el.roomCode.value = roomCode;
  state.channelToken += 1;
  const token = state.channelToken;

  await stopWatching(false);
  clearMarkers();
  state.players = [];
  state.room = null;
  state.followedPlayerId = "";
  state.autoFitMap = true;
  state.realtimeHealthy = false;
  state.suppressDisconnectNotifications = false;
  resetDisconnectNotifications();
  render();

  if (options.roomSnapshot) {
    state.room = options.roomSnapshot;
  } else {
    await loadRoom();
  }

  if (state.room && options.skipInitialPlayers) {
    loadPlayers({ silent: true });
  } else {
    await loadPlayers();
  }
  if (token !== state.channelToken) return;
  setRoomMessage(state.room ? `正在監看 ${state.roomCode} 房間` : "這個房間尚未建立。");

  state.channel = state.supabase
    .channel(`control-${state.roomCode}-${token}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "game_players",
        filter: `room_code=eq.${state.roomCode}`,
      },
      (payload) => {
        if (token !== state.channelToken || getPayloadRoom(payload) !== state.roomCode) return;
        applyRealtimePlayer(payload);
        render();
      },
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "game_rooms",
        filter: `room_code=eq.${state.roomCode}`,
      },
      (payload) => {
        if (token !== state.channelToken || getPayloadRoom(payload) !== state.roomCode) return;
        applyRealtimeRoom(payload);
        render();
      },
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        state.realtimeHealthy = true;
        setRoomMessage(`正在監看 ${state.roomCode} 房間`);
      }
      if (status === "CHANNEL_ERROR") {
        state.realtimeHealthy = false;
        setRoomMessage(`正在用輪詢監看 ${state.roomCode} 房間`);
      }
    });
}

async function stopWatching(bumpToken = true) {
  if (bumpToken) {
    state.channelToken += 1;
  }
  if (state.channel) {
    await state.supabase.removeChannel(state.channel);
    state.channel = null;
  }
}

async function refreshRoomSnapshot() {
  if (state.isPolling) return;
  state.isPolling = true;
  try {
    await loadRoom({ silent: true });
    await loadPlayers({ silent: true });
  } finally {
    state.isPolling = false;
  }
}

async function loadRoom({ silent = false } = {}) {
  let result;
  try {
    result = await withTimeout(
      state.supabase
        .from("game_rooms")
        .select(ROOM_SELECT)
        .eq("room_code", state.roomCode)
        .maybeSingle(),
      "讀取房間狀態逾時。",
      CONTROL_READ_TIMEOUT_MS,
    );
  } catch (error) {
    if (!silent) setRoomMessage(state.room ? "連線暫時不穩，已保留目前房間狀態。" : error.message);
    return;
  }

  const { data, error } = result;

  if (error) {
    if (!silent) setRoomMessage(`${error.message}。請確認此帳號已加入 control_operators。`);
    return;
  }

  state.room = data;
}

async function loadPlayers({ silent = false } = {}) {
  if (!state.room) return;

  let result;
  try {
    result = await withTimeout(
      state.supabase
        .from("game_players")
        .select("user_id,email,display_name,team,room_code,lat,lng,accuracy,is_online,updated_at")
        .eq("room_code", state.roomCode)
        .order("updated_at", { ascending: false }),
      "讀取玩家位置逾時。",
      CONTROL_READ_TIMEOUT_MS,
    );
  } catch (error) {
    if (!silent) setRoomMessage(state.players.length ? "連線暫時不穩，已保留目前玩家位置。" : error.message);
    return;
  }

  const { data, error } = result;

  if (error) {
    if (!silent) setRoomMessage(`${error.message}。請確認此帳號已加入 control_operators。`);
    if (!silent) state.players = [];
    render();
    return;
  }

  state.players = data.map(fromDatabasePlayer);
  updateDisconnectNotifications();
  render();
}

function applyRealtimePlayer(payload) {
  if (payload.eventType === "DELETE" && payload.old?.user_id) {
    state.players = state.players.filter((player) => player.userId !== payload.old.user_id);
    if (state.followedPlayerId === payload.old.user_id) {
      state.followedPlayerId = "";
    }
    return;
  }

  if (!payload.new?.user_id) return;

  const next = fromDatabasePlayer(payload.new);
  const index = state.players.findIndex((player) => player.userId === next.userId);
  if (index >= 0) {
    state.players[index] = next;
  } else {
    state.players.push(next);
  }
  updateDisconnectNotifications();
}

function applyRealtimeRoom(payload) {
  if (payload.eventType === "DELETE") {
    state.room = null;
    return;
  }
  if (payload.new?.room_code) {
    state.room = payload.new;
  }
}

async function startGame() {
  if (state.isRoomBusy) return;

  const players = getActivePlayers();
  const redSlots = getSlotValue(el.redSlots);
  const greenSlots = getSlotValue(el.greenSlots);

  if (!state.room || state.room.status !== "lobby") {
    setRoomMessage("只有等待中的房間可以開始。");
    return;
  }
  if (redSlots + greenSlots !== players.length || players.length === 0) {
    setRoomMessage("紅隊與綠隊人數加總必須等於目前在線玩家總數。");
    return;
  }

  state.isRoomBusy = true;
  el.startGameButton.disabled = true;
  render();
  setRoomMessage("正在隨機分配隊伍...");

  try {
    const shuffled = shuffle(players);
    const assignments = shuffled.map((player, index) => ({
      player,
      team: index < redSlots ? "red" : "green",
    }));

    const assignmentResults = await Promise.all(
      assignments.map((assignment) =>
        withTimeout(
          state.supabase
            .from("game_players")
            .update({
              team: assignment.team,
              updated_at: new Date().toISOString(),
            })
            .eq("room_code", state.roomCode)
            .eq("user_id", assignment.player.userId),
          `分配 ${assignment.player.name} 隊伍逾時，請再按一次開始遊戲。`,
          CONTROL_WRITE_TIMEOUT_MS,
        ),
      ),
    );

    const assignmentError = assignmentResults.find((result) => result.error)?.error;
    if (assignmentError) {
      setRoomMessage(assignmentError.message);
      return;
    }

    const startedAt = new Date().toISOString();
    const roomResult = await withTimeout(
      state.supabase
        .from("game_rooms")
        .update({
          status: "started",
          red_slots: redSlots,
          green_slots: greenSlots,
          updated_at: startedAt,
          started_at: startedAt,
          ended_at: null,
        })
        .eq("room_code", state.roomCode),
      "開始遊戲逾時，請確認玩家端是否已進入遊戲。",
      CONTROL_WRITE_TIMEOUT_MS,
    );

    if (roomResult.error) {
      setRoomMessage(roomResult.error.message);
      return;
    }

    assignments.forEach((assignment) => {
      const player = state.players.find((item) => item.userId === assignment.player.userId);
      if (player) {
        player.team = assignment.team;
        player.updatedAt = startedAt;
      }
    });
    state.room = {
      ...state.room,
      status: "started",
      red_slots: redSlots,
      green_slots: greenSlots,
      updated_at: startedAt,
      started_at: startedAt,
      ended_at: null,
    };
    setRoomMessage("遊戲已開始。");
    refreshRoomSnapshot();
  } catch (error) {
    setRoomMessage(error.message || "開始遊戲失敗，請再試一次。");
  } finally {
    state.isRoomBusy = false;
    render();
  }
}

async function endGame() {
  if (!state.room) return;
  const ok = window.confirm(`確定要結束 ${state.roomCode} 房間的遊戲並清除定位資料嗎？`);
  if (!ok) return;

  state.suppressDisconnectNotifications = true;
  hideDisconnectToast();

  setRoomMessage("正在結束遊戲...");
  const { error: roomError } = await state.supabase
    .from("game_rooms")
    .update({
      status: "ended",
      updated_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
    })
    .eq("room_code", state.roomCode);

  if (roomError) {
    setRoomMessage(roomError.message);
    return;
  }

  const { error: playerError } = await state.supabase
    .from("game_players")
    .update({
      lat: null,
      lng: null,
      accuracy: null,
      is_online: false,
      updated_at: new Date().toISOString(),
    })
    .eq("room_code", state.roomCode);

  if (playerError) {
    setRoomMessage(playerError.message);
    return;
  }

  await stopWatching();
  state.players = [];
  state.followedPlayerId = "";
  clearMarkers();
  await loadRoom();
  setRoomMessage("遊戲已結束，已清除定位資料並暫停監控。");
  render();
}

async function sendBroadcast() {
  if (!state.room) {
    setBroadcastStatus("請先建立或監看房間。");
    return;
  }

  const message = el.broadcastMessage.value.trim();
  if (!message) {
    setBroadcastStatus("請先輸入要發送的訊息。");
    return;
  }

  el.sendBroadcastButton.disabled = true;
  setBroadcastStatus("正在發送...");
  const payload = {
    broadcast_message: message,
    broadcast_sender: state.session.user.email || "主持人",
    broadcast_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  try {
    const rows = await restRequest(
      `game_rooms?select=${ROOM_SELECT}&room_code=eq.${encodeURIComponent(state.roomCode)}`,
      {
        method: "PATCH",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(payload),
      },
      "發送訊息逾時，請再試一次。",
    );
    state.room = Array.isArray(rows) ? rows[0] : { ...state.room, ...payload };
    el.broadcastMessage.value = "";
    setBroadcastStatus("已發送給所有玩家。");
    render();
  } catch (error) {
    setBroadcastStatus(error.message || "發送失敗，請再試一次。");
  } finally {
    el.sendBroadcastButton.disabled = false;
  }
}

function followPlayer(playerId) {
  const player = state.players.find((item) => item.userId === playerId);
  if (!player) return;
  state.followedPlayerId = playerId;
  state.autoFitMap = false;
  focusPlayer(player, 20);
  render();
}

function cancelFollow() {
  state.followedPlayerId = "";
  state.autoFitMap = false;
  render();
}

function focusPlayer(player, zoom = Math.max(state.map.getZoom(), 19)) {
  state.isAutoFitting = true;
  state.map.setView([player.lat, player.lng], zoom, { animate: true });
  state.map.once("moveend", () => {
    state.isAutoFitting = false;
  });
  window.setTimeout(() => {
    state.isAutoFitting = false;
  }, 400);
}

function fromDatabasePlayer(record) {
  return {
    id: record.user_id,
    userId: record.user_id,
    email: record.email || "",
    name: record.display_name || record.email || "玩家",
    team: record.team || "",
    roomCode: record.room_code || state.roomCode,
    lat: record.lat === null || record.lat === undefined ? null : Number(record.lat),
    lng: record.lng === null || record.lng === undefined ? null : Number(record.lng),
    accuracy: record.accuracy || 0,
    isOnline: record.is_online !== false,
    updatedAt: record.updated_at,
  };
}

function render() {
  renderShell();
  renderRoomControls();
  renderBroadcastControls();
  renderStats();
  renderList();
  renderMarkers();
  renderFollowControls();
}

function renderShell() {
  const loggedIn = Boolean(state.session);
  el.loginPanel.classList.toggle("hidden", loggedIn);
  el.roomPanel.classList.toggle("hidden", !loggedIn);
  el.statusText.textContent = loggedIn
    ? state.room
      ? `${state.roomCode} · ${getRoomStatusLabel()}`
      : "已登入，請建立或監看房間"
    : "等待登入";
}

function renderRoomControls() {
  const players = getActivePlayers();
  const redSlots = getSlotValue(el.redSlots);
  const greenSlots = getSlotValue(el.greenSlots);
  const isLobby = state.room?.status === "lobby";
  const isStarted = state.room?.status === "started";
  const validCounts = isLobby && players.length > 0 && redSlots + greenSlots === players.length;

  el.watchButton.disabled = state.isRoomBusy;
  el.startGameButton.disabled = state.isRoomBusy || !validCounts;
  el.endGameButton.disabled = state.isRoomBusy || !state.room || state.room.status === "ended";
  el.redSlots.disabled = state.isRoomBusy || !isLobby;
  el.greenSlots.disabled = state.isRoomBusy || !isLobby;

  if (!state.room) {
    el.startGameButton.textContent = "開始遊戲";
    return;
  }

  el.startGameButton.textContent = validCounts ? "開始遊戲" : `等待人數正確 (${redSlots + greenSlots}/${players.length})`;
  if (isStarted) {
    el.startGameButton.textContent = "遊戲進行中";
  }
}

function renderBroadcastControls() {
  const canSend = Boolean(state.session && state.room && state.room.status !== "ended");
  el.broadcastMessage.disabled = !canSend;
  el.sendBroadcastButton.disabled = !canSend;
  if (!canSend && !state.room) {
    setBroadcastStatus("請先建立或監看房間。");
  }
}

function renderStats() {
  const players = getActivePlayers();
  el.totalCount.textContent = players.length;
  el.redCount.textContent = players.filter((player) => player.team === "red").length;
  el.greenCount.textContent = players.filter((player) => player.team === "green").length;
}

function renderList() {
  const players = getActivePlayers();
  const disconnectedPlayers = getDisconnectedPlayers();

  if (!state.room) {
    el.playerList.innerHTML = emptyRow("尚未監看房間", "請先建立或輸入房間代碼。");
    return;
  }

  if (!players.length && !disconnectedPlayers.length) {
    el.playerList.innerHTML = emptyRow("目前沒有在線玩家", "玩家加入此房間並持續同步定位後會出現在這裡。");
    return;
  }

  const activeRows = players
    .map((player) => {
      const teamLabel = player.team === "red" ? "紅隊" : player.team === "green" ? "綠隊" : "未分隊";
      const time = player.updatedAt ? new Date(player.updatedAt).toLocaleTimeString("zh-TW") : "--";
      const activeClass = player.userId === state.followedPlayerId ? " following" : "";
      return `
        <button class="player-row${activeClass}" type="button" data-player-id="${escapeHtml(player.userId)}">
          <span class="player-dot ${player.team === "red" ? "red-dot" : player.team === "green" ? "green-dot" : "waiting-dot"}"></span>
          <span>
            <strong>${escapeHtml(player.name)}</strong>
            <small>${teamLabel} · ±${player.accuracy || "--"}m · ${time}</small>
          </span>
          <span class="row-action">追蹤</span>
        </button>
      `;
    })
    .join("");
  const disconnectedRows = disconnectedPlayers
    .map((player) => `
      <div class="player-row disconnected">
        <span class="player-dot waiting-dot"></span>
        <span>
          <strong>${escapeHtml(player.name)}已斷開連線</strong>
          <small>定位已關閉或連線中斷</small>
        </span>
        <span class="row-action">斷線</span>
      </div>
    `)
    .join("");

  el.playerList.innerHTML = activeRows + disconnectedRows;
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
      html: `<span class="control-marker ${player.team || "waiting"}">${getMarkerText(player)}</span>`,
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

  const followed = players.find((player) => player.userId === state.followedPlayerId);
  if (followed) {
    focusPlayer(followed);
    return;
  }

  if (players.length && state.autoFitMap) {
    const group = L.featureGroup([...state.markers.values()]);
    state.isAutoFitting = true;
    state.map.fitBounds(group.getBounds().pad(0.2), { maxZoom: 20 });
    state.map.once("moveend", () => {
      state.isAutoFitting = false;
    });
    window.setTimeout(() => {
      state.isAutoFitting = false;
    }, 400);
  }
}

function renderFollowControls() {
  const followed = state.players.find((player) => player.userId === state.followedPlayerId);
  el.cancelFollowButton.classList.toggle("hidden", !followed);
  el.cancelFollowButton.textContent = followed ? `取消追蹤：${followed.name}` : "取消追蹤";
}

function getActivePlayers() {
  return state.players.filter(isPlayerActive);
}

function getDisconnectedPlayers() {
  return state.players.filter((player) => !isPlayerActive(player));
}

function updateDisconnectNotifications() {
  if (state.suppressDisconnectNotifications || state.room?.status === "ended") return;

  state.players.forEach((player) => {
    if (isPlayerActive(player)) {
      state.seenActivePlayerIds.add(player.userId);
      state.notifiedDisconnectedIds.delete(player.userId);
      return;
    }

    if (!state.seenActivePlayerIds.has(player.userId)) return;
    if (state.notifiedDisconnectedIds.has(player.userId)) return;

    state.notifiedDisconnectedIds.add(player.userId);
    showDisconnectToast(`${player.name}已斷開連線`);
  });
}

function showDisconnectToast(message) {
  if (state.disconnectToastTimer) {
    window.clearTimeout(state.disconnectToastTimer);
  }
  el.disconnectToastText.textContent = message;
  el.disconnectToast.classList.remove("hidden");
  state.disconnectToastTimer = window.setTimeout(() => {
    hideDisconnectToast();
  }, 10000);
}

function hideDisconnectToast() {
  if (state.disconnectToastTimer) {
    window.clearTimeout(state.disconnectToastTimer);
    state.disconnectToastTimer = null;
  }
  el.disconnectToast.classList.add("hidden");
}

function resetDisconnectNotifications() {
  state.seenActivePlayerIds.clear();
  state.notifiedDisconnectedIds.clear();
  hideDisconnectToast();
}

function isPlayerActive(player) {
  if (!player.isOnline) return false;
  if (!Number.isFinite(player.lat) || !Number.isFinite(player.lng)) return false;
  if (!player.updatedAt) return false;
  const updatedAt = Date.parse(player.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt <= ACTIVE_PLAYER_MS;
}

function getPayloadRoom(payload) {
  return payload.new?.room_code || payload.old?.room_code || "";
}

function getSlotValue(input) {
  return Math.max(0, Number.parseInt(input.value, 10) || 0);
}

function getRoomStatusLabel() {
  if (state.room?.status === "started") return "遊戲中";
  if (state.room?.status === "ended") return "已結束";
  if (state.room?.status === "lobby") return "等待開始";
  return "未建立";
}

function getMarkerText(player) {
  if (player.team === "red") return "紅";
  if (player.team === "green") return "綠";
  return "等";
}

function emptyRow(title, detail) {
  return `
    <div class="player-row empty-row">
      <span class="player-dot waiting-dot"></span>
      <span>
        <strong>${title}</strong>
        <small>${detail}</small>
      </span>
    </div>
  `;
}

function shuffle(items) {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[randomIndex]] = [next[randomIndex], next[index]];
  }
  return next;
}

function clearMarkers() {
  state.markers.forEach((marker) => marker.remove());
  state.markers.clear();
}

function withTimeout(promise, message, timeoutMs = 20000) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const request = controller && typeof promise?.abortSignal === "function" ? promise.abortSignal(controller.signal) : promise;
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      controller?.abort();
      reject(new Error(message));
    }, timeoutMs);
  });
  return Promise.race([request, timeout]).finally(() => {
    window.clearTimeout(timeoutId);
  });
}

async function restRequest(path, options = {}, message = "連線逾時，請再試一次。", timeoutMs = 12000) {
  if (!state.session?.access_token) throw new Error("請先登入控制台。");

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        apikey: SUPABASE_CONFIG.anonKey,
        authorization: `Bearer ${state.session.access_token}`,
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(detail || `Supabase 回應錯誤：${response.status}`);
    }

    if (response.status === 204) return null;
    return response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error(message);
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function setLoginMessage(message) {
  el.loginMessage.textContent = message;
}

function setRoomMessage(message) {
  el.roomMessage.textContent = message;
}

function setBroadcastStatus(message) {
  el.broadcastStatus.textContent = message;
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
