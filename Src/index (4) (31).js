import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from 'discord.js';

const token = process.env.DISCORD_BOT_TOKEN;

if (!token) {
  console.error('Missing DISCORD_BOT_TOKEN environment variable.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.GuildMember],
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build the new nickname for a member.
 * Format: <prefix>  <DISPLAY NAME or Display Name>
 * Discord nickname max = 32 characters.
 * If the result exceeds 32 chars we truncate the display name portion.
 */
function buildNickname(prefix, displayName, bold) {
  const name = bold ? displayName.toUpperCase() : displayName;
  const full = `${prefix}  ${name}`;
  if (full.length <= 32) return full;

  // Truncate display name to fit within 32 chars
  const overhead = `${prefix}  `.length;
  const allowedNameLen = 32 - overhead;
  if (allowedNameLen <= 0) return prefix.slice(0, 32);
  return `${prefix}  ${name.slice(0, allowedNameLen)}`;
}

/**
 * Safe edit-reply wrapper — interaction tokens expire after 15 minutes.
 * After that, we just silently continue processing.
 */
async function tryEditReply(interaction, content) {
  try {
    await interaction.editReply({ content });
  } catch {
    // Token expired — that's fine, we keep processing silently
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Visual progress bar — 20 blocks wide */
function progressBar(current, total, width = 20) {
  const filled = Math.round((current / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Human-readable duration from seconds */
function formatDuration(sec) {
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${m}m`;
  }
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  }
  return `${sec}s`;
}

// ─── Core rename logic ───────────────────────────────────────────────────────

/**
 * Renames all eligible members one by one.
 *
 * Rate-limit strategy for 10k+ servers:
 *  1. discord.js has a built-in REST bucket queue — it automatically waits
 *     when a 429 is received and retries with the correct Retry-After delay.
 *  2. We process members SEQUENTIALLY so we never blast thousands of requests
 *     into the queue at once (which would consume gigabytes of memory).
 *  3. A 600 ms pause between each request keeps us under Discord's
 *     ~10 req/10 s per-guild bucket. discord.js slows down further if a 429
 *     arrives.
 *
 * Progress-message rate limit:
 *  Discord allows ~5 edits per 5 s on a message. We throttle edits to once
 *  per 1.5 s so the live name display never causes a secondary rate limit.
 *
 * For reference: 10 000 members × 600 ms ≈ 1 h 40 min. The interaction
 * token expires after 15 min (~1 500 members), after which progress edits
 * silently stop but the rename loop continues uninterrupted.
 */
async function renameAllMembers(interaction, prefix, bold) {
  const guild = interaction.guild;

  await tryEditReply(interaction, '⏳ Fetching all members… (this may take a moment for large servers)');

  // Fetch every member — requires GUILD_MEMBERS privileged intent
  let allMembers;
  try {
    allMembers = await guild.members.fetch();
  } catch (err) {
    await tryEditReply(
      interaction,
      `❌ Failed to fetch members: ${err.message}\n\nMake sure the bot has the **Server Members Intent** enabled in the Discord Developer Portal.`
    );
    return;
  }

  // Filter: skip bots and the server owner (cannot be renamed by anyone)
  const eligible = allMembers.filter(m => !m.user.bot && m.id !== guild.ownerId);
  const total = eligible.size;

  if (total === 0) {
    await tryEditReply(interaction, '⚠️ No eligible members found (bots and the server owner are always skipped).');
    return;
  }

  let processed = 0;
  let renamed   = 0;
  let skipped   = 0;
  let failed    = 0;
  let lastEditAt = 0;           // timestamp of last progress edit
  const EDIT_THROTTLE_MS = 1500; // minimum gap between edits (Discord ~5/5 s limit)
  const startTime = Date.now();
  let currentName = '';         // name being processed right now

  /**
   * Build and send the live progress embed.
   * force = true sends even if inside the throttle window (used for the final message).
   */
  async function sendProgress(force = false) {
    const now = Date.now();
    if (!force && now - lastEditAt < EDIT_THROTTLE_MS) return;
    lastEditAt = now;

    const elapsed  = Math.floor((now - startTime) / 1000);
    const pct      = Math.round((processed / total) * 100);
    const etaSec   = processed > 0
      ? Math.round(((now - startTime) / processed) * (total - processed) / 1000)
      : null;
    const etaStr   = etaSec !== null ? `~${formatDuration(etaSec)}` : 'calculating…';
    const bar      = progressBar(processed, total);
    const speed    = processed > 0
      ? (processed / ((now - startTime) / 1000)).toFixed(2)
      : '0.00';

    await tryEditReply(
      interaction,
      [
        `## ⏳ Renaming members…`,
        `\`${bar}\` **${pct}%**`,
        ``,
        `**Progress:**  ${processed.toLocaleString()} / ${total.toLocaleString()} members`,
        `**Currently:** \`${currentName || '…'}\``,
        ``,
        `**Elapsed:**   ${formatDuration(elapsed)}`,
        `**ETA:**       ${etaStr}`,
        `**Speed:**     ${speed} members/s`,
        ``,
        `✅ Renamed: **${renamed.toLocaleString()}**  •  ⏭ Skipped: **${skipped.toLocaleString()}**  •  ❌ Failed: **${failed.toLocaleString()}**`,
        ``,
        `_Skipped = already correct.  Failed = higher role or bot can't manage that member._`,
      ].join('\n')
    );
  }

  await sendProgress(true);

  for (const [, member] of eligible) {
    const displayName = member.displayName;
    const newNick     = buildNickname(prefix, displayName, bold);
    currentName       = `${displayName}  →  ${newNick}`;

    if (member.nickname === newNick) {
      skipped++;
      processed++;
    } else {
      try {
        await member.setNickname(newNick, `/rename-all-members by ${interaction.user.tag}`);
        renamed++;
        processed++;
      } catch {
        failed++;
        processed++;
      }
    }

    // Throttle rename requests: 600 ms keeps us under the per-guild bucket
    await sleep(600);

    // Update progress message (throttled to EDIT_THROTTLE_MS)
    await sendProgress();
  }

  // Final summary — always send regardless of throttle
  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  await tryEditReply(
    interaction,
    [
      `## ✅ Done!`,
      `Processed **${total.toLocaleString()}** members in **${totalSec}s**.`,
      ``,
      `| Result | Count |`,
      `|--------|-------|`,
      `| ✅ Renamed | **${renamed.toLocaleString()}** |`,
      `| ⏭ Already correct (skipped) | **${skipped.toLocaleString()}** |`,
      `| ❌ Could not rename | **${failed.toLocaleString()}** |`,
      ``,
      `**Format applied:** \`${buildNickname(prefix, 'DisplayName', bold)}\``,
    ].join('\n')
  );
}

// ─── Interaction handler ─────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'rename-all-members') return;

  // Defer immediately — processing takes > 3 s for any real server
  await interaction.deferReply({ ephemeral: false });

  const prefix = interaction.options.getString('prefix', true).trim();
  const bold   = interaction.options.getBoolean('bold', true);

  // Validate prefix length so the final nickname can always hold at least 1 char of name
  if (prefix.length > 28) {
    await interaction.editReply('❌ The prefix is too long. Please keep it under 28 characters.');
    return;
  }

  await renameAllMembers(interaction, prefix, bold);
});

// ─── Ready ───────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, c => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  console.log(`   Serving ${c.guilds.cache.size} guild(s)`);
});

client.login(token);
