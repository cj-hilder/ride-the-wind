# Ride the Wind

**[Open the app → cj-hilder.github.io/ride-the-wind](https://cj-hilder.github.io/ride-the-wind/)**

A Progressive Web App that predicts your bike commute time from the forecast
wind and tells you when to leave. For a fixed arrival ("at work by 8:30") it
works out when to set off; for a fixed departure ("leaving work at 5") it tells
you when you'll arrive.

**Free and open source**, released under the MIT License by Chris Hilder — free
to use, study, modify, and share. Your routes and rides stay on your device.

## Using it

Three tabs:

- **Plan** — pick a route and tap any day in the week strip to see when to leave
  (or when you'll arrive). A live countdown appears as the time approaches.
  *Explore* checks a different time on that day; *Go now* shows the ride if you
  left this minute.
- **Ride** — records an actual ride by GPS, with pause for stops. At the end you
  can nudge the time or discard it; accepted rides train the model.
- **Routes** — add and tune routes, and set the margin of error.

You add a route from a GPX file (plan one in a route planner, or export a ride
you've already recorded). Each route is tuned from two things you set: your
**still-air speed** and a **terrain effect** — how sheltered or exposed the
route is, which sets how much wind slows or speeds you. That's enough to use it
from day one. Each destination needs two routes, one each way.

## How it works

- For each route it samples the wind along your actual path and works out how
  much the head- and tailwind components will speed up or slow down the ride,
  with **separate head- and tailwind sensitivities** (shelter is often
  directional).
- The forecast combines the high-resolution deterministic model with a
  **51-member ECMWF ensemble** — about fifty separate wind forecasts per route.
  The deterministic run is folded into the ensemble as one weighted member,
  weighted toward it at short lead (where it resolves local terrain) and fading
  to pure ensemble by the next day. The central estimate and its spread emerge
  from that single population, so the spread reflects genuine forecast
  agreement, not a guess. Departures lean conservative so you're rarely late;
  how much of the spread to apply is a tunable margin-of-error setting.
- It **learns each route** from the rides you log. It's usable from the first
  ride (starting from the speed and terrain you set) and well-tuned after about
  ten rides in each direction, then keeps adapting as your fitness changes. When
  it has learned a route the tuning controls show what it has learned; nudge a
  control to switch back to setting the times by hand.

There are no notifications: a PWA can't reliably wake to alert you when closed,
so the app shows the live countdown while open instead. Everything runs locally
in the browser; the only network calls are to the
[Open-Meteo](https://open-meteo.com) forecast and ensemble APIs.

## Develop

```
npm install
npm run dev
```

Built with Vite and React. The prediction logic lives in `src/lib/` as small,
separately-tested modules (wind model, ensemble, learning, verdict, storage);
run the test suites in the project root with `node test*.mjs`.

## Deploy

Pushing to `main` triggers the GitHub Action, which builds with Vite and
publishes to GitHub Pages at
[cj-hilder.github.io/ride-the-wind](https://cj-hilder.github.io/ride-the-wind/).

## License

MIT — see [LICENSE](LICENSE). Free to use, modify, and distribute. Provided as
is, without warranty: the times it gives are forecast-based estimates, not
guarantees, so ride safely and within the law.
