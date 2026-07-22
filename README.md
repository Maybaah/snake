# Snake

Arcade Snake for the [maybaah.github.io](https://maybaah.github.io/) arcade: eat
apples, grow, do not hit the wall or your own tail. Vanilla JS, no build step,
no dependencies.

**Play:** https://maybaah.github.io/snake/

## How it fits together

This repo deploys as a project page under the root site's domain. It loads the
shared design system and arcade client (`/assets/site.css`, `/assets/arcade.js`)
from [Maybaah/Maybaah.github.io](https://github.com/Maybaah/Maybaah.github.io),
so it must be served under that domain to look and score right.

The run is tick-discrete, so a seed plus the ticks at which the player turned
describes it completely. Apples come from a seeded PRNG and every effective turn
is appended to a tape of `<tickDelta><dir>` pairs, for example `7l12u3r`. On game
over the run submits `{mode, seed, day, moves}` and no score at all: the Worker
replays the tape, counts the apples and the steps itself, and rejects anything
that does not end in a crash of its own accord. Same never-trust-the-client model
as [flowcode](https://github.com/Maybaah/flowcode).

The rules here (grid size, apple draw, collision order, what counts as an
effective turn) are mirrored in the Worker, so `game.js` and
`worker/src/index.js` in the site repo have to stay in step.

- 20x20 grid, walls kill, one apple at a time, start length 3
- Arrow keys, WASD, swipe, or the on-screen pad on touch
- Ranked by apples first, then by fewest steps travelled to the last apple. The
  steps taken while dying are not counted, so cutting the tape short of the
  crash buys nothing
- Two modes: `classic` on a random seed, and `daily` where the Worker derives
  the seed from its own day number so everyone faces the same apples
- Hold space to move faster. It shortens the timer and nothing else, so it never
  changes the tape or the score
- Local run history lives in `localStorage` and feeds the arcade hub card
