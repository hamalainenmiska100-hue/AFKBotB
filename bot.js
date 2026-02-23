'use strict';

/*
 * AFKBot (Discord-controlled Minecraft Bedrock AFK client)
 *
 * IMPORTANT stability fix:
 * This file runs in two modes:
 *  - Parent (default): Discord + persistence + session orchestration.
 *  - Worker (AFKBOT_WORKER=1): owns bedrock-protocol client.
 *
 * Reason: bedrock-protocol uses native code (RakNet). Native crashes (SIGSEGV/SIGABRT)
 * can bring down the whole Fly machine if they happen in the main process.
 * By isolating Bedrock connections in worker processes, any native crash only
 * kills the worker and the parent keeps running.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const IS_WORKER = process.env.AFKBOT_WORKER === '1';

// ==================== CONFIGURATION ====================

const CONFIG = {
  ADMIN_ID: '1144987924123881564',
  LOG_CHANNEL_ID: '1464615030111731753',

  SAVE_DEBOUNCE_MS: 100,

  MAX_RECONNECT_ATTEMPTS: 10,
  RECONNECT_BASE_DELAY_MS: 10_000,
  RECONNECT_MAX_DELAY_MS: 300_000,

  CONNECTION_TIMEOUT_MS: 30_000,
  KEEPALIVE_INTERVAL_MS: 15_000,
  STALE_CONNECTION_TIMEOUT_MS: 60_000,
  MEMORY_CHECK_INTERVAL_MS: 60_000,
  MAX_MEMORY_MB: 1536,

  // Worker lifecycle
  WORKER_STOP_GRACE_MS: 2_000,
  WORKER_FORCE_KILL_MS: 6_000,

  // AFK behaviour
  AFK_START_DELAY_MS: 5_000,
  AFK_MIN_DELAY_MS: 8_000,
  AFK_MAX_DELAY_MS: 20_000,

  // Misc
  SESSION_RESTORE_DELAY_MS: 8_000,
};

// Determine base path for persisting user and session data. Fly.io exposes
// FLY_VOLUME_PATH, but falls back to /data locally.
const DATA = process.env.FLY_VOLUME_PATH || '/data';
const AUTH_ROOT = path.join(DATA, 'auth');
const STORE = path.join(DATA, 'users.json');
const REJOIN_STORE = path.join(DATA, 'rejoin.json');
const CRASH_LOG = path.join(DATA, 'crash.log');

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
    return true;
  } catch (e) {
    console.error(`Failed to create directory ${dir}:`, e?.message || e);
    return false;
  }
}

// ==================== WORKER MODE ====================

async function runWorker() {
  // Worker owns the Bedrock client (native code lives here).
  // Avoid importing Discord libs in the worker.
  const bedrock = require('bedrock-protocol');

  const state = {
    uid: null,
    client: null,
    connected: false,
    entityId: null,
    position: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    tick: 0,

    stopping: false,

    // timers
    timers: new Set(),
    intervals: new Set(),

    // for stale guards
    runId: null,
    lastPacketTime: Date.now(),
    lastKeepalive: Date.now(),
  };

  function send(msg) {
    try {
      if (typeof process.send === 'function') process.send(msg);
    } catch (_) {}
  }

  function addTimeout(t) {
    state.timers.add(t);
    return t;
  }

  function addInterval(i) {
    state.intervals.add(i);
    return i;
  }

  function clearAllTimers() {
    for (const t of state.timers) clearTimeout(t);
    for (const i of state.intervals) clearInterval(i);
    state.timers.clear();
    state.intervals.clear();
  }

  function safeWrite(name, data) {
    if (!state.client || state.stopping || !state.connected) return;
    try {
      state.client.write(name, data);
    } catch (e) {
      // Never throw from worker loop; parent will handle reconnect if worker exits.
      send({ type: 'worker_log', level: 'warn', uid: state.uid, message: `write(${name}) failed: ${e?.message || e}` });
    }
  }

  function safeQueue(name, data) {
    if (!state.client || state.stopping || !state.connected) return;
    try {
      state.client.queue(name, data);
    } catch (e) {
      send({ type: 'worker_log', level: 'warn', uid: state.uid, message: `queue(${name}) failed: ${e?.message || e}` });
    }
  }

  function shutdown(code, reason) {
    if (state.stopping) return;
    state.stopping = true;

    clearAllTimers();

    // IMPORTANT: Do NOT call client.close() here.
    // bedrock-protocol uses native RakNet; calling close() in certain error
    // states can trigger double-free/invalid-pointer aborts.
    // Exiting the process safely releases OS resources and avoids those crashes.
    try {
      if (state.client) {
        try {
          state.client.removeAllListeners();
        } catch (_) {}
      }
    } catch (_) {}

    send({ type: 'worker_exit', uid: state.uid, code, reason: reason || null });

    // Small delay to flush IPC.
    const t = setTimeout(() => process.exit(code), 50);
    // Let the worker exit even if the event loop is busy.
    t.unref?.();
  }

  function startHealthMonitoring(runId) {
    // keepalive
    const keepalive = addInterval(() => {
      if (state.stopping || !state.connected || !state.client || state.runId !== runId) return;
      try {
        safeQueue('client_cache_status', { enabled: false });
        state.lastKeepalive = Date.now();
      } catch (_) {}
    }, CONFIG.KEEPALIVE_INTERVAL_MS);
    keepalive.unref?.();

    // stale connection detection
    const stale = addInterval(() => {
      if (state.stopping || !state.client || state.runId !== runId) return;
      if (!state.connected) return;
      const lastActivity = Math.max(state.lastPacketTime || 0, state.lastKeepalive || 0);
      if (Date.now() - lastActivity > CONFIG.STALE_CONNECTION_TIMEOUT_MS) {
        send({ type: 'mc_stale', uid: state.uid });
        shutdown(0, 'STALE');
      }
    }, CONFIG.STALE_CONNECTION_TIMEOUT_MS);
    stale.unref?.();
  }

  function scheduleAntiAfk(runId) {
    const doAfk = () => {
      if (state.stopping || !state.connected || !state.client || state.runId !== runId) return;
      if (!state.entityId) {
        const next = addTimeout(doAfk, 2000);
        next.unref?.();
        return;
      }

      try {
        const r = Math.random();

        // Hand swing
        if (r < 0.4) {
          safeWrite('animate', { action_id: 1, runtime_entity_id: state.entityId });

          // Crouch: start sneak = 11, stop sneak = 12
        } else if (r < 0.6) {
          safeWrite('player_action', {
            runtime_entity_id: state.entityId,
            action: 11,
            position: state.position,
            result_position: state.position,
            face: 0,
          });

          const stopDelay = 2000 + Math.random() * 2000;
          const t = addTimeout(() => {
            if (state.stopping || !state.connected || !state.client || state.runId !== runId || !state.entityId) return;
            safeWrite('player_action', {
              runtime_entity_id: state.entityId,
              action: 12,
              position: state.position,
              result_position: state.position,
              face: 0,
            });
          }, stopDelay);
          t.unref?.();

          // Jump
        } else if (r < 0.8) {
          safeWrite('player_action', {
            runtime_entity_id: state.entityId,
            action: 8,
            position: state.position,
            result_position: state.position,
            face: 0,
          });

          const original = { ...state.position };
          const jumpPos = { x: original.x, y: original.y + 0.5, z: original.z };

          state.tick = (state.tick || 0) + 1;
          safeQueue('move_player', {
            runtime_entity_id: state.entityId,
            position: jumpPos,
            pitch: state.pitch || 0,
            yaw: state.yaw || 0,
            head_yaw: state.yaw || 0,
            on_ground: false,
            mode: 0,
            tick: state.tick,
          });

          const t = addTimeout(() => {
            if (state.stopping || !state.connected || !state.client || state.runId !== runId || !state.entityId) return;
            state.tick = (state.tick || 0) + 1;
            safeQueue('move_player', {
              runtime_entity_id: state.entityId,
              position: original,
              pitch: state.pitch || 0,
              yaw: state.yaw || 0,
              head_yaw: state.yaw || 0,
              on_ground: true,
              mode: 0,
              tick: state.tick,
            });
            state.position = { x: original.x, y: original.y, z: original.z };
          }, 400 + Math.random() * 200);
          t.unref?.();

          // Walk
        } else {
          const dx = (Math.random() - 0.5) * 0.5;
          const dz = (Math.random() - 0.5) * 0.5;
          state.position.x += dx;
          state.position.z += dz;

          state.tick = (state.tick || 0) + 1;
          safeQueue('move_player', {
            runtime_entity_id: state.entityId,
            position: { x: state.position.x, y: state.position.y, z: state.position.z },
            pitch: state.pitch || 0,
            yaw: state.yaw || 0,
            head_yaw: state.yaw || 0,
            on_ground: true,
            mode: 0,
            tick: state.tick,
          });
        }
      } catch (e) {
        // ignore
      }

      const nextDelay = CONFIG.AFK_MIN_DELAY_MS + Math.random() * (CONFIG.AFK_MAX_DELAY_MS - CONFIG.AFK_MIN_DELAY_MS);
      const t = addTimeout(doAfk, nextDelay);
      t.unref?.();
    };

    const start = addTimeout(doAfk, CONFIG.AFK_START_DELAY_MS);
    start.unref?.();
  }

  function startClient(startMsg) {
    const { uid, runId, opts } = startMsg || {};
    if (!uid || !opts) {
      send({ type: 'worker_log', level: 'error', uid: uid || null, message: 'Worker start message missing uid/opts' });
      shutdown(1, 'BAD_START');
      return;
    }

    state.uid = String(uid);
    state.runId = String(runId || Date.now());

    try {
      const mc = bedrock.createClient(opts);
      state.client = mc;

      mc.on('spawn', () => {
        send({ type: 'mc_spawn', uid: state.uid });
      });

      mc.on('start_game', (packet) => {
        if (!packet) return;
        state.entityId = packet.runtime_entity_id;
        state.connected = true;

        state.position = {
          x: packet.player_position?.x || 0,
          y: packet.player_position?.y || 0,
          z: packet.player_position?.z || 0,
        };
        state.yaw = (packet.rotation && packet.rotation.y) || 0;
        state.pitch = (packet.rotation && packet.rotation.x) || 0;

        state.lastPacketTime = Date.now();
        state.lastKeepalive = Date.now();

        send({
          type: 'mc_connected',
          uid: state.uid,
          entityId: state.entityId,
          position: state.position,
          yaw: state.yaw,
          pitch: state.pitch,
        });

        startHealthMonitoring(state.runId);
        scheduleAntiAfk(state.runId);
      });

      mc.on('packet', (data, meta) => {
        state.lastPacketTime = Date.now();
        try {
          if (!data || !meta) return;
          if (meta.name === 'move_player' && data?.position) {
            state.position = { x: data.position.x, y: data.position.y, z: data.position.z };
            if (typeof data.yaw === 'number') state.yaw = data.yaw;
            if (typeof data.pitch === 'number') state.pitch = data.pitch;
          }
        } catch (_) {}
      });

      mc.on('disconnect', (packet) => {
        const reason = packet?.reason || 'Unknown reason';
        send({ type: 'mc_disconnect', uid: state.uid, reason });
      });

      mc.on('close', () => {
        send({ type: 'mc_close', uid: state.uid });
        shutdown(0, 'CLOSE');
      });

      mc.on('error', (e) => {
        send({ type: 'mc_error', uid: state.uid, message: e?.message || String(e) });
        // Exit; parent will reconnect if needed.
        shutdown(1, 'ERROR');
      });

      // Guard: if we do not connect within timeout + small buffer, exit.
      const guard = addTimeout(() => {
        if (state.stopping) return;
        if (!state.connected) {
          send({ type: 'mc_error', uid: state.uid, message: 'Connect guard timeout' });
          shutdown(1, 'CONNECT_GUARD_TIMEOUT');
        }
      }, CONFIG.CONNECTION_TIMEOUT_MS + 5000);
      guard.unref?.();

      send({ type: 'worker_log', level: 'info', uid: state.uid, message: 'Worker bedrock client started' });
    } catch (e) {
      send({ type: 'mc_error', uid: state.uid, message: e?.message || String(e) });
      shutdown(1, 'CREATE_FAILED');
    }
  }

  process.on('message', (msg) => {
    try {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'start') {
        startClient(msg);
      } else if (msg.type === 'stop') {
        shutdown(0, 'STOP');
      } else if (msg.type === 'ping') {
        send({ type: 'pong', uid: state.uid || null, at: Date.now() });
      }
    } catch (_) {}
  });

  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
  process.on('SIGINT', () => shutdown(0, 'SIGINT'));

  process.on('uncaughtException', (err) => {
    send({ type: 'worker_log', level: 'error', uid: state.uid, message: `uncaughtException: ${err?.stack || err?.message || err}` });
    shutdown(1, 'UNCAUGHT_EXCEPTION');
  });

  process.on('unhandledRejection', (reason) => {
    send({ type: 'worker_log', level: 'error', uid: state.uid, message: `unhandledRejection: ${reason?.stack || reason?.message || reason}` });
    shutdown(1, 'UNHANDLED_REJECTION');
  });

  // Worker idles until parent sends start.
  send({ type: 'worker_ready', pid: process.pid });
}

// ==================== PARENT MODE ====================

async function runParent() {
  const { fork } = require('child_process');
  const {
    Client,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Events,
    Partials,
    SlashCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    EmbedBuilder,
    ActivityType,
    MessageFlags,
  } = require('discord.js');

  const { Authflow, Titles } = require('prismarine-auth');

  const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
  if (!DISCORD_TOKEN) {
    console.error('DISCORD_TOKEN missing');
    process.exit(1);
  }

  // ==================== PERSISTENT STORE ====================

  class PersistentStore {
    constructor(filePath) {
      this.filePath = filePath;
      this.data = null;
      this.saveTimeout = null;
      this.isSaving = false;
    }

    async load(defaultVal = {}) {
      this.data = defaultVal;
      try {
        const content = await fs.readFile(this.filePath, 'utf8');
        if (content.trim()) {
          const parsed = JSON.parse(content);
          if (typeof parsed === 'object' && parsed !== null) {
            this.data = { ...this.data, ...parsed };
          }
        }
      } catch (e) {
        if (e?.code !== 'ENOENT') {
          console.error(`Failed to load ${this.filePath}:`, e?.message || e);
          await this._backupCorruptFile();
        }
      }
      return this.data;
    }

    async _backupCorruptFile() {
      try {
        const backupPath = `${this.filePath}.backup.${Date.now()}`;
        await fs.rename(this.filePath, backupPath);
      } catch (_) {}
    }

    save(immediate = false) {
      if (immediate) return this._flush();
      if (this.saveTimeout) clearTimeout(this.saveTimeout);
      this.saveTimeout = setTimeout(() => this._flush(), CONFIG.SAVE_DEBOUNCE_MS);
      return Promise.resolve(true);
    }

    async _flush() {
      if (this.isSaving) return;
      this.isSaving = true;
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const jsonString = JSON.stringify(
          this.data,
          (key, value) => (typeof value === 'bigint' ? value.toString() : value),
          2,
        );
        await fs.writeFile(`${this.filePath}.tmp`, jsonString);
        await fs.rename(`${this.filePath}.tmp`, this.filePath);
      } catch (e) {
        console.error('Store flush error:', e?.message || e);
      } finally {
        this.isSaving = false;
      }
    }
  }

  const userStore = new PersistentStore(STORE);
  const sessionStore = new PersistentStore(REJOIN_STORE);

  let users = {};
  let activeSessionsStore = {};
  let storesInitialized = false;

  async function initializeStores() {
    await ensureDir(DATA);
    await ensureDir(AUTH_ROOT);
    users = await userStore.load({});
    activeSessionsStore = await sessionStore.load({});
    storesInitialized = true;
    console.log(`Loaded ${Object.keys(users).length} users and ${Object.keys(activeSessionsStore).length} active sessions`);
  }

  // ==================== RUNTIME STATE ====================

  const sessions = new Map(); // uid -> session object
  const pendingLink = new Map();
  const lastMsa = new Map();
  const lastInteractionAt = new Map();
  const cleanupLocks = new Set();

  let isShuttingDown = false;
  let discordReady = false;

  // ==================== DISCORD CLIENT ====================

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMessages],
    partials: [Partials.Channel, Partials.Message, Partials.User],
    failIfNotExists: false,
    allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
    rest: {
      rejectOnRateLimit: () => false,
      retries: 2,
      timeout: 15000,
    },
    presence: {
      status: 'online',
      activities: [{ name: 'AFK Bot System', type: ActivityType.Watching }],
    },
  });

  // ==================== CRASH LOGGING ====================

  const crashLogger = {
    log: async (type, err) => {
      try {
        const timestamp = new Date().toISOString();
        const errorMsg = `[${timestamp}] ${type}:\n${err?.stack || err?.message || err}\n\n`;
        await fs.appendFile(CRASH_LOG, errorMsg).catch(() => {});
      } catch (_) {}
    },
  };

  process.on('uncaughtException', (err) => {
    crashLogger.log('UNCAUGHT EXCEPTION', err);
  });

  process.on('unhandledRejection', (reason) => {
    crashLogger.log('UNHANDLED REJECTION', reason);
  });

  // ==================== HELPERS ====================

  function getUser(uid) {
    if (!uid || typeof uid !== 'string' || !/^\d+$/.test(uid)) {
      return { connectionType: 'online', bedrockVersion: 'auto', _temp: true };
    }

    if (!users[uid]) {
      users[uid] = {
        connectionType: 'online',
        bedrockVersion: 'auto',
        createdAt: Date.now(),
        lastActive: Date.now(),
      };
      userStore.save();
    }

    users[uid].connectionType = users[uid].connectionType || 'online';
    users[uid].bedrockVersion = users[uid].bedrockVersion || 'auto';
    users[uid].lastActive = Date.now();
    return users[uid];
  }

  async function getUserAuthDir(uid) {
    if (!uid || typeof uid !== 'string') return null;
    const safeUid = uid.replace(/[^a-zA-Z0-9]/g, '');
    if (!safeUid) return null;
    const dir = path.join(AUTH_ROOT, safeUid);
    await ensureDir(dir);
    return dir;
  }

  async function unlinkMicrosoft(uid) {
    if (!uid) return false;
    const dir = await getUserAuthDir(uid);
    if (dir) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (_) {}
    }
    const u = getUser(uid);
    u.linked = false;
    u.authTokenExpiry = null;
    u.tokenAcquiredAt = null;
    await userStore.save(true);
    return true;
  }

  function isValidIP(ip) {
    if (!ip || typeof ip !== 'string') return false;
    if (ip.length > 253) return false;
    if (ip.includes('..') || ip.startsWith('.') || ip.endsWith('.')) return false;
    if (ip.includes('://')) return false;
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    const hostnameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
    return ipv4Regex.test(ip) || ipv6Regex.test(ip) || hostnameRegex.test(ip);
  }

  function isValidPort(port) {
    const num = parseInt(String(port), 10);
    return !Number.isNaN(num) && num > 0 && num <= 65535;
  }

  async function logToDiscord(message) {
    if (!message || isShuttingDown || !discordReady) return;
    try {
      const channel = await client.channels.fetch(CONFIG.LOG_CHANNEL_ID);
      if (!channel) return;
      const embed = new EmbedBuilder().setColor('#5865F2').setDescription(String(message).slice(0, 4096)).setTimestamp();
      await channel.send({ embeds: [embed] }).catch(() => {});
    } catch (_) {}
  }

  function normalizeInteractionPayload(contentOrPayload, ephemeral) {
    const payload = typeof contentOrPayload === 'string' ? { content: contentOrPayload } : { ...(contentOrPayload || {}) };

    // Remove deprecated ephemeral usage if present.
    if ('ephemeral' in payload) delete payload.ephemeral;

    if (ephemeral) {
      payload.flags = (payload.flags ?? 0) | MessageFlags.Ephemeral;
    }

    return payload;
  }

  async function safeReply(interaction, content, ephemeral = true) {
    try {
      if (!interaction) return;
      const payload = normalizeInteractionPayload(content, ephemeral);

      // If we deferred but haven't replied yet, resolve the deferred reply.
      if (interaction.deferred && !interaction.replied) {
        // editReply does not accept flags; ephemeral is determined at defer time.
        const editPayload = { ...payload };
        if ('flags' in editPayload) delete editPayload.flags;
        try {
          await interaction.editReply(editPayload);
        } catch (err) {
          if (err?.code === 10062) return;
          console.error('Failed to editReply:', err);
        }
        return;
      }

      // If already replied, follow up.
      if (interaction.replied) {
        try {
          await interaction.followUp(payload);
        } catch (err) {
          if (err?.code === 10062) return;
          console.error('Failed to send followUp:', err);
        }
        return;
      }

      // Otherwise, first reply.
      try {
        await interaction.reply(payload);
      } catch (err) {
        if (err?.code === 10062) return;
        // If reply failed because already acknowledged, try followUp.
        try {
          await interaction.followUp(payload);
        } catch (err2) {
          if (err2?.code === 10062) return;
          console.error('SafeReply error:', err2);
        }
      }
    } catch (e) {
      if (e?.code === 10062) return;
      console.error('SafeReply error:', e);
    }
  }

  // ==================== SESSION STORE ====================

  async function saveSessionData(uid) {
    if (!uid) return;
    const u = getUser(uid);
    if (!u) return;
    activeSessionsStore[uid] = {
      startedAt: Date.now(),
      server: u.server,
      connectionType: u.connectionType,
      bedrockVersion: u.bedrockVersion,
      offlineUsername: u.offlineUsername,
      linked: u.linked,
      authTokenExpiry: u.authTokenExpiry,
      tokenAcquiredAt: u.tokenAcquiredAt,
      lastActive: Date.now(),
    };
    await sessionStore.save();
  }

  async function saveAllSessionData() {
    for (const [uid] of sessions) {
      await saveSessionData(uid);
    }
  }

  async function clearSessionData(uid) {
    if (activeSessionsStore[uid]) {
      delete activeSessionsStore[uid];
      await sessionStore.save();
    }
  }

  // ==================== WORKER PROCESS MANAGEMENT ====================

  function buildWorkerOpts(uid, authDir) {
    const u = getUser(uid);
    const { ip, port } = u.server;

    const opts = {
      host: ip,
      port: parseInt(port, 10),
      connectTimeout: CONFIG.CONNECTION_TIMEOUT_MS,
      keepAlive: true,
      viewDistance: 1,
      profilesFolder: authDir,
      username: uid,
      offline: false,
      skipPing: true,
      autoInitPlayer: true,
      // IMPORTANT: bedrock-protocol's built-in timeout logic has been observed
      // to trigger native aborts in some environments. We disable it and rely
      // on the worker-level connect guard instead.
      useTimeout: false,
    };

    if (u.connectionType === 'offline') {
      opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
      opts.offline = true;
    }

    return opts;
  }

  function spawnWorkerForSession(uid, runId, opts) {
    // Spawn this same file as a worker.
    const child = fork(__filename, [], {
      env: { ...process.env, AFKBOT_WORKER: '1' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    child.on('message', (msg) => {
      try {
        if (!msg || typeof msg !== 'object') return;
        const s = sessions.get(uid);
        if (!s) return;

        if (msg.type === 'worker_ready') {
          // no-op
        } else if (msg.type === 'worker_log') {
          if (msg.level === 'error') console.error(`[WORKER ${uid}]`, msg.message);
          else console.log(`[WORKER ${uid}]`, msg.message);
        } else if (msg.type === 'mc_spawn') {
          logToDiscord(`Bot of <@${uid}> spawned.`);
        } else if (msg.type === 'mc_connected') {
          s.connected = true;
          s.isReconnecting = false;
          s.reconnectAttempt = 0;
          logToDiscord(`Bot of <@${uid}> connected to **${s.serverLabel}**`);
        } else if (msg.type === 'mc_disconnect') {
          logToDiscord(`Bot of <@${uid}> was kicked: ${msg.reason || 'Unknown reason'}`);
        } else if (msg.type === 'mc_error') {
          console.error(`Session error for ${uid}:`, msg.message || 'Unknown error');
          logToDiscord(`Bot of <@${uid}> error: \`${String(msg.message || 'Unknown error').slice(0, 200)}\``);
        } else if (msg.type === 'mc_stale') {
          console.warn(`Stale connection detected for ${uid}`);
        } else if (msg.type === 'mc_close') {
          // will be handled by exit handler too
        }
      } catch (_) {}
    });

    child.once('exit', (code, signal) => {
      const s = sessions.get(uid);
      if (!s) return;

      s.child = null;
      s.connected = false;

      // If we're shutting down or session was manually stopped/cleaned, do nothing.
      if (isShuttingDown || s.manualStop || s.isCleaningUp) {
        return;
      }

      // Worker died unexpectedly (including native crash). Reconnect logic handles it.
      const nextAttempt = Math.max(1, (s.reconnectAttempt || 0) + 1);
      console.warn(`Worker for ${uid} exited (${signal || code}). Scheduling reconnect attempt ${nextAttempt}...`);
      handleAutoReconnect(uid, nextAttempt);
    });

    // Kick off worker start.
    child.send({ type: 'start', uid, runId, opts });
    return child;
  }

  async function stopWorker(uid, s) {
    if (!s?.child) return;
    const child = s.child;

    await new Promise((resolve) => {
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };

      const gracefulTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch (_) {}
      }, CONFIG.WORKER_STOP_GRACE_MS);

      const forceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (_) {}
        finish();
      }, CONFIG.WORKER_FORCE_KILL_MS);

      try {
        child.once('exit', () => {
          clearTimeout(gracefulTimer);
          clearTimeout(forceTimer);
          finish();
        });

        // Ask worker to stop cleanly.
        try {
          child.send({ type: 'stop' });
        } catch (_) {
          // If IPC is broken, try SIGTERM immediately.
          try {
            child.kill('SIGTERM');
          } catch (_) {}
        }
      } catch (_) {
        clearTimeout(gracefulTimer);
        clearTimeout(forceTimer);
        finish();
      }
    });

    s.child = null;
  }

  // ==================== SESSION MANAGEMENT ====================

  async function cleanupSession(uid) {
    if (!uid) return;
    if (cleanupLocks.has(uid)) {
      return;
    }

    cleanupLocks.add(uid);
    try {
      const s = sessions.get(uid);
      if (!s) return;

      s.isCleaningUp = true;
      s.manualStop = true;

      if (s.reconnectTimer) {
        clearTimeout(s.reconnectTimer);
        s.reconnectTimer = null;
      }

      // Stop worker process (no bedrock-protocol close in parent).
      await stopWorker(uid, s);

      sessions.delete(uid);
    } finally {
      cleanupLocks.delete(uid);
    }
  }

  async function cleanupAllSessions() {
    const promises = [];
    for (const [uid] of sessions) {
      promises.push(cleanupSession(uid));
    }
    await Promise.all(promises);
  }

  async function stopSession(uid) {
    if (!uid) return false;
    const s = sessions.get(uid);
    if (s) {
      s.manualStop = true;
      if (s.reconnectTimer) {
        clearTimeout(s.reconnectTimer);
        s.reconnectTimer = null;
      }
    }
    await clearSessionData(uid);
    await cleanupSession(uid);
    return true;
  }

  // ==================== RECONNECTION SYSTEM ====================

  async function handleAutoReconnect(uid, attempt = 1) {
    if (!uid || isShuttingDown) return;
    const s = sessions.get(uid);
    if (!s || s.manualStop || s.isCleaningUp) return;

    attempt = Math.max(1, attempt);
    if (attempt > CONFIG.MAX_RECONNECT_ATTEMPTS) {
      logToDiscord(`Bot of <@${uid}> stopped after max failed attempts.`);
      await cleanupSession(uid);
      await clearSessionData(uid);
      return;
    }

    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);

    s.isReconnecting = true;
    s.reconnectAttempt = attempt;

    const baseDelay = Math.min(CONFIG.RECONNECT_BASE_DELAY_MS * Math.pow(1.5, attempt - 1), CONFIG.RECONNECT_MAX_DELAY_MS);
    const jitter = Math.random() * 5000;
    const delay = baseDelay + jitter;

    logToDiscord(`Bot of <@${uid}> disconnected. Reconnecting in ${Math.round(delay / 1000)}s (Attempt ${attempt})...`);

    s.reconnectTimer = setTimeout(async () => {
      if (!isShuttingDown && !s.manualStop) {
        // Kill any previous worker first (if still around)
        await stopWorker(uid, s);
        if (!isShuttingDown) {
          await startSession(uid, null, true, attempt);
        }
      } else {
        await cleanupSession(uid);
      }
    }, delay);

    s.reconnectTimer.unref?.();
  }

  // ==================== UI COMPONENTS ====================

  function panelRow(isJava = false) {
    const title = isJava ? 'Java AFKBot Panel' : 'Bedrock AFKBot Panel';
    const startCustomId = isJava ? 'start_java' : 'start_bedrock';
    return {
      content: `**${title}**`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('link').setLabel('Link Microsoft').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('unlink').setLabel('Unlink Microsoft').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(startCustomId).setLabel('Start').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('settings').setLabel('Settings').setStyle(ButtonStyle.Secondary),
        ),
      ],
    };
  }

  // ==================== MICROSOFT AUTHENTICATION ====================

  async function linkMicrosoft(uid, interaction) {
    if (!uid || !interaction) return;

    // Always defer quickly to avoid "Unknown interaction".
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
    } catch (_) {}

    if (pendingLink.has(uid)) {
      return safeReply(interaction, 'Login already in progress. Check your DMs or use the last code.', true);
    }

    const authDir = await getUserAuthDir(uid);
    if (!authDir) {
      return safeReply(interaction, 'System error: Cannot create auth directory.', true);
    }

    const u = getUser(uid);

    const timeoutId = setTimeout(() => {
      pendingLink.delete(uid);
      safeReply(interaction, 'Login timed out after 5 minutes.', true);
    }, 300000);

    try {
      const flow = new Authflow(
        uid,
        authDir,
        {
          flow: 'live',
          authTitle: Titles?.MinecraftNintendoSwitch || 'Bedrock AFK Bot',
          deviceType: 'Nintendo',
        },
        async (data) => {
          const uri = data?.verification_uri_complete || data?.verification_uri || 'https://www.microsoft.com/link';
          const code = data?.user_code || '(no code)';
          lastMsa.set(uid, { uri, code, at: Date.now() });

          const msg =
            `**Microsoft Authentication Required**\n\n` +
            `1. Visit: ${uri}\n` +
            `2. Enter Code: \`${code}\`\n\n` +
            `**Security Notice:** Your account tokens are saved locally and are never shared.`;

          const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Open link').setStyle(ButtonStyle.Link).setURL(uri));
          await safeReply(interaction, { content: msg, components: [row] }, true);
        },
      );

      pendingLink.set(uid, true);

      flow
        .getMsaToken()
        .then(async () => {
          clearTimeout(timeoutId);
          u.linked = true;
          u.tokenAcquiredAt = Date.now();
          await userStore.save(true);
          await safeReply(interaction, 'Microsoft account linked!', true);
          pendingLink.delete(uid);
        })
        .catch(async (e) => {
          clearTimeout(timeoutId);
          await safeReply(interaction, `Login failed: ${e?.message || 'Unknown error'}`, true);
          pendingLink.delete(uid);
        });
    } catch (e) {
      clearTimeout(timeoutId);
      pendingLink.delete(uid);
      await safeReply(interaction, 'Authentication system error.', true);
    }
  }

  // ==================== MAIN SESSION FUNCTION ====================

  async function startSession(uid, interaction, isReconnect = false, reconnectAttempt = 1) {
    if (!uid || isShuttingDown) return;

    if (!storesInitialized) {
      if (interaction) safeReply(interaction, 'System initializing, please try again.', true);
      return;
    }

    // Defer early for interactive calls to avoid Unknown interaction.
    if (interaction && !interaction.deferred && !interaction.replied) {
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      } catch (_) {}
    }

    // Wait for ongoing cleanup.
    if (cleanupLocks.has(uid)) {
      let attempts = 0;
      while (cleanupLocks.has(uid) && attempts < 10) {
        await new Promise((r) => setTimeout(r, 500));
        attempts++;
      }
    }

    const u = getUser(uid);
    if (!u) {
      if (interaction) safeReply(interaction, 'User data error.', true);
      return;
    }

    if (!u.linked) {
      if (interaction) safeReply(interaction, 'Please auth with Xbox to use the bot', true);
      else await clearSessionData(uid);
      return;
    }

    if (!u.server?.ip) {
      if (interaction) safeReply(interaction, 'Please configure your server settings first.', true);
      await clearSessionData(uid);
      return;
    }

    const { ip, port } = u.server;
    if (!isValidIP(ip) || !isValidPort(port)) {
      if (interaction) safeReply(interaction, 'Invalid server IP or port format.', true);
      await clearSessionData(uid);
      return;
    }

    // Session conflicts
    if (sessions.has(uid) && !isReconnect) {
      if (interaction) safeReply(interaction, '**Session Conflict**: Active session exists. Use stop first.', true);
      return;
    }

    if (isReconnect && sessions.has(uid)) {
      // Stop old session worker without touching native code here.
      await cleanupSession(uid);
    }

    await saveSessionData(uid);

    const authDir = await getUserAuthDir(uid);
    if (!authDir) {
      if (interaction) safeReply(interaction, 'Auth directory error.', true);
      return;
    }

    const runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;

    const session = {
      uid,
      runId,
      child: null,
      startedAt: Date.now(),
      manualStop: false,
      connected: false,
      isReconnecting: !!isReconnect,
      isCleaningUp: false,
      reconnectAttempt: reconnectAttempt,
      reconnectTimer: null,
      serverLabel: `${ip}:${port}`,
    };

    sessions.set(uid, session);

    // Spawn worker (bedrock-protocol lives there)
    const opts = buildWorkerOpts(uid, authDir);
    session.child = spawnWorkerForSession(uid, runId, opts);

    if (interaction) {
      await safeReply(interaction, `**Connecting...** (\`${ip}:${port}\`)`, true);
    }
  }

  // ==================== SESSION RESTORATION ====================

  async function restoreSessions() {
    const previousSessions = Object.keys(activeSessionsStore || {});
    console.log(`Found ${previousSessions.length} sessions to restore`);

    let delay = 0;
    for (const uid of previousSessions) {
      if (typeof uid !== 'string' || !/^\d+$/.test(uid)) continue;

      const sessionData = activeSessionsStore[uid];
      if (!sessionData) continue;

      const hasServer = !!(sessionData.server && sessionData.server.ip && sessionData.server.port);
      const isLinked = sessionData.linked === true;

      if (!hasServer || !isLinked) {
        console.log(`Skipping restore for user ${uid}: missing server settings or not linked.`);
        await clearSessionData(uid);
        continue;
      }

      if (!users[uid]) users[uid] = {};
      if (sessionData.server) users[uid].server = sessionData.server;
      if (sessionData.connectionType) users[uid].connectionType = sessionData.connectionType;
      if (sessionData.bedrockVersion) users[uid].bedrockVersion = sessionData.bedrockVersion;
      if (sessionData.offlineUsername) users[uid].offlineUsername = sessionData.offlineUsername;
      if (sessionData.linked !== undefined) users[uid].linked = sessionData.linked;
      if (sessionData.authTokenExpiry) users[uid].authTokenExpiry = sessionData.authTokenExpiry;
      if (sessionData.tokenAcquiredAt) users[uid].tokenAcquiredAt = sessionData.tokenAcquiredAt;

      await userStore.save(true);

      setTimeout(() => {
        if (!isShuttingDown) {
          console.log(`Restoring session for user ${uid}`);
          startSession(uid, null, true);
        }
      }, delay);

      delay += CONFIG.SESSION_RESTORE_DELAY_MS;
    }
  }

  // ==================== GRACEFUL SHUTDOWN ====================

  async function gracefulShutdown(signal) {
    console.log(`Shutting down due to ${signal}...`);
    isShuttingDown = true;

    const forceExit = setTimeout(() => process.exit(1), 15000);

    try {
      await saveAllSessionData();
      await Promise.all([userStore.save(true), sessionStore.save(true)]);
      await cleanupAllSessions();
      await client.destroy();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (e) {
      console.error('Shutdown error:', e);
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // ==================== DISCORD EVENTS ====================

  client.on('error', (error) => {
    console.error('DISCORD ERROR:', error?.message || error);
    discordReady = false;
  });

  client.on(Events.ShardDisconnect, () => {
    discordReady = false;
  });

  client.on(Events.ShardResume, (_shardId, replayed) => {
    discordReady = true;
    console.log(`Discord shard resumed. Replayed: ${replayed}`);
  });

  client.once(Events.ClientReady, async () => {
    discordReady = true;
    console.log('Discord client ready');

    try {
      const cmds = [
        new SlashCommandBuilder().setName('panel').setDescription('Open Bedrock AFK panel'),
        new SlashCommandBuilder().setName('java').setDescription('Open Java AFKBot Panel'),
      ];
      await client.application?.commands?.set(cmds);
    } catch (e) {
      console.error('Failed to register commands:', e?.message || e);
    }

    // Memory watcher
    setInterval(() => {
      const mem = process.memoryUsage();
      const mb = mem.rss / 1024 / 1024;
      if (mb > CONFIG.MAX_MEMORY_MB) {
        console.warn(`High memory usage: ${mb.toFixed(2)}MB`);
        if (global.gc) global.gc();
      }
    }, CONFIG.MEMORY_CHECK_INTERVAL_MS).unref?.();

    // Restore sessions a bit after boot.
    setTimeout(() => {
      restoreSessions();
    }, 10000).unref?.();
  });

  client.on(Events.InteractionCreate, async (i) => {
    try {
      if (!i || isShuttingDown) return;
      if (!i.user?.id) return;
      const uid = i.user.id;

      const lastInteraction = lastInteractionAt.get(uid) || 0;
      if (Date.now() - lastInteraction < 1000) {
        return safeReply(i, 'Please wait a moment before clicking again.', true);
      }
      lastInteractionAt.set(uid, Date.now());

      if (i.isChatInputCommand()) {
        if (i.commandName === 'panel') return i.reply(panelRow(false)).catch(() => {});
        if (i.commandName === 'java') return i.reply(panelRow(true)).catch(() => {});
      }

      if (i.isButton()) {
        if (i.customId === 'start_bedrock' || i.customId === 'start_java') {
          if (sessions.has(uid)) return safeReply(i, '**Session Conflict**: Active session exists.', true);

          // Defer quickly.
          try {
            await i.deferReply({ flags: MessageFlags.Ephemeral });
          } catch (_) {}

          const embed =
            i.customId === 'start_java'
              ? new EmbedBuilder()
                  .setTitle('Java Compatibility Check')
                  .setDescription('For a successful connection to a Java server, ensure the following plugins are installed.')
                  .addFields({ name: 'Required Plugins', value: 'GeyserMC\nFloodgate' })
                  .setColor('#E67E22')
              : new EmbedBuilder().setTitle('Bedrock Connection').setDescription('Start bot?').setColor('#2ECC71');

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('confirm_start').setLabel('Start').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          );

          return i.followUp({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        if (i.customId === 'confirm_start') {
          try {
            await i.deferReply({ flags: MessageFlags.Ephemeral });
          } catch (_) {}
          safeReply(i, '**Connecting...**', true);
          startSession(uid, i, false);
          return;
        }

        if (i.customId === 'cancel') return safeReply(i, 'Cancelled.', true);

        if (i.customId === 'stop') {
          try {
            await i.deferReply({ flags: MessageFlags.Ephemeral });
          } catch (_) {}
          const ok = await stopSession(uid);
          return safeReply(i, ok ? '**Session Terminated.**' : 'No active sessions.', true);
        }

        if (i.customId === 'link') return linkMicrosoft(uid, i);

        if (i.customId === 'unlink') {
          try {
            await i.deferReply({ flags: MessageFlags.Ephemeral });
          } catch (_) {}
          await unlinkMicrosoft(uid);
          return safeReply(i, 'Unlinked Microsoft account.', true);
        }

        if (i.customId === 'settings') {
          const u = getUser(uid);
          const modal = new ModalBuilder().setCustomId('settings_modal').setTitle('Configuration');

          const ipInput = new TextInputBuilder()
            .setCustomId('ip')
            .setLabel('Server IP')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(u.server?.ip || '')
            .setMaxLength(253);

          const portInput = new TextInputBuilder()
            .setCustomId('port')
            .setLabel('Port')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(String(u.server?.port || 19132))
            .setMaxLength(5);

          modal.addComponents(new ActionRowBuilder().addComponents(ipInput), new ActionRowBuilder().addComponents(portInput));

          return i.showModal(modal).catch(() => {});
        }
      }

      if (i.isModalSubmit() && i.customId === 'settings_modal') {
        const ip = i.fields?.getTextInputValue('ip')?.trim();
        const portStr = i.fields?.getTextInputValue('port')?.trim();
        const port = parseInt(portStr, 10);

        if (!ip || !portStr) return safeReply(i, 'IP and Port are required.', true);
        if (!isValidIP(ip)) return safeReply(i, 'Invalid IP address format.', true);
        if (!isValidPort(port)) return safeReply(i, 'Invalid port (must be 1-65535).', true);

        const u = getUser(uid);
        u.server = { ip, port };
        await userStore.save(true);
        return safeReply(i, `Saved: **${ip}:${port}**`, true);
      }
    } catch (e) {
      console.error('Interaction error:', e?.stack || e?.message || e);
    }
  });

  // ==================== STARTUP ====================

  await initializeStores();

  client.login(DISCORD_TOKEN).catch((err) => {
    console.error('Initial login failed:', err?.message || err);
    process.exit(1);
  });

  setInterval(() => {
    console.log(`Heartbeat | Sessions: ${sessions.size} | Discord: ${discordReady ? 'Connected' : 'Disconnected'} | Uptime: ${Math.floor(process.uptime() / 60)}m`);
  }, 60000).unref?.();
}

// ==================== ENTRYPOINT ====================

(async () => {
  if (IS_WORKER) {
    await runWorker();
  } else {
    await runParent();
  }
})();
