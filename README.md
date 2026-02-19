# Bedrock AFK Bot

A Discord bot that manages persistent AFK (Away From Keyboard) sessions for Minecraft Bedrock Edition servers. The bot maintains 24/7 connections to Minecraft servers with automatic reconnection, anti-AFK mechanics, and Microsoft account integration.

## How It Works

The bot creates lightweight Minecraft Bedrock clients through Discord commands. Each user can run one bot instance that connects to a specified server, performs anti-AFK actions (arm swinging, crouching), and automatically reconnects if disconnected.

### Core Architecture

**Session Management**
- Each Discord user gets one persistent Minecraft session
- Sessions survive bot restarts through JSON-based storage (`rejoin.json`)
- Write-ahead logging (WAL) ensures data integrity during crashes
- Graceful shutdown with 15-second timeout for cleanup

**Connection Lifecycle**
1. User configures server IP/port via Settings modal
2. Bot verifies Microsoft authentication (device code flow via `prismarine-auth`)
3. Creates `bedrock-protocol` client with 30-second connection timeout
4. Monitors health via keepalive packets (15s interval) and stale connection detection (60s timeout)
5. On disconnect: exponential backoff reconnection (5s base, max 5min jitter)
6. Native cleanup delays (2s) prevent heap corruption from rapid reconnects

**Anti-AFK System**
- Randomized actions every 8-20 seconds:
  - 60% chance: Arm swing animation
  - 20% chance: Crouch toggle (2-4s duration)
  - 20% chance: No action
- Prevents server kick for inactivity while maintaining minimal bandwidth

### Authentication Flow

**Online Mode (Default)**
- Requires Microsoft account linking via `/link` command
- Uses device code OAuth flow (Nintendo Switch device type)
- Tokens stored locally per-user in `data/auth/[uid]/`
- 5-minute timeout for authentication completion
- Auto-detects expired tokens (5min buffer before expiry)

**Offline Mode**
- Optional per-user setting
- Username auto-generated as `AFK_[last4digits]`
- No Microsoft account required
- Limited to cracked/offline-mode servers

### Admin Panel

Admin users (configured via `ADMIN_ID`) access:
- Real-time RAM/Heap monitoring
- Active session registry with connection status
- Force-stop individual or all sessions
- Manual data persistence triggers
- Auto-refreshing embed (30s interval)

### Safety Mechanisms

**Crash Prevention**
- Native memory corruption protection: 2-second delays between session cleanup and reconnection
- Skips `bedrock.ping()` on reconnects to avoid double-free heap errors in RakNet native bindings
- All errors caught silently with optional crash logging to `data/crash.log`
- Operation timeouts (30s) on client creation to prevent hanging promises

**Rate Limiting**
- 1-second cooldown per user on button interactions
- Discord REST retry logic with 3 attempts

**Data Integrity**
- Atomic file writes (write to `.tmp`, rename to target)
- Automatic backup of corrupt JSON files
- Emergency backup on save failures

## Installation

### Requirements
- Node.js 18+
- Discord Bot Token
- 512MB+ RAM (scales with concurrent sessions)

### Setup

1. **Clone and install**
```bash
git clone <repo>
cd bedrock-afk-bot
npm install discord.js bedrock-protocol prismarine-auth
