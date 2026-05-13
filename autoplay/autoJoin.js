/**
 * autoJoin.js
 * Handles auto-joining a specific voice channel on startup,
 * loading + shuffling the BLACKPINK Spotify playlist via Lavalink,
 * and a watchdog that re-joins + undeafens every 30 seconds if needed.
 */

const { ActivityType } = require('discord.js');
const colors = require('../UI/colors/colors');
const { requesters: sharedRequesters } = require('../requesters');

// ─── Target IDs ────────────────────────────────────────────────────────────────
const TARGET_GUILD_ID   = '1091967599442669581';
const TARGET_VOICE_ID   = '1504018199547478086';

// ─── Spotify playlist ──────────────────────────────────────────────────────────
// The full playlist URL: https://open.spotify.com/playlist/5Ua2YB4gOi05BVZgu6cvll
const SPOTIFY_PLAYLIST_URL = 'https://open.spotify.com/playlist/5Ua2YB4gOi05BVZgu6cvll';

// Fallback YT search queries used only if Spotify resolve fails entirely
const FALLBACK_QUERIES = [
    'BLACKPINK Pink Venom',
    'BLACKPINK Shut Down',
    'BLACKPINK How You Like That',
    'BLACKPINK DDU-DU DDU-DU',
    'BLACKPINK Lovesick Girls',
    'BLACKPINK Kill This Love',
    'BLACKPINK As If It\'s Your Last',
    'JENNIE SOLO',
    'JENNIE You & Me',
    'JENNIE Solo Concept Trailer',
    'LISA LALISA',
    'LISA MONEY',
    'LISA ROCKSTAR',
    'JISOO FLOWER',
    'JISOO DOMINO',
    'ROSÉ On The Ground',
    'ROSÉ Gone',
    'ROSÉ APT',
    'ROSÉ Number One Girl',
    'BLACKPINK Pretty Savage',
];

// Requester label shown in the now-playing card
const REQUESTER_LABEL = '🎀 Auto-DJ • BLACKPINK';

let watchdogInterval = null;
let isLoading = false;

/**
 * Fisher-Yates shuffle (in-place)
 */
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/**
 * Resolve the Spotify playlist through Riffy/Lavalink.
 * Returns an array of track objects (riffy Track), shuffled.
 */
async function resolvePlaylist(client) {
    try {
        const result = await client.riffy.resolve({
            query: SPOTIFY_PLAYLIST_URL,
            requester: REQUESTER_LABEL,
        });

        if (result && result.tracks && result.tracks.length > 0) {
            console.log(`${colors.cyan}[ AUTO-DJ ]${colors.reset} ${colors.green}Resolved ${result.tracks.length} tracks from Spotify playlist.${colors.reset}`);
            return shuffle([...result.tracks]);
        }
    } catch (err) {
        console.warn(`${colors.cyan}[ AUTO-DJ ]${colors.reset} ${colors.yellow}Spotify resolve failed (${err.message}), falling back to YT search.${colors.reset}`);
    }

    // Fallback: resolve individual YT queries
    const tracks = [];
    const shuffledQueries = shuffle([...FALLBACK_QUERIES]);
    for (const q of shuffledQueries) {
        try {
            const r = await client.riffy.resolve({ query: q, requester: REQUESTER_LABEL });
            if (r && r.tracks && r.tracks[0]) {
                tracks.push(r.tracks[0]);
            }
        } catch (_) { /* skip */ }
    }
    console.log(`${colors.cyan}[ AUTO-DJ ]${colors.reset} ${colors.yellow}Fallback: resolved ${tracks.length} tracks via YT search.${colors.reset}`);
    return tracks;
}

/**
 * Tag every track with the auto-DJ requester so the now-playing card shows it.
 */
function tagTracks(tracks, requesters) {
    for (const t of tracks) {
        if (t.info?.uri) {
            requesters.set(t.info.uri, REQUESTER_LABEL);
        }
    }
}

/**
 * Create (or fetch) the Lavalink player, connect to voice, load + shuffle
 * the full playlist into the queue, then start playback.
 */
async function startAutoPlay(client) {
    if (isLoading) return;
    isLoading = true;

    try {
        // Guard: riffy must be initialised
        if (!client.riffy) {
            console.warn(`${colors.cyan}[ AUTO-DJ ]${colors.reset} ${colors.yellow}client.riffy not ready yet – will retry via watchdog.${colors.reset}`);
            return;
        }

        const guild = client.guilds.cache.get(TARGET_GUILD_ID);
        if (!guild) {
            console.error(`${colors.cyan}[ AUTO-DJ ]${colors.reset} ${colors.red}Guild ${TARGET_GUILD_ID} not found – is the bot a member?${colors.reset}`);
            return;
        }

        const voiceChannel = guild.channels.cache.get(TARGET_VOICE_ID);
        if (!voiceChannel) {
            console.error(`${colors.cyan}[ AUTO-DJ ]${colors.reset} ${colors.red}Voice channel ${TARGET_VOICE_ID} not found.${colors.reset}`);
            return;
        }

        // Text channel locked to the target voice channel — embeds are suppressed
        // for this guild in player.js anyway, but we set it correctly for any
        // transient error messages Riffy might still send internally.
        const textChannel = { id: TARGET_VOICE_ID };

        // Ensure a Lavalink node is ready
        if (client.lavalinkManager) {
            await client.lavalinkManager.ensureNodeAvailable().catch(() => {});
        }

        // Reuse existing live player, or destroy a stale one and create fresh
        let player = client.riffy.players.get(TARGET_GUILD_ID);
        if (player && player.destroyed) {
            client.riffy.players.delete(TARGET_GUILD_ID);
            player = null;
        }

        if (!player) {
            // Riffy uses createConnection(), same as the /play command
            player = client.riffy.createConnection({
                guildId:      TARGET_GUILD_ID,
                voiceChannel: TARGET_VOICE_ID,
                textChannel:  textChannel?.id || TARGET_VOICE_ID,
                deaf:         true,
                mute:         false,
            });
        }

        if (!player) {
            console.error(`${colors.cyan}[ AUTO-DJ ]${colors.reset} ${colors.red}createConnection returned undefined – Lavalink node may not be connected yet.${colors.reset}`);
            return;
        }

        // Small delay to let Discord voice state settle if we just connected
        if (!player.connected) {
            await new Promise((r) => setTimeout(r, 1500));
        }

        // Undeafen / unmute self if needed (non-fatal)
        try {
            const me = guild.members.me;
            if (me?.voice?.deaf || me?.voice?.selfDeaf) await me.voice.setDeaf(false).catch(() => {});
            if (me?.voice?.mute)                        await me.voice.setMute(false).catch(() => {});
        } catch (_) {}

        // Already playing with tracks queued – nothing to do
        if (player.playing && player.queue.length > 0) return;

        console.log(`${colors.cyan}[ AUTO-DJ ]${colors.reset} ${colors.yellow}Loading BLACKPINK playlist…${colors.reset}`);
        const tracks = await resolvePlaylist(client);

        if (!tracks.length) {
            console.error(`${colors.cyan}[ AUTO-DJ ]${colors.reset} ${colors.red}No tracks resolved – giving up.${colors.reset}`);
            return;
        }

        tagTracks(tracks, sharedRequesters);

        // Loop the queue so it plays forever
        player.setLoop('queue');

        // Load all shuffled tracks into the queue
        player.queue.clear();
        for (const track of tracks) {
            player.queue.add(track);
        }

        console.log(`${colors.cyan}[ AUTO-DJ ]${colors.reset} ${colors.green}${tracks.length} tracks queued (shuffled). Starting playback…${colors.reset}`);

        if (!player.playing) {
            player.play();
        }

    } catch (err) {
        console.error(`${colors.cyan}[ AUTO-DJ ]${colors.reset} ${colors.red}startAutoPlay error: ${err.message}${colors.reset}`);
    } finally {
        isLoading = false;
    }
}

/**
 * Watchdog: every 30 s check that the bot is still in the voice channel,
 * not muted/deafened, and that the player is active. Re-join + restart if not.
 */
function startWatchdog(client) {
    if (watchdogInterval) return; // already running

    watchdogInterval = setInterval(async () => {
        try {
            const guild = client.guilds.cache.get(TARGET_GUILD_ID);
            if (!guild) return;

            const me = guild.members.me;
            const inCorrectChannel = me?.voice?.channelId === TARGET_VOICE_ID;
            const player           = client.riffy?.players?.get(TARGET_GUILD_ID);
            const playerAlive      = player && !player.destroyed && (player.playing || player.paused || player.queue.length > 0);

            // Fix mute/deafen silently
            if (inCorrectChannel && me) {
                if (me.voice.serverMute)  await me.voice.setMute(false).catch(() => {});
                if (me.voice.serverDeaf)  await me.voice.setDeaf(false).catch(() => {});
            }

            if (!inCorrectChannel || !playerAlive) {
                console.log(`${colors.cyan}[ AUTO-DJ ]${colors.reset} ${colors.yellow}Watchdog: re-joining voice channel and restarting playback.${colors.reset}`);
                await startAutoPlay(client);
            }
        } catch (err) {
            console.warn(`${colors.cyan}[ AUTO-DJ ]${colors.reset} ${colors.yellow}Watchdog error: ${err.message}${colors.reset}`);
        }
    }, 30_000);
}

/**
 * Entry point – called once from clientReady after Lavalink is ready.
 */
async function initAutoJoin(client) {
    // Wait a few seconds for nodes to fully connect
    await new Promise((r) => setTimeout(r, 5000));

    console.log(`${colors.cyan}[ AUTO-DJ ]${colors.reset} ${colors.green}Initialising auto-join for guild ${TARGET_GUILD_ID} / channel ${TARGET_VOICE_ID}${colors.reset}`);

    await startAutoPlay(client);
    startWatchdog(client);
}

module.exports = { initAutoJoin, TARGET_GUILD_ID, TARGET_VOICE_ID };
