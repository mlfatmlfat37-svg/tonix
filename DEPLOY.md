# TONIX V7

Virtual-credit Telegram Mini App. No real TON transactions.

## Included
- 500 virtual TON for a new player, once.
- Free Gift every 8 hours: 10, 20, 35, 50, 75, 100, 250, 350 or 500 TON.
- Referral reward: 50 TON per first-time referred player.
- Working player-to-player virtual TON transfer by Telegram ID or username.
- Telegram profile name, username, ID and photo_url in the Mini App when Telegram supplies it.
- Rocket route and WebSocket proxy.
- PVP with multiple players per round and a 15-second round timer.
- Ranking and statistics.
- Developer-only controls for user list, balances, activity and settings.
- Telegram /start welcome + Open TONIX button + start command menu.

## Hosting
Render should have `BOT_TOKEN` set as an environment variable. Optional `BOT_USERNAME` can be set to the bot username without `@` so referral links are exact.

The start command runs the game backend, Telegram bot and gateway together:
`node mock-game.js & node bot.js & node gateway.js`
