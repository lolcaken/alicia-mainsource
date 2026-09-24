const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const manage = b => b.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false);
const guildOnly = b => b.setDMPermission(false);

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

const settings = new SlashCommandBuilder().setName('settings').setDescription('Configure this server')
  .addSubcommand(s => s.setName('interval').setDescription('Set poll interval').addIntegerOption(o => o.setName('ms').setDescription('Minimum 5000ms').setMinValue(5000).setMaxValue(300000).setRequired(true)))
  .addSubcommand(s => s.setName('notifications').setDescription('Toggle alert types for this server').addStringOption(o => o.setName('type').setDescription('Notification type').addChoices({ name: 'Online', value: 'online' }, { name: 'Offline', value: 'offline' }, { name: 'Game Join', value: 'gameJoin' }, { name: 'Game Change', value: 'gameChange' }, { name: 'Game Leave', value: 'gameLeave' })).addBooleanOption(o => o.setName('enabled').setDescription('Enabled (omit to show current)')))
  .addSubcommand(s => s.setName('show').setDescription('Show settings'))
  .addSubcommand(s => s.setName('toggle').setDescription('Turn any feature toggle on/off').addStringOption(o => o.setName('name').setDescription('Which toggle').setRequired(true).addChoices({ name: 'Ally burst ping', value: 'allyping' }, { name: 'Game-only mode', value: 'gameonly' }, { name: 'Server uptime + region', value: 'serverinfo' }, { name: 'TikTok LIVE tracking', value: 'tiktok' }, { name: 'Quiet mode', value: 'quiet' }, { name: 'Compact links', value: 'compactlinks' })).addStringOption(o => o.setName('enabled').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })))


const commands = [
  manage(new SlashCommandBuilder().setName('setup').setDescription('Initialize Alicia Tracker for this server')),
  guildOnly(new SlashCommandBuilder().setName('help').setDescription('Show Alicia Tracker commands')),
  guildOnly(new SlashCommandBuilder().setName('ping').setDescription('Check bot latency + manage server toggles')
  .addSubcommand(s => s.setName('latency').setDescription('Measure bot and gateway latency'))
  .addSubcommand(s => s.setName('ally').setDescription('Toggle @everyone burst when Ally is the only tracked user in-game').addBooleanOption(o => o.setName('enabled').setDescription('On/off').setRequired(true)))
  .addSubcommand(s => s.setName('gameonly').setDescription('Only send game join/change/leave alerts; silence online/offline').addBooleanOption(o => o.setName('enabled').setDescription('On/off').setRequired(true)))
  .addSubcommand(s => s.setName('serverinfo').setDescription('Show server uptime/region on game join').addBooleanOption(o => o.setName('enabled').setDescription('On/off').setRequired(true)))
  .addSubcommand(s => s.setName('tiktok').setDescription('Toggle TikTok LIVE tracking (experimental)').addStringOption(o => o.setName('enabled').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })))
  .addSubcommand(s => s.setName('tiktok-channel').setDescription('Set a dedicated channel for TikTok LIVE alerts').addChannelOption(o => o.setName('channel').setDescription('Dedicated TikTok channel').setRequired(true)))
  .addSubcommand(s => s.setName('tiktok-channel-clear').setDescription('Clear the dedicated TikTok LIVE channel'))
  .addSubcommand(s => s.setName('quiet').setDescription('Mute all alerts (timed or until turned off)').addStringOption(o => o.setName('enabled').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })).addIntegerOption(o => o.setName('minutes').setDescription('Optional: auto-resume after N minutes').setMinValue(1).setMaxValue(1440)))
  .addSubcommand(s => s.setName('compact-links').setDescription('Show clickable game/profile links in status embeds').addBooleanOption(o => o.setName('enabled').setDescription('On/off').setRequired(true)))),
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
];
module.exports = { commands };
