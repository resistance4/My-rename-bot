import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_APPLICATION_ID;

if (!token || !clientId) {
  console.error('Missing DISCORD_BOT_TOKEN or DISCORD_APPLICATION_ID environment variables.');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('rename-all-members')
    .setDescription('Add a prefix to every member\'s display name, optionally in bold capitals')
    .addStringOption(option =>
      option
        .setName('prefix')
        .setDescription('The prefix to place before each member\'s display name (e.g. 樂)')
        .setRequired(true)
    )
    .addBooleanOption(option =>
      option
        .setName('bold')
        .setDescription('Convert display names to BOLD CAPITALS')
        .setRequired(true)
    )
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('Registering slash commands globally...');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('✅ Slash commands registered successfully.');
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
})();
