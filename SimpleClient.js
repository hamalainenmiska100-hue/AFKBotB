const mc = require('minecraft-protocol');
const EventEmitter = require('events');

/**
 * Robust Native Minecraft Client
 * Bypasses Mineflayer overhead for maximum stability.
 * Features: Auto-Ping Version Detect, Raw Packet AFK, Event Bridging.
 */
class SimpleClient extends EventEmitter {
    constructor(options) {
        super();
        this.options = options;
        this.client = null;
        this.afkInterval = null;
        this.connected = false;
        this.reconnectAttempted = false;
    }

    /**
     * Resolves the server version via Ping before connecting.
     * This fixes "Protocol Data Missing" errors.
     */
    async resolveVersion(host, port) {
        if (this.options.version && this.options.version !== 'auto') {
            return this.options.version;
        }
        
        console.log(`[SimpleClient] Pinging ${host}:${port} to detect version...`);
        return new Promise((resolve) => {
            // Timeout ping after 5 seconds
            const t = setTimeout(() => {
                console.log('[SimpleClient] Ping timed out. Defaulting to auto.');
                resolve(false); 
            }, 5000);

            mc.ping({ host, port }, (err, response) => {
                clearTimeout(t);
                if (err) {
                    console.log(`[SimpleClient] Ping failed: ${err.message}`);
                    resolve(false); // Let the client try auto
                } else {
                    console.log(`[SimpleClient] Detected Server Version: ${response.version.name} (Protocol: ${response.version.protocol})`);
                    resolve(response.version.name); // e.g., "1.21.1"
                }
            });
        });
    }

    async connect() {
        // 1. Determine Version
        const versionToUse = await this.resolveVersion(this.options.host, this.options.port);
        
        const clientOptions = {
            host: this.options.host,
            port: this.options.port,
            username: this.options.username,
            auth: this.options.auth, // 'microsoft' or 'offline'
            version: versionToUse || false, // false = auto-detect fallback
            
            // Network Tweaks
            fakeHost: this.options.host, // Fixes ECONNRESET on proxies
            keepAlive: true,
            checkTimeoutInterval: 60 * 1000,
            hideErrors: false,

            // Auth Callback
            onMsaCode: (data) => {
                this.emit('msaCode', data);
            }
        };

        if (this.options.profilesFolder) {
            clientOptions.profilesFolder = this.options.profilesFolder;
        }

        console.log(`[SimpleClient] Initializing connection with version: ${clientOptions.version || 'AUTO'}`);

        try {
            this.client = mc.createClient(clientOptions);
            this.setupListeners();
        } catch (e) {
            this.emit('error', e);
        }
    }

    setupListeners() {
        if (!this.client) return;

        // --- Critical Events ---

        this.client.on('connect', () => {
            console.log('[SimpleClient] TCP Connection established.');
        });

        // "login" event means we are authenticated and in the game state
        this.client.on('login', () => {
            this.connected = true;
            console.log('[SimpleClient] Logged in successfully!');
            this.emit('spawn'); // Bridge to bot.js
            this.startAFK();
        });

        this.client.on('end', (reason) => {
            this.connected = false;
            this.stopAFK();
            console.log(`[SimpleClient] Connection ended: ${reason}`);
            this.emit('end', reason);
        });

        this.client.on('error', (err) => {
            this.connected = false;
            console.error(`[SimpleClient] Error: ${err.message}`);
            this.emit('error', err);
        });

        this.client.on('kick_disconnect', (packet) => {
            const reason = JSON.stringify(packet.reason);
            console.log(`[SimpleClient] Kicked: ${reason}`);
            this.emit('kick', reason);
        });

        // --- Chat logging ---
        this.client.on('chat', (packet) => {
            try {
                // Parse JSON chat to readable string
                const json = JSON.parse(packet.message);
                const text = json.text || (json.extra ? json.extra.map(x => x.text).join('') : '') || JSON.stringify(json);
                console.log(`[CHAT] ${text}`);
            } catch (e) {
                // Ignore parsing errors
            }
        });
    }

    /**
     * Sends raw packets to stay active.
     * Rotating head is safer than jumping (less likely to be flagged by anti-cheat).
     */
    startAFK() {
        if (this.afkInterval) clearInterval(this.afkInterval);
        
        console.log('[SimpleClient] Starting Raw Packet AFK...');
        this.afkInterval = setInterval(() => {
            if (this.client && this.connected) {
                try {
                    // Send Position/Look packet
                    // We just rotate yaw slightly to show activity
                    this.client.write('look', {
                        yaw: Math.random() * 360,
                        pitch: 0,
                        onGround: true
                    });
                } catch (e) {
                    console.log('AFK Packet failed:', e.message);
                }
            }
        }, 5000); // Every 5 seconds
    }

    stopAFK() {
        if (this.afkInterval) clearInterval(this.afkInterval);
    }

    disconnect() {
        this.stopAFK();
        if (this.client) {
            this.client.end();
            this.client.removeAllListeners();
        }
    }

    // Helper to send chat
    chat(message) {
        if (this.client && this.connected) {
            this.client.write('chat', { message: message });
        }
    }
}

module.exports = SimpleClient;


