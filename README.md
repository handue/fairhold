# Fairhold

Charity silent auctions where guests put bidding power on hold with PayPal, bid themselves or let Glim, an AI bidding agent that cannot overspend, bid for them, and pay only for what they win.

**Status:** in development for the PayPal AI Hackathon.

## Local setup (keyless mode)

No PayPal or Anthropic keys needed: payments are simulated and Glim replays recorded replies. Requires Node 24.

```sh
npm install
npm run db:start     # local Postgres 16 on port 54329, data in .pgdata/
npm run db:migrate
npm run db:seed      # the Riverside Shelter Gala fixture, live, on the next evening it can still run
npm run dev          # http://localhost:3000/e/riverside-shelter-gala
```

The fixture keeps the gala's wall-clock times (it closes at 9:30 PM Pacific) on the first evening with more than an hour left before that close, so it stays live and takes bids. Its countdowns read as approved only with the clock frozen at the instant the seed prints: `FREEZE_CLOCK_AT=<that instant> npm run dev` (development only). `npm run db:seed -- --date=2026-11-07` seeds it on the evening the screens were drawn, for screens that print the date.

To change a default or add sandbox keys, copy `.env.example` to `.env.local`.

Other scripts: `npm run db:status`, `npm run db:stop`, `npm test`, `npm run test:e2e`, `npm run lint`, `npm run typecheck`.

## License

[MIT](LICENSE)
