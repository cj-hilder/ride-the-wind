# Ride the Wind

**[Open the app → cj-hilder.github.io/ride-the-wind](https://cj-hilder.github.io/ride-the-wind/)**

A Progressive Web App that predicts your bike commute time from the forecast
wind and tells you when to leave. For a fixed arrival ("at work by 8:30") it
works out when to set off; for a fixed departure ("leaving work at 5") it tells
you when you'll arrive.

**Free and open source**, released under the MIT License by Chris Hilder — free
to use, study, modify, and share. Your routes and rides stay on your device.

## How it works

You add a route from a GPX file (plan one in a route planner, or export a ride
you've recorded) and enter a rough still-air ride time. From then on:

- For each route it samples the wind along your actual path and works out how
  much the head- and tailwind components will speed up or slow down the ride.
- The forecast comes from a **51-member ECMWF ensemble** — about fifty separate
  wind forecasts per route — so the spread reflects genuine forecast
  uncertainty, not a guess. Departures lean conservative so you're rarely late;
  how cautious is a tunable setting.
- It **learns each route** from the rides you log, fitting separate head- and
  tailwind sensitivities (shelter is often directional). It's usable from the
  first ride and well-tuned after about ten rides in each direction, then keeps
  adapting as your fitness changes.

Everything runs locally in the browser. The only network calls are to the
[Open-Meteo](https://open-meteo.com) forecast and ensemble APIs.

## Develop

```
npm install
npm run dev
```

Built with Vite and React. The prediction logic lives in `src/lib/` as small,
separately-tested modules (wind model, ensemble, learning, alerts, storage);
run the test suites in the project root with `node test*.mjs`.

## Deploy

Pushing to `main` triggers the GitHub Action, which builds with Vite and
publishes to GitHub Pages at
[cj-hilder.github.io/ride-the-wind](https://cj-hilder.github.io/ride-the-wind/).

## License

MIT — see [LICENSE](LICENSE). Free to use, modify, and distribute. Provided as
is, without warranty: the times it gives are forecast-based estimates, not
guarantees, so ride safely and within the law.
