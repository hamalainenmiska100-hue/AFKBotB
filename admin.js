const { 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    StringSelectMenuBuilder 
} = require("discord.js");

// --- ADMIN ASETUKSET ---
// Lisää oma Discord User ID:si tähän listaan (esim. ["123456789012345678"])
const ADMIN_IDS = ["YOUR_DISCORD_ID_HERE"];

/**
 * Luo hallintapaneelin Embed-viestin, joka sisältää tilastot ja listan aktiivisista boteista.
 */
function buildAdminEmbed(users, sessions) {
    const activeSessions = sessions.size;
    const totalUsersInDb = Object.keys(users).length;
    
    let activeBotsText = "";
    const activeUids = Array.from(sessions.keys());
    
    if (activeUids.length === 0) {
        activeBotsText = "No active bots currently.";
    } else {
        activeUids.forEach(uid => {
            const u = users[uid];
            const s = sessions.get(uid);
            const status = s.connected ? "🟢 Online" : "🟡 Connecting/Reconnecting";
            const ip = u.server?.ip || "Unknown";
            const port = u.server?.port || "19132";
            
            // Listataan käyttäjä, IP, portti ja tila
            activeBotsText += `👤 <@${uid}> (\`${uid}\`)\n📍 \`${ip}:${port}\` | ${status}\n\n`;
        });
    }

    return new EmbedBuilder()
        .setTitle("🛡️ AFKBot Admin Control Panel")
        .setDescription("Real-time monitoring and management of all AFK sessions.")
        .setColor("#ff0000")
        .addFields(
            { name: "📊 Global Statistics", value: `Total users in database: \`${totalUsersInDb}\`\nCurrently active sessions: \`${activeSessions}\``, inline: false },
            { name: "🤖 Active Bots List", value: activeBotsText || "None", inline: false }
        )
        .setTimestamp()
        .setFooter({ text: "Panel updates automatically every 30 seconds" });
}

/**
 * Luo hallintapaneelin painikkeet ja käyttäjävalikon.
 */
function buildAdminComponents(sessions) {
    const rows = [];

    // Toimintopainikkeet: Päivitys ja Force Stop All
    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("admin_refresh")
            .setLabel("🔄 Refresh Now")
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId("admin_stop_all")
            .setLabel("☢️ Force Stop All")
            .setStyle(ButtonStyle.Danger)
    );
    rows.push(buttonRow);

    // Valikko yksittäisen käyttäjän botin pysäyttämiseen
    if (sessions.size > 0) {
        const options = Array.from(sessions.keys()).map(uid => {
            const s = sessions.get(uid);
            return {
                label: `Stop bot for user ${uid}`,
                value: uid,
                description: `Server: ${s.client?.options?.host || "unknown"}`
            };
        });

        // Discord sallii max 25 vaihtoehtoa alasvetovalikkoon
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId("admin_stop_user")
            .setPlaceholder("Select a specific bot to terminate")
            .addOptions(options.slice(0, 25));

        rows.push(new ActionRowBuilder().addComponents(selectMenu));
    }

    return rows;
}

/**
 * Käsittelee /admin komennon ja aloittaa automaattisen päivityssyklin.
 */
async function handleAdminCommand(interaction) {
    // Tarkistetaan onko käyttäjä admin
    if (!ADMIN_IDS.includes(interaction.user.id)) {
        return interaction.reply({ content: "Access denied. You are not authorized to use admin tools. ⛔", ephemeral: true });
    }

    // Haetaan nykyinen tila pääkoodista (index.js)
    const main = require("./index.js");

    // Lähetetään paneeli (ephemeral: false, jotta se pysyy kanavalla)
    await interaction.reply({
        embeds: [buildAdminEmbed(main.users, main.sessions)],
        components: buildAdminComponents(main.sessions),
        ephemeral: false
    });

    // Asetetaan automaattinen päivitys 30 sekunnin välein
    const updateInterval = setInterval(async () => {
        try {
            const currentData = require("./index.js");
            await interaction.editReply({
                embeds: [buildAdminEmbed(currentData.users, currentData.sessions)],
                components: buildAdminComponents(currentData.sessions)
            });
        } catch (error) {
            // Jos viesti on poistettu tai botti ei saa yhteyttä, lopetetaan päivitys
            clearInterval(updateInterval);
        }
    }, 30000);
}

/**
 * Käsittelee admin-paneelin nappien painallukset ja valinnat.
 */
async function handleAdminInteractions(interaction) {
    // Turvatarkistus: Vain adminit voivat käyttää nappeja
    if (!ADMIN_IDS.includes(interaction.user.id)) {
        return interaction.reply({ content: "You cannot use these controls. ⛔", ephemeral: true });
    }

    const main = require("./index.js");
    const { users, sessions, client, stopSession } = main;

    // Pakotettu päivitys
    if (interaction.customId === "admin_refresh") {
        return interaction.update({
            embeds: [buildAdminEmbed(users, sessions)],
            components: buildAdminComponents(sessions)
        });
    }

    // Pysäytä kaikki botit
    if (interaction.customId === "admin_stop_all") {
        const activeUids = Array.from(sessions.keys());
        for (const uid of activeUids) {
            await stopAndNotify(uid, client, stopSession);
        }
        return interaction.update({
            embeds: [buildAdminEmbed(users, sessions)],
            components: buildAdminComponents(sessions)
        });
    }

    // Pysäytä tietty botti valikon kautta
    if (interaction.customId === "admin_stop_user") {
        const targetUid = interaction.values[0];
        await stopAndNotify(targetUid, client, stopSession);
        
        return interaction.update({
            embeds: [buildAdminEmbed(users, sessions)],
            components: buildAdminComponents(sessions)
        });
    }
}

/**
 * Apufunktio botin pysäyttämiseen ja DM-viestin lähettämiseen.
 */
async function stopAndNotify(uid, client, stopSession) {
    // Pysäytetään sessio main-tiedoston funktiolla
    stopSession(uid);

    try {
        // Yritetään hakea käyttäjä ja lähettää DM
        const user = await client.users.fetch(uid);
        if (user) {
            await user.send("Your bot has been stopped by the owner ⚠️").catch(() => {
                console.log(`Could not send DM to user ${uid} (DMs might be closed).`);
            });
        }
    } catch (e) {
        console.error(`Error notifying user ${uid}:`, e.message);
    }
}

module.exports = { 
    handleAdminCommand, 
    handleAdminInteractions 
};

