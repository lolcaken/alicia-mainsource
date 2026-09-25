const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const manage = b => b.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false);
const guildOnly = b => b.setDMPermission(false);

function loadLocalFeatures() {
  try {
    return require('../local-features');
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND' && String(error.message).includes('local-features')) return null;
    throw error;
  }
}

const localFeatures = loadLocalFeatures();

const track = new SlashCommandBuilder().setName('track').setDescription('Manage this server watchlist')
  .addSubcommand(s => s.setName('add').setDescription('Track a Roblox username').addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true).setAutocomplete(true)).addStringOption(o => o.setName('account').setDescription('Cookie account ID or label').setAutocomplete(true)))
  .addSubcommand(s => s.setName('remove').setDescription('Stop tracking').addStringOption(o => o.setName('username').setDescription('Tracked username').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('list').setDescription('List tracked users'))
  .addSubcommand(s => s.setName('pause').setDescription('Pause tracking').addStringOption(o => o.setName('username').setDescription('Tracked username').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('resume').setDescription('Resume tracking').addStringOption(o => o.setName('username').setDescription('Tracked username').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('account').setDescription('Attach a cookie account').addStringOption(o => o.setName('username').setDescription('Tracked username').setRequired(true).setAutocomplete(true)).addStringOption(o => o.setName('account').setDescription('Cookie account ID or label').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('alerts').setDescription('Toggle per-user alerts').addStringOption(o => o.setName('username').setDescription('Tracked username').setRequired(true).setAutocomplete(true)).addStringOption(o => o.setName('type').setDescription('Alert type').setRequired(true).addChoices({ name: 'Online', value: 'online' }, { name: 'Offline', value: 'offline' }, { name: 'Game Join', value: 'gameJoin' }, { name: 'Game Change', value: 'gameChange' }, { name: 'Game Leave', value: 'gameLeave' })).addBooleanOption(o => o.setName('enabled').setDescription('Enabled').setRequired(true)))
  .addSubcommand(s => s.setName('alerts-reset').setDescription('Restore server-default alerts for one user').addStringOption(o => o.setName('username').setDescription('Tracked username').setRequired(true).setAutocomplete(true)).addStringOption(o => o.setName('type').setDescription('Alert type; omit to reset all').addChoices({ name: 'Online', value: 'online' }, { name: 'Offline', value: 'offline' }, { name: 'Game Join', value: 'gameJoin' }, { name: 'Game Change', value: 'gameChange' }, { name: 'Game Leave', value: 'gameLeave' })))
  .addSubcommand(s => s.setName('tiktok').setDescription('Track a TikTok handle standalone, or link it to a tracked user (experimental)').addStringOption(o => o.setName('handle').setDescription('TikTok @handle without @').setRequired(true)).addStringOption(o => o.setName('username').setDescription('Optional: link to a tracked user').setAutocomplete(true)))
  .addSubcommand(s => s.setName('tiktok-remove').setDescription('Stop tracking a TikTok handle (experimental)').addStringOption(o => o.setName('handle').setDescription('TikTok @handle without @').setRequired(true)))
  .addSubcommand(s => s.setName('usernotify').setDescription("Route one user's alerts to a dedicated channel").addStringOption(o => o.setName('username').setDescription('Tracked username').setRequired(true).setAutocomplete(true)).addChannelOption(o => o.setName('channel').setDescription('Dedicated alert channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
  .addSubcommand(s => s.setName('usernotify-clear').setDescription("Return one user's alerts to the default channel").addStringOption(o => o.setName('username').setDescription('Tracked username').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('info').setDescription('Show tracker details').addStringOption(o => o.setName('username').setDescription('Tracked username').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('now').setDescription('Poll one tracked user now').addStringOption(o => o.setName('username').setDescription('Tracked username').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('search').setDescription('Search your watchlist').addStringOption(o => o.setName('query').setDescription('Partial username').setRequired(true)));

const cookie = new SlashCommandBuilder().setName('cookie').setDescription('Manage this server cookie accounts')
  .addSubcommand(s => s.setName('add').setDescription('Add a cookie account').addStringOption(o => o.setName('label').setDescription('Account label').setRequired(true)).addStringOption(o => o.setName('cookie').setDescription('ROBLOSECURITY value').setRequired(true)))
  .addSubcommand(s => s.setName('list').setDescription('List cookie accounts'))
  .addSubcommand(s => s.setName('test').setDescription('Test a cookie account').addStringOption(o => o.setName('account').setDescription('Cookie account ID or label').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('toggle').setDescription('Enable or disable an account').addStringOption(o => o.setName('account').setDescription('Cookie account ID or label').setRequired(true).setAutocomplete(true)).addBooleanOption(o => o.setName('enabled').setDescription('Enabled').setRequired(true)))
  .addSubcommand(s => s.setName('rename').setDescription('Rename an account').addStringOption(o => o.setName('account').setDescription('Cookie account ID or label').setRequired(true).setAutocomplete(true)).addStringOption(o => o.setName('name').setDescription('New name').setRequired(true)))
  .addSubcommand(s => s.setName('replace').setDescription('Replace a cookie').addStringOption(o => o.setName('account').setDescription('Cookie account ID or label').setRequired(true).setAutocomplete(true)).addStringOption(o => o.setName('cookie').setDescription('New ROBLOSECURITY value').setRequired(true)))
  .addSubcommand(s => s.setName('remove').setDescription('Remove an account').addStringOption(o => o.setName('account').setDescription('Cookie account ID or label').setRequired(true).setAutocomplete(true)));

const notify = new SlashCommandBuilder().setName('notify').setDescription('Configure server notifications')
  .addSubcommand(s => s.setName('channel').setDescription('Set alert channel').addChannelOption(o => o.setName('channel').setDescription('Text channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
  .addSubcommand(s => s.setName('user-channel-clear').setDescription('Return one user to the default alert channel').addStringOption(o => o.setName('username').setDescription('Tracked username').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('test').setDescription('Send a test notification').addStringOption(o => o.setName('username').setDescription('Tracked username to preview (optional)').setRequired(false).setAutocomplete(true)))
  .addSubcommand(s => s.setName('clear').setDescription('Clear alert channel'))
  .addSubcommand(s => s.setName('status').setDescription('Show alert channel status'));

const tracker = new SlashCommandBuilder().setName('tracker').setDescription('Live tracker diagnostics')
  .addSubcommand(s => s.setName('inspect').setDescription('Show detailed live tracker status').addStringOption(o => o.setName('username').setDescription('Tracked username').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('refresh').setDescription('Force an immediate refresh for one user').addStringOption(o => o.setName('username').setDescription('Tracked username').setRequired(true).setAutocomplete(true)));

const settings = new SlashCommandBuilder().setName('settings').setDescription('View or change every Alicia setting')
  .addIntegerOption(o => o.setName('interval').setDescription('Poll interval in milliseconds').setMinValue(5000).setMaxValue(300000))
  .addStringOption(o => o.setName('alert_type').setDescription('Server alert type').addChoices({ name: 'Online', value: 'online' }, { name: 'Offline', value: 'offline' }, { name: 'Game Join', value: 'gameJoin' }, { name: 'Game Change', value: 'gameChange' }, { name: 'Game Leave', value: 'gameLeave' }))
  .addStringOption(o => o.setName('alert_value').setDescription('Enable or disable the selected alert type').addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }))
  .addBooleanOption(o => o.setName('game_only').setDescription('Only send game activity alerts'))
  .addBooleanOption(o => o.setName('server_info').setDescription('Show server uptime and region'))
  .addBooleanOption(o => o.setName('ally_ping').setDescription('Enable Ally burst ping'))
  .addBooleanOption(o => o.setName('tiktok').setDescription('Enable TikTok LIVE tracking'))
  .addChannelOption(o => o.setName('tiktok_channel').setDescription('Dedicated TikTok alert channel').addChannelTypes(ChannelType.GuildText))
  .addBooleanOption(o => o.setName('quiet').setDescription('Mute all alerts'))
  .addIntegerOption(o => o.setName('quiet_minutes').setDescription('Automatically resume after N minutes').setMinValue(1).setMaxValue(10080))
  .addBooleanOption(o => o.setName('compact_links').setDescription('Show compact links in embeds'));


const commands = [
  manage(new SlashCommandBuilder().setName('setup').setDescription('Initialize Alicia Tracker for this server')),
  guildOnly(new SlashCommandBuilder().setName('help').setDescription('Show Alicia Tracker commands')),
  guildOnly(new SlashCommandBuilder().setName('ping').setDescription('Check bot and gateway latency')),
  guildOnly(new SlashCommandBuilder().setName('uptime').setDescription('Show bot uptime')),
  guildOnly(new SlashCommandBuilder().setName('about').setDescription('Show bot information')),
  guildOnly(new SlashCommandBuilder().setName('health').setDescription('Show tracker health for this server')),
  guildOnly(new SlashCommandBuilder().setName('status').setDescription('Check a tracked Roblox user').addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true).setAutocomplete(true))),
  guildOnly(new SlashCommandBuilder().setName('board').setDescription('Show one live status line for every tracked user').addStringOption(o => o.setName('view').setDescription('Filter the board').addChoices({ name: 'All', value: 'all' }, { name: 'In game', value: 'ingame' }, { name: 'Online', value: 'online' }, { name: 'Offline', value: 'offline' }, { name: 'Paused', value: 'paused' }, { name: 'Issues', value: 'issues' }))),
  manage(track),
  manage(cookie),
  manage(notify),
  manage(tracker),
  manage(settings),
  manage(new SlashCommandBuilder().setName('poll').setDescription('Run a manual poll').addSubcommand(s => s.setName('now').setDescription('Poll now'))),
  guildOnly(new SlashCommandBuilder().setName('stats').setDescription('Show tracker statistics').addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true).setAutocomplete(true))),
  guildOnly(new SlashCommandBuilder().setName('history').setDescription('Show recent history').addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true).setAutocomplete(true)).addIntegerOption(o => o.setName('limit').setDescription('1-20').setMinValue(1).setMaxValue(20))),
  guildOnly(new SlashCommandBuilder().setName('export').setDescription('Export full backup (users, accounts, settings, history) as JSON')),
  guildOnly(new SlashCommandBuilder().setName('import').setDescription('Restore from an exported backup JSON').addAttachmentOption(o => o.setName('file').setDescription('alicia-tracker-export.json backup').setRequired(true))),
  guildOnly(new SlashCommandBuilder().setName('activity').setDescription('Show recent activity').addIntegerOption(o => o.setName('limit').setDescription('1-20').setMinValue(1).setMaxValue(20))),
  guildOnly(new SlashCommandBuilder().setName('together').setDescription('See which tracked users are in the same game right now')),
  guildOnly(new SlashCommandBuilder().setName('topgames').setDescription('Show a tracked user\'s most-played games').addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true).setAutocomplete(true))),
  ...(localFeatures?.commands || []),
];
module.exports = { commands, loadLocalFeatures };
