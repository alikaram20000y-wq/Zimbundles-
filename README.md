# ZimBundles

Zimbabwe-focused data bundle marketplace.

## Included
- Hourly, Daily, Weekly and Monthly packages
- New-customer $0 trial request
- Zimbabwe phone-number validation and normalization
- Mobile-first ZimBundles design
- Package details and category tabs
- EcoCash as the intended payment method
- Telegram admin notifications
- Telegram Approve / Reject buttons
- Customer status polling

## Render
Use **Web Service**.

Build Command: `npm install`
Start Command: `npm start`
Root Directory: leave blank

## Environment variables
`TELEGRAM_BOT_TOKEN`
`TELEGRAM_ADMIN_CHAT_ID`

Never put the bot token in the frontend or GitHub.

## Payment/security
The website does not collect EcoCash PINs or security OTPs. Those credentials must remain inside the official/authorized EcoCash or payment-provider flow. The current project creates an order/request and sends it to Telegram for admin review; the actual merchant payment API can be connected when authorized EcoCash/payment-provider credentials are available.

## Storage
Orders are currently stored in server memory. A Render restart clears them. PostgreSQL can be added later for persistent order history.
