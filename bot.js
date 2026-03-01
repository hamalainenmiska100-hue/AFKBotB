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

  // Reconnect:
  // - Set MAX_RECONNECT_ATTEMPTS <= 0 for unlimited reconnect attempts (recommended for production).
  MAX_RECONNECT_ATTEMPTS: 0,
  RECONNECT_BASE_DELAY_MS: 10_000,
  RECONNECT_MAX_DELAY_MS: 300_000,
  // Cap exponential growth to avoid huge Math.pow() exponents; delay is still capped by RECONNECT_MAX_DELAY_MS.
  RECONNECT_EXPONENT_CAP: 20,

  CONNECTION_TIMEOUT_MS: 30_000,
  KEEPALIVE_INTERVAL_MS: 15_000,

  // "Stale" means we didn't see any packets/keepalives for STALE_CONNECTION_TIMEOUT_MS.
  // Increase this for production to avoid false-positives during lag/maintenance.
  STALE_CONNECTION_TIMEOUT_MS: 300_000,
  // How often to check for staleness (separate from the threshold above).
  STALE_CHECK_INTERVAL_MS: 30_000,

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
  // Periodically ensure sessions listed in rejoin.json are actually running.
  SESSION_WATCHDOG_INTERVAL_MS: 10 * 60_000,
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

    // stale connection detection (check interval decoupled from threshold)
    const stale = addInterval(() => {
      if (state.stopping || !state.client || state.runId !== runId) return;
      if (!state.connected) return;
      const lastActivity = Math.max(state.lastPacketTime || 0, state.lastKeepalive || 0);
      if (Date.now() - lastActivity > CONFIG.STALE_CONNECTION_TIMEOUT_MS) {
        send({ type: 'mc_stale', uid: state.uid });
        shutdown(0, 'STALE');
      }
    }, CONFIG.STALE_CHECK_INTERVAL_MS);
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
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
  } = require('discord.js');

  const { Authflow, Titles } = require('prismarine-auth');

  const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
  if (!DISCORD_TOKEN) {
    console.error('DISCORD_TOKEN missing');
    process.exit(1);
  }

  // ==================== LIMITS & MESSAGES ====================

  const GLOBAL_MAX_BOTS = 20;

  const ERR_NO_ACCESS = 'You do not have access to use this bot. Contact owner for more information.';
  const ERR_MAX_BOT_LIMIT = 'You passed your maximum bot limit. Contact owner for more information.';
  const ERR_MAX_ACCOUNT_LIMIT = 'You passed your maximum account limit. Contact owner for more information.';

  // Public announcement system (admin-only)
  const ANNOUNCEMENT_DM_DELAY_MS = 1100; // keep a steady pace to reduce rate-limit pressure
  let announcementQueue = Promise.resolve();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const EASTER_EGGS = [
    'You have discovered the bot’s secret stash of virtual cookies. 🍪',
    'Pro tip: If you can’t find the bug… it might be hiding behind a semicolon.',
    'This bot runs on caffeine, duct tape, and reconnect attempts.',
    'Achievement unlocked: **Curiosity**.',
    'RakNet crashes can’t hurt the parent process. Nice try. 😄',
    'Beep boop. Definitely not a robot. 🤖',
    'The AFK gods are pleased with your idleness.',
  ];

  const EASTER_EGGS_RARE = [
    'The cake is a lie. 🎂',
    'You rolled a natural 20. 🎲',
    'Congratulations. You are now the proud owner of a useless secret. 🗝️',
  ];

  function getRandomEasterEgg() {
    const rareChance = 0.03;
    if (Math.random() < rareChance) {
      return EASTER_EGGS_RARE[Math.floor(Math.random() * EASTER_EGGS_RARE.length)];
    }
    return EASTER_EGGS[Math.floor(Math.random() * EASTER_EGGS.length)];
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
    migrateAndNormalizeAllData();
    storesInitialized = true;
    console.log(`Loaded ${Object.keys(users).length} users and ${Object.keys(activeSessionsStore).length} active sessions`);
  }

  // ==================== DATA NORMALIZATION & ACCESS ====================

  function isAdmin(uid) {
    return String(uid) === String(CONFIG.ADMIN_ID);
  }

  function nowMs() {
    return Date.now();
  }

  function isInfinity(val) {
    return String(val).toLowerCase() === 'infinity';
  }

  function parseLimitValue(input) {
    if (input === null || input === undefined) return null;
    const s = String(input).trim().toLowerCase();
    if (!s) return null;
    if (s === 'infinity' || s === 'inf' || s === 'unlimited' || s === '∞') return 'infinity';
    const n = parseInt(s, 10);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }

  function parseDurationMs(input) {
    if (input === null || input === undefined) return null;
    const s0 = String(input).trim().toLowerCase();
    if (!s0) return null;
    if (s0 === 'infinity' || s0 === 'inf' || s0 === 'unlimited' || s0 === '∞') return 'infinity';

    const m = s0.match(/^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d|w)?$/);
    if (!m) return null;

    const value = Number(m[1]);
    if (!Number.isFinite(value) || value < 0) return null;

    const unit = m[2] || 'd';
    const mult =
      unit === 'ms'
        ? 1
        : unit === 's'
          ? 1000
          : unit === 'm'
            ? 60_000
            : unit === 'h'
              ? 3_600_000
              : unit === 'd'
                ? 86_400_000
                : unit === 'w'
                  ? 604_800_000
                  : 86_400_000;

    const ms = Math.round(value * mult);
    if (!Number.isFinite(ms) || ms < 0) return null;
    return ms;
  }

  function ensureUserObject(uid) {
    if (!uid || typeof uid !== 'string' || !/^[0-9]+$/.test(uid)) {
      return { connectionType: 'online', bedrockVersion: 'auto', _temp: true };
    }

    if (!users[uid]) {
      users[uid] = {
        connectionType: 'online',
        bedrockVersion: 'auto',
        createdAt: nowMs(),
        lastActive: nowMs(),
        access: { enabled: false },
        microsoftAccounts: [],
        servers: [],
      };
      userStore.save();
    }

    const u = users[uid];

    u.connectionType = u.connectionType || 'online';
    u.bedrockVersion = u.bedrockVersion || 'auto';
    u.lastActive = nowMs();

    // Ensure access object
    if (!u.access || typeof u.access !== 'object') u.access = { enabled: false };
    if (typeof u.access.enabled !== 'boolean') u.access.enabled = u.access.enabled === true;

    // Ensure arrays
    if (!Array.isArray(u.microsoftAccounts)) u.microsoftAccounts = [];
    if (!Array.isArray(u.servers)) u.servers = [];

    // Legacy migration: single server -> servers array
    if (u.server && u.server.ip && u.server.port && u.servers.length === 0) {
      u.servers.push({
        id: 'legacy',
        ip: u.server.ip,
        port: u.server.port,
        createdAt: nowMs(),
        lastUsedAt: null,
      });
    }

    // Legacy migration: linked flag -> microsoftAccounts
    if (u.linked === true && u.microsoftAccounts.length === 0) {
      u.microsoftAccounts.push({
        id: 'legacy',
        createdAt: u.tokenAcquiredAt || nowMs(),
        tokenAcquiredAt: u.tokenAcquiredAt || nowMs(),
        lastUsedAt: null,
        legacy: true,
      });
    }

    // Keep legacy alias fields reasonably in sync
    u.linked = u.microsoftAccounts.length > 0;

    return u;
  }

  function hasAccess(uid) {
    if (isAdmin(uid)) return true;
    const u = ensureUserObject(uid);
    const a = u.access;
    if (!a?.enabled) return false;

    // Expiry enforcement based on expiresAt (preferred) or grantedAt + durationMs
    if (a.durationMs && !isInfinity(a.durationMs)) {
      const expiresAt =
        typeof a.expiresAt === 'number'
          ? a.expiresAt
          : typeof a.grantedAt === 'number'
            ? a.grantedAt + Number(a.durationMs)
            : null;
      if (expiresAt && nowMs() >= expiresAt) return false;
    }

    return true;
  }

  function getMaxBots(uid) {
    if (isAdmin(uid)) return 'infinity';
    const u = ensureUserObject(uid);
    const v = u.access?.maxBots;
    if (v === undefined || v === null) return 0;
    if (isInfinity(v)) return 'infinity';
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function getMaxAccounts(uid) {
    if (isAdmin(uid)) return 'infinity';
    const u = ensureUserObject(uid);
    const v = u.access?.maxAccounts;
    if (v === undefined || v === null) return 0;
    if (isInfinity(v)) return 'infinity';
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function getAccessExpiry(uid) {
    const u = ensureUserObject(uid);
    const a = u.access;
    if (!a?.enabled) return null;
    if (!a.durationMs || isInfinity(a.durationMs)) return null;
    const expiresAt =
      typeof a.expiresAt === 'number'
        ? a.expiresAt
        : typeof a.grantedAt === 'number'
          ? a.grantedAt + Number(a.durationMs)
          : null;
    return typeof expiresAt === 'number' ? expiresAt : null;
  }

  function migrateAndNormalizeAllData() {
    try {
      // Normalize users
      for (const uid of Object.keys(users || {})) {
        if (typeof uid !== 'string' || !/^[0-9]+$/.test(uid)) continue;
        ensureUserObject(uid);
      }

      // Migrate active session store format (legacy: keyed by uid)
      const keys = Object.keys(activeSessionsStore || {});
      const looksLegacy = keys.some((k) => /^[0-9]+$/.test(k));
      if (looksLegacy) {
        const migrated = {};
        for (const uid of keys) {
          const s = activeSessionsStore[uid];
          if (!s || typeof s !== 'object') continue;
          if (!/^[0-9]+$/.test(uid)) continue;
          const sessionId = `legacy_${uid}`;
          migrated[sessionId] = {
            ownerUid: uid,
            accountId: 'legacy',
            startedAt: s.startedAt || nowMs(),
            server: s.server || null,
            connectionType: s.connectionType,
            bedrockVersion: s.bedrockVersion,
            offlineUsername: s.offlineUsername,
            lastActive: s.lastActive || nowMs(),
          };
        }
        activeSessionsStore = migrated;
        sessionStore.data = activeSessionsStore;
        sessionStore.save(true);
      } else {
        // If already in new format, ensure minimal shape
        for (const sid of keys) {
          const s = activeSessionsStore[sid];
          if (!s || typeof s !== 'object') continue;
          if (!s.ownerUid || !/^[0-9]+$/.test(String(s.ownerUid))) continue;
          if (!s.accountId) s.accountId = 'legacy';
        }
      }

      // Persist normalization best-effort
      userStore.data = users;
      userStore.save();
      sessionStore.data = activeSessionsStore;
      sessionStore.save();
    } catch (e) {
      console.error('Migration error:', e?.message || e);
    }
  }

  // Access time tracker: save elapsed time every 30 minutes, enforce expiry every minute.
  async function tickAccessAndEnforce(saveElapsed = false) {
    try {
      if (!storesInitialized) return;

      const now = nowMs();
      const expiredUsers = [];

      for (const uid of Object.keys(users || {})) {
        if (typeof uid !== 'string' || !/^[0-9]+$/.test(uid)) continue;
        const u = ensureUserObject(uid);
        const a = u.access;
        if (!a?.enabled) continue;

        // Init access timestamps
        if (typeof a.grantedAt !== 'number') a.grantedAt = now;
        if (typeof a.elapsedMs !== 'number') a.elapsedMs = 0;
        if (typeof a.lastTickAt !== 'number') a.lastTickAt = now;

        if (saveElapsed) {
          const delta = Math.max(0, now - (a.lastTickAt || now));
          a.elapsedMs = (a.elapsedMs || 0) + delta;
          a.lastTickAt = now;

          if (a.durationMs && !isInfinity(a.durationMs) && typeof a.grantedAt === 'number') {
            a.expiresAt = a.grantedAt + Number(a.durationMs);
          } else {
            a.expiresAt = null;
          }
        }

        const expiresAt = getAccessExpiry(uid);
        if (expiresAt && now >= expiresAt) {
          expiredUsers.push(uid);
        }
      }

      if (expiredUsers.length > 0) {
        for (const uid of expiredUsers) {
          const u = ensureUserObject(uid);
          if (u.access) {
            u.access.enabled = false;
            u.access.revokedAt = now;
          }
        }
        await userStore.save(true);

        // Stop all sessions for expired users
        for (const uid of expiredUsers) {
          await stopAllSessionsForUser(uid);
        }
      }

      if (saveElapsed) {
        await userStore.save(true);
      }
    } catch (e) {
      console.error('Access tick error:', e?.message || e);
    }
  }

  // ==================== RUNTIME STATE ====================

  const sessions = new Map(); // sessionId -> session object
  const sessionsByOwner = new Map(); // ownerUid -> Set(sessionId)
  const pendingLink = new Map();
  const lastMsa = new Map();
  const lastInteractionAt = new Map();
  const cleanupLocks = new Set();

  let isShuttingDown = false;
  let discordReady = false;

  function addSessionIndex(ownerUid, sessionId) {
    if (!ownerUid || !sessionId) return;
    let set = sessionsByOwner.get(ownerUid);
    if (!set) {
      set = new Set();
      sessionsByOwner.set(ownerUid, set);
    }
    set.add(sessionId);
  }

  function removeSessionIndex(ownerUid, sessionId) {
    const set = sessionsByOwner.get(ownerUid);
    if (!set) return;
    set.delete(sessionId);
    if (set.size === 0) sessionsByOwner.delete(ownerUid);
  }

  function getOwnerSessionIds(ownerUid) {
    const set = sessionsByOwner.get(ownerUid);
    return set ? Array.from(set) : [];
  }

  function getOwnerSessionCount(ownerUid) {
    return getOwnerSessionIds(ownerUid).length;
  }

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
      activities: [{ name: '🔥 24/7 AFKBot [Bedrock and Java] 🚀💻 Developer: ilovecatssm2 ', type: ActivityType.Watching }],
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
    return ensureUserObject(uid);
  }

  function makeId(prefix = '') {
    const rnd = Math.random().toString(16).slice(2, 10);
    return `${prefix}${Date.now().toString(16)}${rnd}`;
  }

  function listAccounts(uid) {
    const u = getUser(uid);
    const accounts = Array.isArray(u.microsoftAccounts) ? u.microsoftAccounts : [];
    return accounts.filter((a) => a && typeof a.id === 'string');
  }

  function listServers(uid) {
    const u = getUser(uid);
    const servers = Array.isArray(u.servers) ? u.servers : [];
    return servers.filter((s) => s && s.ip && s.port);
  }

  function formatAccountLabel(account, idx) {
    // Keep it simple; no extra API calls.
    if (!account) return `Account ${idx + 1}`;
    if (account.legacy) return 'Account 1';
    return `Account ${idx + 1}`;
  }

  function formatServerLabel(server) {
    if (!server) return 'Unknown server';
    return `${server.ip}:${server.port}`;
  }

  async function getUserAuthDir(uid, accountId = 'legacy') {
    if (!uid || typeof uid !== 'string') return null;
    const safeUid = uid.replace(/[^a-zA-Z0-9]/g, '');
    if (!safeUid) return null;

    // Legacy account stays in /auth/<uid> to keep existing tokens compatible.
    if (!accountId || accountId === 'legacy') {
      const dir = path.join(AUTH_ROOT, safeUid);
      await ensureDir(dir);
      return dir;
    }

    // New accounts: /auth/<uid>__<accountId> (keeps accounts separated without nesting)
    const safeAcc = String(accountId).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeAcc) {
      const dir = path.join(AUTH_ROOT, safeUid);
      await ensureDir(dir);
      return dir;
    }

    const dir = path.join(AUTH_ROOT, `${safeUid}__${safeAcc}`);
    await ensureDir(dir);
    return dir;
  }

  async function unlinkMicrosoftAccount(uid, accountId) {
    if (!uid || !accountId) return false;
    const u = getUser(uid);

    const accIndex = (u.microsoftAccounts || []).findIndex((a) => a && a.id === accountId);
    if (accIndex === -1) return false;

    const dir = await getUserAuthDir(uid, accountId);

    if (dir) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (_) {}
    }

    // Remove account from list
    u.microsoftAccounts.splice(accIndex, 1);

    // Legacy compat
    u.linked = u.microsoftAccounts.length > 0;
    if (!u.linked) {
      u.authTokenExpiry = null;
      u.tokenAcquiredAt = null;
    }

    await userStore.save(true);

    // Stop any active bots using this account
    try {
      const ids = getOwnerSessionIds(uid);
      for (const sid of ids) {
        const s = sessions.get(sid);
        if (s && s.accountId === accountId) {
          await stopSession(sid);
        }
      }
    } catch (_) {}

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

  function isUnlimitedReconnects() {
    return !Number.isFinite(CONFIG.MAX_RECONNECT_ATTEMPTS) || CONFIG.MAX_RECONNECT_ATTEMPTS <= 0;
  }

  function computeReconnectDelayMs(attempt) {
    const expCap = Number.isFinite(CONFIG.RECONNECT_EXPONENT_CAP) ? CONFIG.RECONNECT_EXPONENT_CAP : 20;
    const exp = Math.min(Math.max(0, attempt - 1), expCap);
    const baseDelay = CONFIG.RECONNECT_BASE_DELAY_MS * Math.pow(1.5, exp);
    const capped = Math.min(baseDelay, CONFIG.RECONNECT_MAX_DELAY_MS);
    const jitter = Math.random() * 5000;
    return capped + jitter;
  }

  // ==================== SESSION STORE ====================

  async function saveSessionData(sessionId) {
    if (!sessionId) return;
    const s = sessions.get(sessionId);
    if (!s) return;

    activeSessionsStore[sessionId] = {
      ownerUid: s.ownerUid,
      accountId: s.accountId,
      startedAt: s.startedAt || nowMs(),
      server: s.server,
      connectionType: s.connectionType,
      bedrockVersion: s.bedrockVersion,
      offlineUsername: s.offlineUsername,
      lastActive: nowMs(),
    };
    await sessionStore.save();
  }

  async function saveAllSessionData() {
    for (const [sessionId] of sessions) {
      await saveSessionData(sessionId);
    }
  }

  async function clearSessionData(sessionId) {
    if (activeSessionsStore[sessionId]) {
      delete activeSessionsStore[sessionId];
      await sessionStore.save();
    }
  }

  // ==================== WORKER PROCESS MANAGEMENT ====================

  function buildWorkerOpts(ownerUid, authDir, server) {
    const u = getUser(ownerUid);
    const { ip, port } = server;

    const opts = {
      host: ip,
      port: parseInt(port, 10),
      connectTimeout: CONFIG.CONNECTION_TIMEOUT_MS,
      keepAlive: true,
      viewDistance: 1,
      profilesFolder: authDir,
      username: ownerUid,
      offline: false,
      skipPing: true,
      autoInitPlayer: true,
      // IMPORTANT: bedrock-protocol's built-in timeout logic has been observed
      // to trigger native aborts in some environments. We disable it and rely
      // on the worker-level connect guard instead.
      useTimeout: false,
    };

    if (u.connectionType === 'offline') {
      opts.username = u.offlineUsername || `AFK_${ownerUid.slice(-4)}`;
      opts.offline = true;
    }

    return opts;
  }

  function spawnWorkerForSession(sessionId, runId, opts) {
    // Spawn this same file as a worker.
    const child = fork(__filename, [], {
      env: { ...process.env, AFKBOT_WORKER: '1' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    child.on('message', (msg) => {
      try {
        if (!msg || typeof msg !== 'object') return;
        const s = sessions.get(sessionId);
        if (!s) return;

        if (msg.type === 'worker_ready') {
          // no-op
        } else if (msg.type === 'worker_log') {
          if (msg.level === 'error') console.error(`[WORKER ${sessionId}]`, msg.message);
          else console.log(`[WORKER ${sessionId}]`, msg.message);
        } else if (msg.type === 'mc_spawn') {
          logToDiscord(`Bot of <@${s.ownerUid}> spawned.`);
        } else if (msg.type === 'mc_connected') {
          s.connected = true;
          s.isReconnecting = false;
          s.reconnectAttempt = 0;
          logToDiscord(`Bot of <@${s.ownerUid}> connected to **${s.serverLabel}**`);
        } else if (msg.type === 'mc_disconnect') {
          logToDiscord(`Bot of <@${s.ownerUid}> was kicked: ${msg.reason || 'Unknown reason'}`);
        } else if (msg.type === 'mc_error') {
          console.error(`Session error for ${sessionId}:`, msg.message || 'Unknown error');
          logToDiscord(`Bot of <@${s.ownerUid}> error: \`${String(msg.message || 'Unknown error').slice(0, 200)}\``);
        } else if (msg.type === 'mc_stale') {
          console.warn(`Stale connection detected for ${sessionId}`);
        } else if (msg.type === 'mc_close') {
          // will be handled by exit handler too
        }
      } catch (_) {}
    });

    child.once('exit', (code, signal) => {
      const s = sessions.get(sessionId);
      if (!s) return;

      s.child = null;
      s.connected = false;

      // If we're shutting down or session was manually stopped/cleaned, do nothing.
      if (isShuttingDown || s.manualStop || s.isCleaningUp) {
        return;
      }

      // Worker died unexpectedly (including native crash). Reconnect logic handles it.
      const nextAttempt = Math.max(1, (s.reconnectAttempt || 0) + 1);
      console.warn(`Worker for ${sessionId} exited (${signal || code}). Scheduling reconnect attempt ${nextAttempt}...`);
      handleAutoReconnect(sessionId, nextAttempt);
    });

    // Kick off worker start.
    child.send({ type: 'start', uid: sessionId, runId, opts });
    return child;
  }

  async function stopWorker(sessionId, s) {
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

  async function cleanupSession(sessionId) {
    if (!sessionId) return;
    if (cleanupLocks.has(sessionId)) {
      return;
    }

    cleanupLocks.add(sessionId);
    try {
      const s = sessions.get(sessionId);
      if (!s) return;

      s.isCleaningUp = true;
      s.manualStop = true;

      if (s.reconnectTimer) {
        clearTimeout(s.reconnectTimer);
        s.reconnectTimer = null;
      }

      // Stop worker process (no bedrock-protocol close in parent).
      await stopWorker(sessionId, s);

      sessions.delete(sessionId);
      removeSessionIndex(s.ownerUid, sessionId);
    } finally {
      cleanupLocks.delete(sessionId);
    }
  }

  async function cleanupAllSessions() {
    const promises = [];
    for (const [sessionId] of sessions) {
      promises.push(cleanupSession(sessionId));
    }
    await Promise.all(promises);
  }

  async function stopSession(sessionId) {
    if (!sessionId) return false;
    const s = sessions.get(sessionId);
    if (s) {
      s.manualStop = true;
      if (s.reconnectTimer) {
        clearTimeout(s.reconnectTimer);
        s.reconnectTimer = null;
      }
    }
    await clearSessionData(sessionId);
    await cleanupSession(sessionId);
    return true;
  }

  async function stopAllSessionsForUser(uid) {
    const ids = getOwnerSessionIds(uid);
    for (const sessionId of ids) {
      await stopSession(sessionId);
    }
  }

  // ==================== RECONNECTION SYSTEM ====================

  async function handleAutoReconnect(sessionId, attempt = 1) {
    if (!sessionId || isShuttingDown) return;
    const s = sessions.get(sessionId);
    if (!s || s.manualStop || s.isCleaningUp) return;

    attempt = Math.max(1, attempt);

    // IMPORTANT: Do not delete session data on repeated reconnect failures.
    // Production servers can be down for maintenance; the bot should keep trying.
    if (!isUnlimitedReconnects() && attempt > CONFIG.MAX_RECONNECT_ATTEMPTS) {
      logToDiscord(`Bot of <@${s.ownerUid}> reached max reconnect attempts. Cooling down and continuing...`);
      attempt = 1;
    }

    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);

    s.isReconnecting = true;
    s.reconnectAttempt = attempt;

    const delay = computeReconnectDelayMs(attempt);

    logToDiscord(`Bot of <@${s.ownerUid}> disconnected. Reconnecting in ${Math.round(delay / 1000)}s (Attempt ${attempt})...`);

    s.reconnectTimer = setTimeout(async () => {
      if (!isShuttingDown && !s.manualStop) {
        // Kill any previous worker first (if still around)
        await stopWorker(sessionId, s);
        if (!isShuttingDown) {
          await startSession(s.ownerUid, s.accountId, s.server, null, true, attempt, sessionId);
        }
      } else {
        await cleanupSession(sessionId);
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

  function adminPanelRow() {
    return {
      content: '**Admin Panel**',
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('admin_grant').setLabel('Grant / Update Access').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('admin_remove').setLabel('Remove Access').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('admin_list').setLabel('List Users').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('admin_announce').setLabel('Public Announcement').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('admin_announce_test').setLabel('Test Announcement').setStyle(ButtonStyle.Secondary),
        ),
      ],
    };
  }

  // ==================== MICROSOFT AUTHENTICATION ====================

  async function linkMicrosoft(uid, interaction) {
    if (!uid || !interaction) return;

    if (!hasAccess(uid)) {
      return safeReply(interaction, ERR_NO_ACCESS, true);
    }

    // Always defer quickly to avoid "Unknown interaction".
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
    } catch (_) {}

    if (pendingLink.has(uid)) {
      return safeReply(interaction, 'Login already in progress. Check your DMs or use the last code.', true);
    }

    // Enforce max accounts
    const maxAccounts = getMaxAccounts(uid);
    const currentAccounts = listAccounts(uid).length;
    if (maxAccounts !== 'infinity' && currentAccounts >= maxAccounts) {
      return safeReply(interaction, ERR_MAX_ACCOUNT_LIMIT, true);
    }

    const accountId = makeId('acc_');
    const authDir = await getUserAuthDir(uid, accountId);
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
          lastMsa.set(uid, { uri, code, at: nowMs() });

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

          // Save account record
          if (!Array.isArray(u.microsoftAccounts)) u.microsoftAccounts = [];
          u.microsoftAccounts.push({
            id: accountId,
            createdAt: nowMs(),
            tokenAcquiredAt: nowMs(),
            lastUsedAt: null,
          });

          // Legacy alias fields
          u.linked = true;
          u.tokenAcquiredAt = nowMs();

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

  async function startSession(ownerUid, accountId, server, interaction, isReconnect = false, reconnectAttempt = 1, existingSessionId = null) {
    if (!ownerUid || isShuttingDown) return null;

    if (!storesInitialized) {
      if (interaction) safeReply(interaction, 'System initializing, please try again.', true);
      return null;
    }

    if (!hasAccess(ownerUid)) {
      if (interaction) safeReply(interaction, ERR_NO_ACCESS, true);
      return null;
    }

    // Defer early for interactive calls to avoid Unknown interaction.
    if (interaction && !interaction.deferred && !interaction.replied) {
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      } catch (_) {}
    }

    // Enforce global bot cap
    if (!isReconnect && sessions.size >= GLOBAL_MAX_BOTS && !isAdmin(ownerUid)) {
      if (interaction) safeReply(interaction, ERR_MAX_BOT_LIMIT, true);
      return null;
    }

    // Enforce per-user bot limit
    const maxBots = getMaxBots(ownerUid);
    const currentBots = getOwnerSessionCount(ownerUid);
    if (!isReconnect && maxBots !== 'infinity' && currentBots >= maxBots && !isAdmin(ownerUid)) {
      if (interaction) safeReply(interaction, ERR_MAX_BOT_LIMIT, true);
      return null;
    }

    // Wait for ongoing cleanup of this session id.
    if (existingSessionId && cleanupLocks.has(existingSessionId)) {
      let attempts = 0;
      while (cleanupLocks.has(existingSessionId) && attempts < 10) {
        await new Promise((r) => setTimeout(r, 500));
        attempts++;
      }
    }

    const u = getUser(ownerUid);
    if (!u) {
      if (interaction) safeReply(interaction, 'User data error.', true);
      return null;
    }

    const accounts = listAccounts(ownerUid);
    if (!accounts.length) {
      if (interaction) safeReply(interaction, 'Please auth with Xbox to use the bot', true);
      return null;
    }

    const selectedAccount = accounts.find((a) => a.id === accountId) || accounts[0];
    const selectedAccountId = selectedAccount?.id || accounts[0].id;

    if (!server?.ip) {
      if (interaction) safeReply(interaction, 'Please configure your server settings first.', true);
      return null;
    }

    const { ip, port } = server;
    if (!isValidIP(ip) || !isValidPort(port)) {
      if (interaction) safeReply(interaction, 'Invalid server IP or port format.', true);
      return null;
    }

    // Reconnect: cleanup old session before restarting
    if (isReconnect && existingSessionId && sessions.has(existingSessionId)) {
      await cleanupSession(existingSessionId);
    }

    const authDir = await getUserAuthDir(ownerUid, selectedAccountId);
    if (!authDir) {
      if (interaction) safeReply(interaction, 'Auth directory error.', true);
      return null;
    }

    const runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const sessionId = existingSessionId || makeId(`s_${ownerUid}_`);

    const session = {
      sessionId,
      ownerUid,
      accountId: selectedAccountId,
      runId,
      child: null,
      startedAt: nowMs(),
      manualStop: false,
      connected: false,
      isReconnecting: !!isReconnect,
      isCleaningUp: false,
      reconnectAttempt: reconnectAttempt,
      reconnectTimer: null,
      server: { ip, port },
      serverLabel: `${ip}:${port}`,
      connectionType: u.connectionType,
      bedrockVersion: u.bedrockVersion,
      offlineUsername: u.offlineUsername,
    };

    sessions.set(sessionId, session);
    addSessionIndex(ownerUid, sessionId);

    // Save "last used" server for legacy flows
    u.server = { ip, port };
    if (Array.isArray(u.servers)) {
      const srv = u.servers.find((s) => s && s.ip === ip && String(s.port) === String(port));
      if (srv) srv.lastUsedAt = nowMs();
    }
    if (selectedAccount) selectedAccount.lastUsedAt = nowMs();
    await userStore.save();

    await saveSessionData(sessionId);

    // Spawn worker (bedrock-protocol lives there)
    const opts = buildWorkerOpts(ownerUid, authDir, server);
    session.child = spawnWorkerForSession(sessionId, runId, opts);

    if (interaction) {
      await safeReply(interaction, 'Scheduled join… Should join in under 5 minutes…', true);
    }

    return sessionId;
  }

  // ==================== SESSION RESTORATION ====================

  async function restoreSessions() {
    const previousSessions = Object.keys(activeSessionsStore || {});
    console.log(`Found ${previousSessions.length} sessions to restore`);

    let delay = 0;
    for (const sessionId of previousSessions) {
      const sessionData = activeSessionsStore[sessionId];
      if (!sessionData || typeof sessionData !== 'object') continue;

      const ownerUid = String(sessionData.ownerUid || '');
      if (!ownerUid || !/^[0-9]+$/.test(ownerUid)) {
        await clearSessionData(sessionId);
        continue;
      }

      if (!hasAccess(ownerUid)) {
        console.log(`Skipping restore for user ${ownerUid}: no access.`);
        await clearSessionData(sessionId);
        continue;
      }

      const hasServer = !!(sessionData.server && sessionData.server.ip && sessionData.server.port);
      if (!hasServer) {
        console.log(`Skipping restore for session ${sessionId}: missing server settings.`);
        await clearSessionData(sessionId);
        continue;
      }

      // Restore into user store (legacy compatibility)
      if (!users[ownerUid]) users[ownerUid] = {};
      const u = getUser(ownerUid);

      if (sessionData.server) u.server = sessionData.server;
      if (sessionData.connectionType) u.connectionType = sessionData.connectionType;
      if (sessionData.bedrockVersion) u.bedrockVersion = sessionData.bedrockVersion;
      if (sessionData.offlineUsername) u.offlineUsername = sessionData.offlineUsername;

      await userStore.save(true);

      setTimeout(() => {
        if (!isShuttingDown) {
          console.log(`Restoring session ${sessionId} for user ${ownerUid}`);
          startSession(ownerUid, sessionData.accountId || 'legacy', sessionData.server, null, true, 1, sessionId);
        }
      }, delay);

      delay += CONFIG.SESSION_RESTORE_DELAY_MS;
    }
  }

  // Watchdog: if a session exists in storage but not in memory, restore it.
  async function watchdogRestoreMissingSessions() {
    try {
      if (!storesInitialized || isShuttingDown) return;
      const storedIds = Object.keys(activeSessionsStore || {});
      if (!storedIds.length) return;

      let delay = 0;
      for (const sessionId of storedIds) {
        if (sessions.has(sessionId)) continue;

        const sessionData = activeSessionsStore[sessionId];
        if (!sessionData || typeof sessionData !== 'object') continue;

        const ownerUid = String(sessionData.ownerUid || '');
        if (!ownerUid || !/^[0-9]+$/.test(ownerUid)) {
          await clearSessionData(sessionId);
          continue;
        }

        if (!hasAccess(ownerUid)) continue;

        const hasServer = !!(sessionData.server && sessionData.server.ip && sessionData.server.port);
        if (!hasServer) continue;

        setTimeout(() => {
          if (isShuttingDown) return;
          if (sessions.has(sessionId)) return;

          console.log(`Watchdog restoring missing session ${sessionId} for user ${ownerUid}`);
          startSession(ownerUid, sessionData.accountId || 'legacy', sessionData.server, null, true, 1, sessionId);
        }, delay);

        delay += 2000;
      }
    } catch (e) {
      console.error('Watchdog error:', e?.message || e);
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
        new SlashCommandBuilder().setName('admin').setDescription('Open admin panel'),
        new SlashCommandBuilder().setName('easteregg').setDescription('Get a random easter egg'),
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

    // Access trackers
    setInterval(() => {
      tickAccessAndEnforce(false);
    }, 60_000).unref?.();

    setInterval(() => {
      tickAccessAndEnforce(true);
    }, 30 * 60_000).unref?.();

    // Restore sessions a bit after boot.
    setTimeout(() => {
      restoreSessions();
    }, 10000).unref?.();

    // Periodic watchdog: if a session exists in storage but not running, restore it.
    setInterval(() => {
      watchdogRestoreMissingSessions();
    }, CONFIG.SESSION_WATCHDOG_INTERVAL_MS).unref?.();
  });

  // ==================== ADMIN PANEL HELPERS ====================

  function buildAdminGrantModal() {
    const modal = new ModalBuilder().setCustomId('admin_grant_modal').setTitle('Grant / Update Access');

    const userIdInput = new TextInputBuilder()
      .setCustomId('user_id')
      .setLabel('User ID')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(32);

    const maxBotsInput = new TextInputBuilder()
      .setCustomId('max_bots')
      .setLabel('Max Bots (number or infinity)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(16);

    const maxAccountsInput = new TextInputBuilder()
      .setCustomId('max_accounts')
      .setLabel('Max Accounts (number or infinity)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(16);

    const durationInput = new TextInputBuilder()
      .setCustomId('duration')
      .setLabel('Duration (e.g. 7d, 12h, 30m, infinity)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(32);

    modal.addComponents(
      new ActionRowBuilder().addComponents(userIdInput),
      new ActionRowBuilder().addComponents(maxBotsInput),
      new ActionRowBuilder().addComponents(maxAccountsInput),
      new ActionRowBuilder().addComponents(durationInput),
    );

    return modal;
  }

  function buildAdminRemoveModal() {
    const modal = new ModalBuilder().setCustomId('admin_remove_modal').setTitle('Remove Access');

    const userIdInput = new TextInputBuilder()
      .setCustomId('user_id')
      .setLabel('User ID')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(32);

    modal.addComponents(new ActionRowBuilder().addComponents(userIdInput));
    return modal;
  }

  function buildAdminAnnouncementModal(customId, title) {
    const modal = new ModalBuilder().setCustomId(customId).setTitle(title);

    const titleInput = new TextInputBuilder()
      .setCustomId('ann_title')
      .setLabel('Title (optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(256);

    const msgInput = new TextInputBuilder()
      .setCustomId('ann_message')
      .setLabel('Announcement Message')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(3800);

    const urlInput = new TextInputBuilder()
      .setCustomId('ann_url')
      .setLabel('URL (optional, must start with https://)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(512);

    const footerInput = new TextInputBuilder()
      .setCustomId('ann_footer')
      .setLabel('Footer (optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(128);

    modal.addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(msgInput),
      new ActionRowBuilder().addComponents(urlInput),
      new ActionRowBuilder().addComponents(footerInput),
    );

    return modal;
  }

  function normalizeHttpsUrl(input) {
    const s = String(input || '').trim();
    if (!s) return null;
    // Only allow https:// links for safety and to avoid accidental mentions like "example.com".
    if (!/^https:\/\/[^\s]+$/i.test(s)) return null;
    return s.slice(0, 512);
  }

  async function sendDmToUser(userId, payload) {
    try {
      const u = await client.users.fetch(String(userId));
      if (!u) return false;
      await u.send(payload);
      return true;
    } catch (_) {
      return false;
    }
  }

  function queueAnnouncementJob(jobFn) {
    announcementQueue = announcementQueue
      .then(() => jobFn())
      .catch((e) => {
        console.error('Announcement job error:', e?.message || e);
      });
    return announcementQueue;
  }

  async function runAnnouncementJob({ adminUid, payload, isTest = false }) {
    const startedAt = nowMs();

    const targetIds = isTest
      ? [String(adminUid)]
      : Object.keys(users || {}).filter((id) => /^[0-9]+$/.test(id) && users[id]?.access?.enabled && hasAccess(id));

    const total = targetIds.length;
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    // Notify log channel (best effort).
    try {
      const t = payload?.embeds?.[0]?.data?.title || '(no title)';
      const d = payload?.embeds?.[0]?.data?.description || '';
      const preview = String(d).replace(/\s+/g, ' ').slice(0, 180);
      await logToDiscord(`📣 Announcement queued by <@${adminUid}> | Title: **${t}** | Preview: ${preview}${d.length > 180 ? '…' : ''}`);
    } catch (_) {}

    for (let i = 0; i < targetIds.length; i++) {
      const id = String(targetIds[i]);

      if (!isTest) {
        // Double-check access at send time.
        if (!users[id]?.access?.enabled || !hasAccess(id)) {
          skipped++;
          continue;
        }
      }

      const ok = await sendDmToUser(id, payload);
      if (ok) sent++;
      else failed++;

      // Delay between DMs to reduce rate-limit pressure.
      await sleep(ANNOUNCEMENT_DM_DELAY_MS);
    }

    const elapsedMs = Math.max(0, nowMs() - startedAt);
    const seconds = Math.round(elapsedMs / 1000);

    const summary =
      `📣 Announcement complete.\n` +
      `Mode: ${isTest ? 'TEST (DM to admin)' : 'PUBLIC (DM to all users with access)'}\n` +
      `Total targets: ${total}\n` +
      `Sent: ${sent}\n` +
      `Failed: ${failed}\n` +
      `Skipped: ${skipped}\n` +
      `Duration: ~${seconds}s`;

    // DM admin with the report (best effort).
    try {
      await sendDmToUser(adminUid, { content: summary });
    } catch (_) {}

    // Also log to log channel.
    try {
      await logToDiscord(summary.replace(/\n/g, ' | '));
    } catch (_) {}

    return { total, sent, failed, skipped, seconds };
  }

  function formatAccessSummary(uid) {
    const u = getUser(uid);
    const a = u.access;
    if (!a?.enabled) return 'Disabled';

    const maxBots = a.maxBots ?? 0;
    const maxAccounts = a.maxAccounts ?? 0;

    let expiryTxt = 'Never';
    const expiresAt = getAccessExpiry(uid);
    if (expiresAt) {
      expiryTxt = new Date(expiresAt).toISOString();
    }

    return `MaxBots: ${maxBots} | MaxAccounts: ${maxAccounts} | Expires: ${expiryTxt}`;
  }

  // ==================== INTERACTIONS ====================

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
        if (i.commandName === 'panel') {
          if (!hasAccess(uid)) return safeReply(i, ERR_NO_ACCESS, true);
          return i.reply(panelRow(false)).catch(() => {});
        }
        if (i.commandName === 'java') {
          if (!hasAccess(uid)) return safeReply(i, ERR_NO_ACCESS, true);
          return i.reply(panelRow(true)).catch(() => {});
        }
        if (i.commandName === 'admin') {
          if (!isAdmin(uid)) return safeReply(i, 'You do not have permission to use this command.', true);
          return safeReply(i, adminPanelRow(), true);
        }
        if (i.commandName === 'easteregg') {
          if (!hasAccess(uid)) return safeReply(i, ERR_NO_ACCESS, true);
          const egg = getRandomEasterEgg();
          const embed = new EmbedBuilder().setTitle('🥚 Easter Egg').setDescription(egg).setColor('#F1C40F').setTimestamp();
          return safeReply(i, { embeds: [embed] }, true);
        }
      }

      // Buttons
      if (i.isButton()) {
        // ==================== ADMIN PANEL ====================

        if (i.customId === 'admin_grant') {
          if (!isAdmin(uid)) return safeReply(i, 'You do not have permission to use this command.', true);
          return i.showModal(buildAdminGrantModal()).catch(() => {});
        }

        if (i.customId === 'admin_remove') {
          if (!isAdmin(uid)) return safeReply(i, 'You do not have permission to use this command.', true);
          return i.showModal(buildAdminRemoveModal()).catch(() => {});
        }

        if (i.customId === 'admin_list') {
          if (!isAdmin(uid)) return safeReply(i, 'You do not have permission to use this command.', true);

          const enabledUsers = Object.keys(users || {})
            .filter((id) => /^[0-9]+$/.test(id) && users[id]?.access?.enabled)
            .slice(0, 25);

          const desc =
            enabledUsers.length === 0
              ? 'No users with access.'
              : enabledUsers.map((id) => `<@${id}> — ${formatAccessSummary(id)}`).join('\n').slice(0, 4096);

          const embed = new EmbedBuilder().setTitle('Access List').setDescription(desc).setColor('#5865F2');
          return safeReply(i, { embeds: [embed] }, true);
        }

        if (i.customId === 'admin_announce') {
          if (!isAdmin(uid)) return safeReply(i, 'You do not have permission to use this command.', true);
          return i.showModal(buildAdminAnnouncementModal('admin_announce_modal', 'Send Public Announcement')).catch(() => {});
        }

        if (i.customId === 'admin_announce_test') {
          if (!isAdmin(uid)) return safeReply(i, 'You do not have permission to use this command.', true);
          return i.showModal(buildAdminAnnouncementModal('admin_announce_test_modal', 'Test Announcement (DM to you)')).catch(() => {});
        }

        // ==================== USER PANEL GUARDS ====================

        if (['link', 'unlink', 'start_bedrock', 'start_java', 'stop', 'settings'].includes(i.customId)) {
          if (!hasAccess(uid)) return safeReply(i, ERR_NO_ACCESS, true);
        }

        // ==================== START FLOW ====================

        if (i.customId === 'start_bedrock' || i.customId === 'start_java') {
          // Enforce bot limit early
          const maxBots = getMaxBots(uid);
          const currentBots = getOwnerSessionCount(uid);
          if (maxBots !== 'infinity' && currentBots >= maxBots && !isAdmin(uid)) {
            return safeReply(i, ERR_MAX_BOT_LIMIT, true);
          }
          if (sessions.size >= GLOBAL_MAX_BOTS && !isAdmin(uid)) {
            return safeReply(i, ERR_MAX_BOT_LIMIT, true);
          }

          const accounts = listAccounts(uid);
          if (!accounts.length) return safeReply(i, 'Please auth with Xbox to use the bot', true);

          const servers = listServers(uid);
          if (!servers.length) return safeReply(i, 'Please configure your server settings first.', true);

          // Defer quickly.
          try {
            await i.deferReply({ flags: MessageFlags.Ephemeral });
          } catch (_) {}

          const opts = accounts.slice(0, 25).map((acc, idx) =>
            new StringSelectMenuOptionBuilder().setLabel(formatAccountLabel(acc, idx)).setValue(String(acc.id)),
          );

          const select = new StringSelectMenuBuilder()
            .setCustomId('start_select_account')
            .setPlaceholder('Select an account')
            .addOptions(opts)
            .setMinValues(1)
            .setMaxValues(1);

          const rows = [new ActionRowBuilder().addComponents(select)];

          const cancelRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary));

          const embeds = [];
          if (i.customId === 'start_java') {
            const embed = new EmbedBuilder()
              .setTitle('Java Compatibility Check')
              .setDescription('For a successful connection to a Java server, ensure the following plugins are installed.')
              .addFields({ name: 'Required Plugins', value: 'GeyserMC\nFloodgate' })
              .setColor('#E67E22');
            embeds.push(embed);
          }

          return safeReply(i, { content: 'What account do you want to join with', embeds: embeds.length ? embeds : undefined, components: [...rows, cancelRow] }, true);
        }

        // ==================== STOP FLOW ====================

        if (i.customId === 'stop') {
          const ids = getOwnerSessionIds(uid);
          if (!ids.length) {
            try {
              await i.deferReply({ flags: MessageFlags.Ephemeral });
            } catch (_) {}
            return safeReply(i, 'No active sessions.', true);
          }

          if (ids.length === 1) {
            try {
              await i.deferReply({ flags: MessageFlags.Ephemeral });
            } catch (_) {}
            const ok = await stopSession(ids[0]);
            return safeReply(i, ok ? '**Session Terminated.**' : 'No active sessions.', true);
          }

          // Multiple sessions -> selection
          try {
            await i.deferReply({ flags: MessageFlags.Ephemeral });
          } catch (_) {}

          const opts = ids.slice(0, 25).map((sid, idx) => {
            const s = sessions.get(sid);
            const label = s ? `${idx + 1}. ${s.serverLabel}` : `${idx + 1}. Unknown`;
            return new StringSelectMenuOptionBuilder().setLabel(label.slice(0, 100)).setValue(String(sid));
          });

          const select = new StringSelectMenuBuilder()
            .setCustomId('stop_select_session')
            .setPlaceholder('Select a bot to stop')
            .addOptions(opts)
            .setMinValues(1)
            .setMaxValues(1);

          const row = new ActionRowBuilder().addComponents(select);
          const cancelRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary));

          return safeReply(i, { content: 'Select a bot to stop.', components: [row, cancelRow] }, true);
        }

        // ==================== LINK / UNLINK ====================

        if (i.customId === 'link') return linkMicrosoft(uid, i);

        if (i.customId === 'unlink') {
          const accounts = listAccounts(uid);
          if (!accounts.length) {
            try {
              await i.deferReply({ flags: MessageFlags.Ephemeral });
            } catch (_) {}
            return safeReply(i, 'Unlinked Microsoft account.', true);
          }

          try {
            await i.deferReply({ flags: MessageFlags.Ephemeral });
          } catch (_) {}

          const opts = accounts.slice(0, 25).map((acc, idx) =>
            new StringSelectMenuOptionBuilder().setLabel(formatAccountLabel(acc, idx)).setValue(String(acc.id)),
          );

          const select = new StringSelectMenuBuilder()
            .setCustomId('unlink_select_account')
            .setPlaceholder('Select an account')
            .addOptions(opts)
            .setMinValues(1)
            .setMaxValues(1);

          const row = new ActionRowBuilder().addComponents(select);
          const cancelRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary));

          return safeReply(i, { content: 'What account would you want to unlink?', components: [row, cancelRow] }, true);
        }

        // ==================== SETTINGS (SERVER MANAGEMENT) ====================

        if (i.customId === 'settings') {
          try {
            await i.deferReply({ flags: MessageFlags.Ephemeral });
          } catch (_) {}

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('server_add').setLabel('Add Server').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('server_remove').setLabel('Remove Server').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          );

          return safeReply(i, { content: 'Server settings:', components: [row] }, true);
        }

        if (i.customId === 'server_add') {
          const modal = new ModalBuilder().setCustomId('server_add_modal').setTitle('Configuration');

          const ipInput = new TextInputBuilder()
            .setCustomId('ip')
            .setLabel('Server IP')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue('')
            .setMaxLength(253);

          const portInput = new TextInputBuilder()
            .setCustomId('port')
            .setLabel('Port')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(String(19132))
            .setMaxLength(5);

          modal.addComponents(new ActionRowBuilder().addComponents(ipInput), new ActionRowBuilder().addComponents(portInput));

          return i.showModal(modal).catch(() => {});
        }

        if (i.customId === 'server_remove') {
          const servers = listServers(uid);
          if (!servers.length) {
            try {
              await i.deferReply({ flags: MessageFlags.Ephemeral });
            } catch (_) {}
            return safeReply(i, 'Please configure your server settings first.', true);
          }

          try {
            await i.deferReply({ flags: MessageFlags.Ephemeral });
          } catch (_) {}

          const opts = servers.slice(0, 25).map((srv) => {
            const label = formatServerLabel(srv).slice(0, 100);
            return new StringSelectMenuOptionBuilder().setLabel(label).setValue(String(srv.id));
          });

          const select = new StringSelectMenuBuilder()
            .setCustomId('server_remove_select')
            .setPlaceholder('Select a server')
            .addOptions(opts)
            .setMinValues(1)
            .setMaxValues(1);

          const row = new ActionRowBuilder().addComponents(select);
          const cancelRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary));

          return safeReply(i, { content: 'Select a server to remove.', components: [row, cancelRow] }, true);
        }

        // Cancel button
        if (i.customId === 'cancel') return safeReply(i, 'Cancelled.', true);
      }

      // Select Menus (String Selects)
      const isSelectMenu =
        (typeof i.isStringSelectMenu === 'function' && i.isStringSelectMenu()) || (typeof i.isSelectMenu === 'function' && i.isSelectMenu());
      if (isSelectMenu) {
        if (!hasAccess(uid)) return safeReply(i, ERR_NO_ACCESS, true);

        if (i.customId === 'start_select_account') {
          const accountId = String(i.values?.[0] || '');
          const accounts = listAccounts(uid);
          const selected = accounts.find((a) => a.id === accountId);
          if (!selected) return safeReply(i, 'Please auth with Xbox to use the bot', true);

          const servers = listServers(uid);
          if (!servers.length) return safeReply(i, 'Please configure your server settings first.', true);

          // Build server selection with encoded value
          const opts = servers.slice(0, 25).map((srv) => {
            const label = formatServerLabel(srv).slice(0, 100);
            const value = `${accountId}|${srv.id}`;
            return new StringSelectMenuOptionBuilder().setLabel(label).setValue(value.slice(0, 100));
          });

          const select = new StringSelectMenuBuilder()
            .setCustomId('start_select_server')
            .setPlaceholder('Select a server')
            .addOptions(opts)
            .setMinValues(1)
            .setMaxValues(1);

          const row = new ActionRowBuilder().addComponents(select);
          const cancelRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary));

          return safeReply(i, { content: 'What server do you want the bot to join?', components: [row, cancelRow] }, true);
        }

        if (i.customId === 'start_select_server') {
          const raw = String(i.values?.[0] || '');
          const [accountId, serverId] = raw.split('|');

          const servers = listServers(uid);
          const server = servers.find((s) => String(s.id) === String(serverId));
          if (!server) return safeReply(i, 'Please configure your server settings first.', true);

          // Bot limit check again (in case changed during selection)
          const maxBots = getMaxBots(uid);
          const currentBots = getOwnerSessionCount(uid);
          if (maxBots !== 'infinity' && currentBots >= maxBots && !isAdmin(uid)) {
            return safeReply(i, ERR_MAX_BOT_LIMIT, true);
          }
          if (sessions.size >= GLOBAL_MAX_BOTS && !isAdmin(uid)) {
            return safeReply(i, ERR_MAX_BOT_LIMIT, true);
          }

          return startSession(uid, accountId, { ip: server.ip, port: server.port }, i, false);
        }

        if (i.customId === 'unlink_select_account') {
          const accountId = String(i.values?.[0] || '');
          try {
            await i.deferReply({ flags: MessageFlags.Ephemeral });
          } catch (_) {}

          await unlinkMicrosoftAccount(uid, accountId);
          return safeReply(i, 'Unlinked Microsoft account.', true);
        }

        if (i.customId === 'server_remove_select') {
          const serverId = String(i.values?.[0] || '');

          try {
            await i.deferReply({ flags: MessageFlags.Ephemeral });
          } catch (_) {}

          const u = getUser(uid);
          u.servers = Array.isArray(u.servers) ? u.servers : [];

          const idx = u.servers.findIndex((s) => s && String(s.id) === String(serverId));
          if (idx === -1) {
            return safeReply(i, 'Server not found.', true);
          }

          const removed = u.servers[idx];

          // Remove from servers list
          u.servers.splice(idx, 1);

          // ALSO remove legacy single-server field if it matches (this is the key fix)
          if (u.server && u.server.ip === removed.ip && String(u.server.port) === String(removed.port)) {
            delete u.server;
          }

          // If no servers left, clear legacy just in case
          if (u.servers.length === 0 && u.server) {
            delete u.server;
          }

          await userStore.save(true);
          return safeReply(i, `Removed: **${formatServerLabel(removed)}**`, true);
        }

        if (i.customId === 'stop_select_session') {
          const sessionId = String(i.values?.[0] || '');
          try {
            await i.deferReply({ flags: MessageFlags.Ephemeral });
          } catch (_) {}
          const ok = await stopSession(sessionId);
          return safeReply(i, ok ? '**Session Terminated.**' : 'No active sessions.', true);
        }
      }

      // Modals
      if (i.isModalSubmit()) {
        // Admin grant
        if (i.customId === 'admin_grant_modal') {
          if (!isAdmin(uid)) return safeReply(i, 'You do not have permission to use this command.', true);

          const targetUid = i.fields?.getTextInputValue('user_id')?.trim();
          const maxBotsStr = i.fields?.getTextInputValue('max_bots')?.trim();
          const maxAccountsStr = i.fields?.getTextInputValue('max_accounts')?.trim();
          const durationStr = i.fields?.getTextInputValue('duration')?.trim();

          if (!targetUid || !/^[0-9]+$/.test(targetUid)) return safeReply(i, 'Invalid User ID.', true);

          const maxBots = parseLimitValue(maxBotsStr);
          const maxAccounts = parseLimitValue(maxAccountsStr);
          const durationMs = parseDurationMs(durationStr);

          if (maxBots === null) return safeReply(i, 'Invalid Max Bots.', true);
          if (maxAccounts === null) return safeReply(i, 'Invalid Max Accounts.', true);
          if (durationMs === null) return safeReply(i, 'Invalid Duration.', true);

          const u = getUser(targetUid);
          if (!u.access || typeof u.access !== 'object') u.access = {};
          u.access.enabled = true;
          u.access.maxBots = maxBots;
          u.access.maxAccounts = maxAccounts;
          u.access.durationMs = durationMs;

          const now = nowMs();
          u.access.grantedAt = now;
          u.access.lastTickAt = now;
          u.access.elapsedMs = 0;
          u.access.expiresAt = !isInfinity(durationMs) ? now + Number(durationMs) : null;

          await userStore.save(true);

          const expiresAt = getAccessExpiry(targetUid);
          const expiryTxt = expiresAt ? new Date(expiresAt).toISOString() : 'Never';

          const msg = `Access updated for <@${targetUid}>\nMax Bots: ${maxBots}\nMax Accounts: ${maxAccounts}\nExpires: ${expiryTxt}`;
          return safeReply(i, msg, true);
        }

        // Admin remove
        if (i.customId === 'admin_remove_modal') {
          if (!isAdmin(uid)) return safeReply(i, 'You do not have permission to use this command.', true);

          const targetUid = i.fields?.getTextInputValue('user_id')?.trim();
          if (!targetUid || !/^[0-9]+$/.test(targetUid)) return safeReply(i, 'Invalid User ID.', true);

          const u = getUser(targetUid);
          if (!u.access || typeof u.access !== 'object') u.access = {};
          u.access.enabled = false;
          u.access.revokedAt = nowMs();
          await userStore.save(true);

          await stopAllSessionsForUser(targetUid);

          return safeReply(i, `Access removed for <@${targetUid}>`, true);
        }

        // Admin announcement (public)
        if (i.customId === 'admin_announce_modal' || i.customId === 'admin_announce_test_modal') {
          if (!isAdmin(uid)) return safeReply(i, 'You do not have permission to use this command.', true);

          const isTest = i.customId === 'admin_announce_test_modal';

          const rawTitle = (i.fields?.getTextInputValue('ann_title') || '').trim();
          const rawMessage = (i.fields?.getTextInputValue('ann_message') || '').trim();
          const rawUrl = (i.fields?.getTextInputValue('ann_url') || '').trim();
          const rawFooter = (i.fields?.getTextInputValue('ann_footer') || '').trim();

          if (!rawMessage) return safeReply(i, 'Announcement message cannot be empty.', true);

          let url = null;
          if (rawUrl) {
            url = normalizeHttpsUrl(rawUrl);
            if (!url) return safeReply(i, 'Invalid URL. It must start with https:// and contain no spaces.', true);
          }

          // Defer quickly so the modal submit doesn’t time out.
          try {
            if (!i.deferred && !i.replied) {
              await i.deferReply({ flags: MessageFlags.Ephemeral });
            }
          } catch (_) {}

          const embed = new EmbedBuilder().setColor('#5865F2').setTimestamp();
          if (rawTitle) embed.setTitle(rawTitle.slice(0, 256));
          embed.setDescription(rawMessage.slice(0, 4096));

          if (url) embed.setURL(url);

          const footer = rawFooter ? rawFooter.slice(0, 128) : 'AFKBot Announcement';
          embed.setFooter({ text: footer });

          const payload = { embeds: [embed] };

          // Queue the actual send so large lists don’t risk interaction expiry.
          const targetCount = isTest
            ? 1
            : Object.keys(users || {}).filter((id) => /^[0-9]+$/.test(id) && users[id]?.access?.enabled && hasAccess(id)).length;

          const modeLabel = isTest ? 'TEST' : 'PUBLIC';
          await safeReply(i, `Queued ${modeLabel} announcement to ${targetCount} user(s). I will DM you the final report.`, true);

          queueAnnouncementJob(() => runAnnouncementJob({ adminUid: uid, payload, isTest }));
          return;
        }

        // Server add
        if (i.customId === 'server_add_modal') {
          const ip = i.fields?.getTextInputValue('ip')?.trim();
          const portStr = i.fields?.getTextInputValue('port')?.trim();
          const port = parseInt(portStr, 10);

          if (!ip || !portStr) return safeReply(i, 'IP and Port are required.', true);
          if (!isValidIP(ip)) return safeReply(i, 'Invalid IP address format.', true);
          if (!isValidPort(port)) return safeReply(i, 'Invalid port (must be 1-65535).', true);

          // Enforce server entries <= max bots
          const maxBots = getMaxBots(uid);
          const u = getUser(uid);

          const currentServers = listServers(uid).length;
          if (maxBots !== 'infinity' && currentServers >= maxBots && !isAdmin(uid)) {
            return safeReply(i, ERR_MAX_BOT_LIMIT, true);
          }

          const serverId = makeId('srv_');
          if (!Array.isArray(u.servers)) u.servers = [];
          u.servers.push({ id: serverId, ip, port, createdAt: nowMs(), lastUsedAt: null });

          // Legacy
          u.server = { ip, port };

          await userStore.save(true);
          return safeReply(i, `Saved: **${ip}:${port}**`, true);
        }
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
