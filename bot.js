const { 
    Client, 
    GatewayIntentBits, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    Events, 
    SlashCommandBuilder, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    StringSelectMenuBuilder, 
    EmbedBuilder, 
    ActivityType, 
    Partials,
    Collection
} = require("discord.js");
const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const APEX_IDENTIFIERS = {
    KERNEL_NAMESPACE: "SENTINEL_APEX_KERNEL",
    VERSION_MAJOR: 6,
    VERSION_MINOR: 0,
    VERSION_PATCH: 1,
    BUILD_HASH: "0x88AF22C9",
    RUNTIME_ENVIRONMENT: "PRODUCTION",
    SECURITY_LEVEL: "ENTERPRISE_GRADE"
};

const APEX_SYSTEM_CONSTANTS = {
    DISCORD_GUILD_IDENTITY: "1462335230345089254",
    DISCORD_ADMINISTRATOR_IDENTITY: "1144987924123881564",
    CHANNEL_DIAGNOSTICS_IDENTITY: "1464615030111731753",
    CHANNEL_OVERLORD_IDENTITY: "1464615993320935447",
    HANDSHAKE_TIMEOUT_MILLISECONDS: 90000,
    RECONNECTION_COOLDOWN_MILLISECONDS: 45000,
    DASHBOARD_REFRESH_INTERVAL_MILLISECONDS: 60000,
    AUTO_BOOTSTRAP_DELAY_MILLISECONDS: 6000,
    AFK_SIMULATION_INTERVAL_MILLISECONDS: 50000,
    MAXIMUM_SESSIONS_PER_INSTANCE: 512,
    DEFAULT_BEDROCK_NETWORK_PORT: 19132,
    STORAGE_ENCODING_FORMAT: "utf8"
};

const APEX_STATUS_CODES = {
    IDLE: "IDLE",
    INITIALIZING: "INITIALIZING",
    AUTHENTICATING: "AUTHENTICATING",
    NEGOTIATING: "NEGOTIATING",
    ESTABLISHED: "ESTABLISHED",
    FAILED: "FAILED",
    TERMINATED: "TERMINATED",
    RECOVERING: "RECOVERING"
};

const APEX_PROTOCOL_VERSIONS = {
    V1_20_0: "1.20.0",
    V1_20_10: "1.20.10",
    V1_20_30: "1.20.30",
    V1_20_40: "1.20.40",
    V1_20_50: "1.20.50",
    V1_20_60: "1.20.60",
    V1_20_70: "1.20.70",
    V1_20_80: "1.20.80",
    V1_21_0: "1.21.0",
    AUTO_NEGOTIATE: "auto"
};

const APEX_COLOR_PALETTE = {
    PRIMARY_SUCCESS: 0x00FF88,
    PRIMARY_FAILURE: 0xFF3355,
    PRIMARY_NEUTRAL: 0x2F3136,
    PRIMARY_WARNING: 0xFFAA00,
    PRIMARY_INFO: 0x00AAFF,
    PRIMARY_ACCENT: 0xAA00FF,
    UI_BACKGROUND: 0x1A1B1E,
    UI_HIGHLIGHT: 0xFFFFFF
};

const APEX_UI_DICTIONARY = {
    DASHBOARD_HEADER: "💎 SENTINEL APEX | ENTERPRISE CONTROL",
    DASHBOARD_SUBHEADER: "Mission-Critical Bedrock AFK Orchestration",
    OVERLORD_HEADER: "👑 SYSTEM OVERLORD | GLOBAL ANALYTICS",
    OVERLORD_SUBHEADER: "Real-Time Fleet Diagnostic Interface",
    LABEL_STATE: "Deployment State",
    LABEL_TRAFFIC: "Network Throughput",
    LABEL_IDENTITY: "Identity Integrity",
    LABEL_UPTIME: "Session Longevity",
    LABEL_ENDPOINT: "Network Endpoint",
    BTN_DEPLOY: "Initiate Deployment",
    BTN_HALT: "Terminate Session",
    BTN_AUTH: "Establish Auth Link",
    BTN_CONFIG: "Modify Parameters",
    BTN_SYNC: "Synchronize Logic",
    MSG_BOOT: "Sentinel Kernel Initialized Successfully.",
    MSG_SHUTDOWN: "Session Terminated by Global Override.",
    MSG_RETRY: "Initiating Autonomous Recovery Sequence.",
    MSG_AUTH_SUCCESS: "Microsoft Identity Handshake Verified."
};

class ApexCoreException extends Error {
    constructor(message, code) {
        super(message);
        this.name = "ApexCoreException";
        this.code = code;
        this.timestamp = Date.now();
    }
}

class ApexNetworkException extends ApexCoreException {
    constructor(message) {
        super(message, "NETWORK_FAILURE");
    }
}

class ApexAuthException extends ApexCoreException {
    constructor(message) {
        super(message, "AUTHENTICATION_FAILURE");
    }
}

class ApexValidationUtility {
    static isString(value) {
        return typeof value === "string";
    }
    static isNumber(value) {
        return typeof value === "number" && !isNaN(value);
    }
    static isObject(value) {
        return typeof value === "object" && value !== null;
    }
    static validateIp(ip) {
        if (!this.isString(ip)) return false;
        const segments = ip.split(".");
        if (segments.length !== 4) return true; 
        return true;
    }
    static validatePort(port) {
        const p = parseInt(port);
        return this.isNumber(p) && p >= 0 && p <= 65535;
    }
}

class ApexStorageProvider {
    constructor() {
        this.baseDirectoryPath = path.join(__dirname, "sentinel_apex_data");
        this.vaultFilePath = path.join(this.baseDirectoryPath, "apex_vault.json");
        this.identityDirectoryPath = path.join(this.baseDirectoryPath, "identities");
        this.runtimeCache = null;
        this.initializeStorageStructure();
    }
    initializeStorageStructure() {
        if (!fs.existsSync(this.baseDirectoryPath)) {
            fs.mkdirSync(this.baseDirectoryPath);
        }
        if (!fs.existsSync(this.identityDirectoryPath)) {
            fs.mkdirSync(this.identityDirectoryPath, { recursive: true });
        }
        if (!fs.existsSync(this.vaultFilePath)) {
            const initialSchema = {
                registry: {},
                globalMetrics: {
                    totalDeployments: 0,
                    totalUptimeMinutes: 0,
                    totalHandshakeFailures: 0,
                    totalPacketThroughput: 0,
                    kernelBootstrapEpoch: Date.now()
                }
            };
            fs.writeFileSync(this.vaultFilePath, JSON.stringify(initialSchema, null, 4));
            this.runtimeCache = initialSchema;
        } else {
            this.runtimeCache = JSON.parse(fs.readFileSync(this.vaultFilePath, APEX_SYSTEM_CONSTANTS.STORAGE_ENCODING_FORMAT));
        }
    }
    commitChanges() {
        fs.writeFileSync(this.vaultFilePath, JSON.stringify(this.runtimeCache, null, 4));
    }
    retrieveUserRecord(uid) {
        if (!this.runtimeCache.registry[uid]) {
            this.runtimeCache.registry[uid] = {
                linkedStatus: false,
                isCurrentlyActive: false,
                protocolMode: "online",
                targetEndpoint: { host: "", port: "19132" },
                deploymentProfile: {
                    autoRecoveryEnabled: true,
                    evasionIntensity: "HIGH",
                    targetProtocolVersion: APEX_PROTOCOL_VERSIONS.AUTO_NEGOTIATE,
                    customOfflineAlias: `Sentinel_${uid.slice(-4)}`
                },
                historicalLogs: []
            };
            this.commitChanges();
        }
        return this.runtimeCache.registry[uid];
    }
    getIdentityVaultPath(uid) {
        const userSpecificPath = path.join(this.identityDirectoryPath, uid);
        if (!fs.existsSync(userSpecificPath)) {
            fs.mkdirSync(userSpecificPath, { recursive: true });
        }
        return userSpecificPath;
    }
}

const ApexVault = new ApexStorageProvider();

class ApexIdentityOrchestrator {
    static createIdentityFlow(uid) {
        const storagePath = ApexVault.getIdentityVaultPath(uid);
        return new Authflow(uid, storagePath, {
            flow: "msal",
            authTitle: Titles.MinecraftNintendoSwitch,
            deviceType: "Nintendo"
        });
    }
    static async performIdentityChallenge(uid, interaction) {
        const storagePath = ApexVault.getIdentityVaultPath(uid);
        const flow = new Authflow(uid, storagePath, {
            flow: "msal",
            authTitle: Titles.MinecraftNintendoSwitch,
            deviceType: "Nintendo"
        }, async (challengeData) => {
            const challengeEmbed = new EmbedBuilder()
                .setTitle("🔐 APEX IDENTITY HANDSHAKE")
                .setDescription(`Identity verification required for secure deployment.\n\n🔑 CHALLENGE CODE: **\`${challengeData.user_code}\`**\n\n1. Navigate to: [Microsoft Verification](${challengeData.verification_uri})\n2. Provide the challenge code.\n\n*The kernel will intercept confirmation automatically.*`)
                .setColor(APEX_COLOR_PALETTE.PRIMARY_INFO)
                .setThumbnail("https://upload.wikimedia.org/wikipedia/commons/thumb/4/44/Microsoft_logo.svg/1024px-Microsoft_logo.svg.png")
                .setFooter({ text: "Challenge Expiry: 15 Minutes" });
            const interactionRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel("Open Identity Portal")
                    .setStyle(ButtonStyle.Link)
                    .setURL(challengeData.verification_uri)
            );
            await interaction.editReply({ embeds: [challengeEmbed], components: [interactionRow] });
        });
        await flow.getMsaToken();
        const userRecord = ApexVault.retrieveUserRecord(uid);
        userRecord.linkedStatus = true;
        ApexVault.commitChanges();
    }
}

class ApexEvasionService {
    static generateRandomFloat(min, max) {
        return Math.random() * (max - min) + min;
    }
    static applyPositionJitter(client) {
        if (!client.entityId) return;
        const currentPosition = client.entity?.position || { x: 0, y: 0, z: 0 };
        const jitterX = this.generateRandomFloat(-0.08, 0.08);
        const jitterZ = this.generateRandomFloat(-0.08, 0.08);
        const randomPitch = this.generateRandomFloat(-4, 4);
        const randomYaw = this.generateRandomFloat(0, 360);
        client.write("move_player", {
            runtime_id: client.entityId,
            position: { x: currentPosition.x + jitterX, y: currentPosition.y, z: currentPosition.z + jitterZ },
            pitch: randomPitch,
            yaw: randomYaw,
            head_yaw: randomYaw,
            mode: 0,
            on_ground: true,
            ridden_runtime_id: 0,
            teleport: false
        });
    }
    static triggerAnimationPulse(client) {
        if (!client.entityId) return;
        client.write("animate", { action_id: 1, runtime_entity_id: client.entityId });
    }
}

class ApexSessionKernel {
    constructor(uid) {
        this.userUid = uid;
        this.record = ApexVault.retrieveUserRecord(uid);
        this.bedrockClientInstance = null;
        this.currentStatusState = APEX_STATUS_CODES.IDLE;
        this.deploymentEpoch = 0;
        this.processedPacketCount = 0;
        this.forceTerminationSignal = false;
        this.scheduledTasks = {
            reconnectionTimeout: null,
            handshakeGuard: null,
            simulationInterval: null,
            watchdogTimer: null
        };
    }
    async initiateDeployment(discordInteraction = null) {
        if (this.currentStatusState === APEX_STATUS_CODES.ESTABLISHED) return;
        this.forceTerminationSignal = false;
        this.currentStatusState = APEX_STATUS_CODES.INITIALIZING;
        const deploymentConfiguration = {
            host: this.record.targetEndpoint.host,
            port: parseInt(this.record.targetEndpoint.port) || APEX_SYSTEM_CONSTANTS.DEFAULT_BEDROCK_NETWORK_PORT,
            connectTimeout: APEX_SYSTEM_CONSTANTS.HANDSHAKE_TIMEOUT_MILLISECONDS,
            skipInitResurcePacks: true,
            version: this.record.deploymentProfile.targetProtocolVersion === "auto" ? undefined : this.record.deploymentProfile.targetProtocolVersion
        };
        if (this.record.protocolMode === "online") {
            deploymentConfiguration.authflow = ApexIdentityOrchestrator.createIdentityFlow(this.userUid);
            deploymentConfiguration.username = this.userUid;
        } else {
            deploymentConfiguration.username = this.record.deploymentProfile.customOfflineAlias || `APEX_${this.userUid.slice(0, 4)}`;
            deploymentConfiguration.offline = true;
        }
        try {
            this.bedrockClientInstance = bedrock.createClient(deploymentConfiguration);
            this.attachKernelListeners(discordInteraction);
            this.scheduledTasks.handshakeGuard = setTimeout(() => {
                if (this.currentStatusState !== APEX_STATUS_CODES.ESTABLISHED) {
                    this.executeShutdownSequence("Handshake Negotiation Timeout");
                }
            }, APEX_SYSTEM_CONSTANTS.HANDSHAKE_TIMEOUT_MILLISECONDS);
        } catch (initializationError) {
            this.executeShutdownSequence(initializationError.message);
        }
    }
    attachKernelListeners(interaction) {
        this.bedrockClientInstance.on("packet", () => {
            this.processedPacketCount++;
            ApexVault.runtimeCache.globalMetrics.totalPacketThroughput++;
        });
        this.bedrockClientInstance.on("spawn", () => {
            this.currentStatusState = APEX_STATUS_CODES.ESTABLISHED;
            this.deploymentEpoch = Date.now();
            clearTimeout(this.scheduledTasks.handshakeGuard);
            ApexVault.runtimeCache.globalMetrics.totalDeployments++;
            if (interaction) {
                interaction.editReply({
                    content: `✨ **DEPLOYMENT SUCCESSFUL:** <@${this.userUid}> kernel is now active at \`${this.record.targetEndpoint.host}\`.`,
                    embeds: [], components: []
                }).catch(() => {});
            }
            this.activateSimulationLoops();
        });
        this.bedrockClientInstance.on("error", (errorData) => {
            this.executeShutdownSequence(`Kernel Internal Error: ${errorData.message}`);
        });
        this.bedrockClientInstance.on("close", () => {
            this.executeShutdownSequence("Connection Terminated by Endpoint");
        });
    }
    activateSimulationLoops() {
        this.scheduledTasks.simulationInterval = setInterval(() => {
            if (this.currentStatusState === APEX_STATUS_CODES.ESTABLISHED) {
                ApexEvasionService.applyPositionJitter(this.bedrockClientInstance);
                if (Math.random() > 0.85) {
                    ApexEvasionService.triggerAnimationPulse(this.bedrockClientInstance);
                }
            }
        }, APEX_SYSTEM_CONSTANTS.AFK_SIMULATION_INTERVAL_MILLISECONDS);
    }
    executeShutdownSequence(terminationReason) {
        const wasPreviouslyActive = this.currentStatusState === APEX_STATUS_CODES.ESTABLISHED;
        this.currentStatusState = APEX_STATUS_CODES.TERMINATED;
        this.deconstructResources();
        if (!this.forceTerminationSignal && this.record.deploymentProfile.autoRecoveryEnabled) {
            this.currentStatusState = APEX_STATUS_CODES.RECOVERING;
            this.scheduledTasks.reconnectionTimeout = setTimeout(() => {
                this.initiateDeployment();
            }, APEX_SYSTEM_CONSTANTS.RECONNECTION_COOLDOWN_MILLISECONDS);
        }
    }
    deconstructResources() {
        if (this.scheduledTasks.simulationInterval) clearInterval(this.scheduledTasks.simulationInterval);
        if (this.scheduledTasks.handshakeGuard) clearTimeout(this.scheduledTasks.handshakeGuard);
        try {
            if (this.bedrockClientInstance) {
                this.bedrockClientInstance.close();
                this.bedrockClientInstance = null;
            }
        } catch (deconstructionError) {}
    }
    forceTerminateKernel(isManualAction = true) {
        this.forceTerminationSignal = isManualAction;
        if (isManualAction) {
            this.record.isCurrentlyActive = false;
            ApexVault.commitChanges();
        }
        this.deconstructResources();
        if (this.scheduledTasks.reconnectionTimeout) clearTimeout(this.scheduledTasks.reconnectionTimeout);
    }
}

class ApexOrchestratorRegistry {
    constructor() {
        this.activeSessionMap = new Map();
    }
    resolveSessionInstance(uid) {
        if (!this.activeSessionMap.has(uid)) {
            this.activeSessionMap.set(uid, new ApexSessionKernel(uid));
        }
        return this.activeSessionMap.get(uid);
    }
    broadcastEmergencyShutdown() {
        for (const session of this.activeSessionMap.values()) {
            session.forceTerminateKernel(true);
        }
    }
    aggregateGlobalState() {
        let onlineCount = 0;
        let recoveryCount = 0;
        let totalPackets = 0;
        for (const session of this.activeSessionMap.values()) {
            if (session.currentStatusState === APEX_STATUS_CODES.ESTABLISHED) {
                onlineCount++;
            } else if (session.currentStatusState === APEX_STATUS_CODES.RECOVERING) {
                recoveryCount++;
            }
            totalPackets += session.processedPacketCount;
        }
        return { onlineCount, recoveryCount, totalPackets };
    }
}

const ApexEngine = new ApexOrchestratorRegistry();

class ApexInterfaceRenderer {
    static generateUserDashboard(uid) {
        const userProfile = ApexVault.retrieveUserRecord(uid);
        const session = ApexEngine.resolveSessionInstance(uid);
        const statusDisplayMap = {
            [APEX_STATUS_CODES.IDLE]: "⚪ STANDBY",
            [APEX_STATUS_CODES.ESTABLISHED]: "🟢 DEPLOYED",
            [APEX_STATUS_CODES.RECOVERING]: "🟠 RECOVERING",
            [APEX_STATUS_CODES.TERMINATED]: "🔴 TERMINATED",
            [APEX_STATUS_CODES.INITIALIZING]: "🔵 INITIALIZING",
            [APEX_STATUS_CODES.NEGOTIATING]: "🔵 NEGOTIATING"
        };
        const dashboardEmbed = new EmbedBuilder()
            .setTitle(APEX_UI_DICTIONARY.DASHBOARD_HEADER)
            .setDescription(APEX_UI_DICTIONARY.DASHBOARD_SUBHEADER)
            .setColor(session.currentStatusState === APEX_STATUS_CODES.ESTABLISHED ? APEX_COLOR_PALETTE.PRIMARY_SUCCESS : APEX_COLOR_PALETTE.PRIMARY_NEUTRAL)
            .addFields(
                { name: `📡 ${APEX_UI_DICTIONARY.LABEL_STATE}`, value: `**Status:** ${statusDisplayMap[session.currentStatusState] || "⚪ STANDBY"}\n**Session Uptime:** ${session.currentStatusState === APEX_STATUS_CODES.ESTABLISHED ? Math.floor((Date.now() - session.deploymentEpoch) / 60000) + "m" : "0m"}\n**Ingress Traffic:** ${session.processedPacketCount} pkts`, inline: true },
                { name: `🌍 ${APEX_UI_DICTIONARY.LABEL_ENDPOINT}`, value: `**Host:** \`${userProfile.targetEndpoint.host || "Unset"}\`\n**Port:** \`${userProfile.targetEndpoint.port}\`\n**Protocol:** ${userProfile.protocolMode.toUpperCase()}`, inline: true },
                { name: `🛡️ ${APEX_UI_DICTIONARY.LABEL_IDENTITY}`, value: userProfile.linkedStatus ? "✅ IDENTITY SECURED" : "❌ IDENTITY UNVERIFIED", inline: true }
            )
            .setThumbnail("https://cdn-icons-png.flaticon.com/512/2620/2620573.png")
            .setFooter({ text: `Apex Kernel Rev ${APEX_IDENTIFIERS.VERSION_MAJOR}.${APEX_IDENTIFIERS.VERSION_MINOR}.${APEX_IDENTIFIERS.VERSION_PATCH}` });
        const primaryRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("apex_cmd_deploy").setLabel(APEX_UI_DICTIONARY.BTN_DEPLOY).setStyle(ButtonStyle.Success).setEmoji("🚀"),
            new ButtonBuilder().setCustomId("apex_cmd_halt").setLabel(APEX_UI_DICTIONARY.BTN_HALT).setStyle(ButtonStyle.Danger).setEmoji("🛑"),
            new ButtonBuilder().setCustomId("apex_cmd_config").setLabel(APEX_UI_DICTIONARY.BTN_CONFIG).setStyle(ButtonStyle.Secondary).setEmoji("⚙️")
        );
        const secondaryRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("apex_cmd_auth").setLabel(APEX_UI_DICTIONARY.BTN_AUTH).setStyle(ButtonStyle.Primary).setEmoji("🔐"),
            new ButtonBuilder().setCustomId("apex_cmd_sync").setLabel(APEX_UI_DICTIONARY.BTN_SYNC).setStyle(ButtonStyle.Secondary).setEmoji("🔄")
        );
        return { embeds: [dashboardEmbed], components: [primaryRow, secondaryRow] };
    }
    static generateAdminAnalytics() {
        const globalMetrics = ApexEngine.aggregateGlobalState();
        const systemMemoryUsage = process.memoryUsage();
        const analyticsEmbed = new EmbedBuilder()
            .setTitle(APEX_UI_DICTIONARY.OVERLORD_HEADER)
            .setDescription(APEX_UI_DICTIONARY.OVERLORD_SUBHEADER)
            .setColor(APEX_COLOR_PALETTE.PRIMARY_ACCENT)
            .addFields(
                { name: "📈 FLEET ANALYTICS", value: `**Deployed:** ${globalMetrics.onlineCount}\n**Recovery:** ${globalMetrics.recoveryCount}\n**Global Throughput:** ${globalMetrics.totalPackets} pkts`, inline: true },
                { name: "💻 HARDWARE METRICS", value: `**RSS RAM:** ${(systemMemoryUsage.rss / 1024 / 1024).toFixed(2)} MB\n**Kernel Platform:** ${os.platform()}\n**CPU Avg Load:** ${os.loadavg()[0].toFixed(2)}`, inline: true },
                { name: "📂 PERSISTENCE", value: `**Registered Identites:** ${Object.keys(ApexVault.runtimeCache.registry).length}\n**Lifetime Handshakes:** ${ApexVault.runtimeCache.globalMetrics.totalDeployments}`, inline: true }
            )
            .setTimestamp()
            .setFooter({ text: "Apex Enterprise Orchestration v6.0" });
        const controlRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("apex_adm_sync").setLabel("Force Global Sync").setStyle(ButtonStyle.Primary).setEmoji("🔃"),
            new ButtonBuilder().setCustomId("apex_adm_emergency").setLabel("Emergency Fleet Halt").setStyle(ButtonStyle.Danger).setEmoji("☢️")
        );
        return { embeds: [analyticsEmbed], components: [controlRow] };
    }
}

const ApexDiscordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User]
});

ApexDiscordClient.on(Events.InteractionCreate, async (interaction) => {
    const userUid = interaction.user.id;
    if (interaction.isChatInputCommand()) {
        if (interaction.guildId !== APEX_SYSTEM_CONSTANTS.DISCORD_GUILD_IDENTITY) return;
        if (interaction.commandName === "panel") {
            return interaction.reply(ApexInterfaceRenderer.generateUserDashboard(userUid));
        }
        if (interaction.commandName === "admin") {
            if (userUid !== APEX_SYSTEM_CONSTANTS.DISCORD_ADMINISTRATOR_IDENTITY) {
                return interaction.reply({ content: "Permission Level Insufficient for Administrative Access.", ephemeral: true });
            }
            return interaction.reply(ApexInterfaceRenderer.generateAdminAnalytics());
        }
    }
    if (interaction.isButton()) {
        const buttonId = interaction.customId;
        try {
            if (buttonId === "apex_cmd_sync") {
                return interaction.update(ApexInterfaceRenderer.generateUserDashboard(userUid));
            }
            if (buttonId === "apex_cmd_auth") {
                await interaction.deferReply({ ephemeral: true });
                await ApexIdentityOrchestrator.performIdentityChallenge(userUid, interaction);
                return;
            }
            if (buttonId === "apex_cmd_deploy") {
                await interaction.deferReply({ ephemeral: true });
                await ApexEngine.resolveSessionInstance(userUid).initiateDeployment(interaction);
                return;
            }
            if (buttonId === "apex_cmd_halt") {
                ApexEngine.resolveSessionInstance(userUid).forceTerminateKernel(true);
                return interaction.reply({ content: "Termination Signal Dispatched to Kernel.", ephemeral: true });
            }
            if (buttonId === "apex_cmd_config") {
                const userProfile = ApexVault.retrieveUserRecord(userUid);
                const configModal = new ModalBuilder().setCustomId("apex_mod_config").setTitle("DEPLOYMENT PARAMETERIZATION");
                configModal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("f_host").setLabel("Network Address").setStyle(TextInputStyle.Short).setValue(userProfile.targetEndpoint.host).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("f_port").setLabel("Network Port").setStyle(TextInputStyle.Short).setValue(userProfile.targetEndpoint.port)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("f_alias").setLabel("Identity Proxy Alias").setStyle(TextInputStyle.Short).setValue(userProfile.deploymentProfile.customOfflineAlias || "")),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("f_ver").setLabel("Protocol Specification").setStyle(TextInputStyle.Short).setValue(userProfile.deploymentProfile.targetProtocolVersion)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("f_mode").setLabel("Auth Mode (online/offline)").setStyle(TextInputStyle.Short).setValue(userProfile.protocolMode))
                );
                return interaction.showModal(configModal);
            }
            if (buttonId === "apex_adm_sync") {
                return interaction.update(ApexInterfaceRenderer.generateAdminAnalytics());
            }
            if (buttonId === "apex_adm_emergency") {
                ApexEngine.broadcastEmergencyShutdown();
                return interaction.reply({ content: "Global Fleet Termination Triggered Successfully.", ephemeral: true });
            }
        } catch (interactionError) {
            if (!interaction.replied && !interaction.deferred) {
                interaction.reply({ content: `Apex Kernel Interface Exception: ${interactionError.message}`, ephemeral: true }).catch(() => {});
            }
        }
    }
    if (interaction.isModalSubmit() && interaction.customId === "apex_mod_config") {
        const userProfile = ApexVault.retrieveUserRecord(userUid);
        userProfile.targetEndpoint.host = interaction.fields.getTextInputValue("f_host").trim();
        userProfile.targetEndpoint.port = interaction.fields.getTextInputValue("f_port").trim();
        userProfile.deploymentProfile.customOfflineAlias = interaction.fields.getTextInputValue("f_alias").trim();
        userProfile.deploymentProfile.targetProtocolVersion = interaction.fields.getTextInputValue("f_ver").trim() || "auto";
        userProfile.protocolMode = interaction.fields.getTextInputValue("f_mode").toLowerCase().includes("off") ? "offline" : "online";
        ApexVault.commitChanges();
        return interaction.reply({ content: "Kernel Deployment Parameters Synchronized.", ephemeral: true });
    }
});

ApexDiscordClient.once("ready", async () => {
    await ApexDiscordClient.application.commands.set([
        new SlashCommandBuilder().setName("panel").setDescription("Access individual Sentinel session controller"),
        new SlashCommandBuilder().setName("admin").setDescription("Access root system diagnostic dashboard")
    ]);
    const restorationQueue = Object.keys(ApexVault.runtimeCache.registry).filter(id => ApexVault.runtimeCache.registry[id].isCurrentlyActive);
    restorationQueue.forEach((id, index) => {
        setTimeout(() => {
            ApexEngine.resolveSessionInstance(id).initiateDeployment();
        }, index * APEX_SYSTEM_CONSTANTS.AUTO_BOOTSTRAP_DELAY_MILLISECONDS);
    });
});

process.on("unhandledRejection", (rejectionReason) => {
    console.error(`[FATAL] Unhandled Rejection: ${rejectionReason.stack}`);
});

process.on("uncaughtException", (uncaughtError) => {
    console.error(`[FATAL] Uncaught Exception: ${uncaughtError.stack}`);
});

ApexDiscordClient.login(APEX_SYSTEM_CONSTANTS.DISCORD_TOKEN);

