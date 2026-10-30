# ZimBundles

Render-ready Zimbabwe data bundle storefront with Telegram admin notifications.

## Telegram environment variables on Render
- `TELEGRAM_BOT_TOKEN` = your Telegram bot token
- `TELEGRAM_ADMIN_CHAT_ID` = the admin chat ID that should receive notifications

The bot supports:
- New bundle order notifications
- New free-trial request notifications
- Inline Approve / Reject buttons
- `/orders`
- `/status`
- `/help`

## Important
This project does **not** collect EcoCash PINs or security OTPs. Connect payments only through an authorized EcoCash/merchant integration.

## Render
Build command: leave empty
Start command: `npm start`
