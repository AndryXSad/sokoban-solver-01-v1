# Sokoban Solver — Push-Optimal, Room by Room

[![make.fun bounty](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/AndryXSad/sokoban-solver-01-v1/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/AndryXSad/sokoban-solver-01-v1/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for the [make.fun bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121). One program answers all 5 instances of a set in a single run, in as few pushes as possible.

## How it works

Every level in this competition is a one-wide hallway with one to four rooms
hanging off it, each room holding 3–4 boxes and as many goals behind a single
door — and a box pushed out of its room can never come back. So the
push-optimal count of a level is the sum of its rooms' optima, and each room
can be solved on its own:

1. **Split** the level into the hallway row and one connected room per
   component of the remaining floor, each with its door cell and hallway
   entry cell.
2. **Solve each room** with push-optimal A\*: the state is the sorted box
   cells plus the player cell, the cost is pushes, and the heuristic is the
   cheapest assignment of boxes to goals over box-movement distances.
   Dead squares (found by reverse pulls from the goals) and 2×2 freeze
   deadlocks are pruned, and a solved room only counts when the player can
   still walk back out through its door.
3. **Stitch** the rooms together with shortest walks along the hallway,
   expanding every push into the player's walk to the pushing stance.

The search budget is counted in node expansions, never in wall time, so two
runs write the same bytes. No clock, no randomness, no network, standard
library only.

## Results

- Practice set: **1,000,000 / 1,000,000** — all 5 instances solved at their
  push-optimal counts (13 / 16 / 29 / 47 / 60 pushes), in ~2.4 s for the set.
- 8 freshly drawn sets from the competition's own generator: **1,000,000**
  on every one, 0.5–3.3 s per set — well inside the 60 s wall budget.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `<input>/<id>/level.txt` and writes
`<output>/<id>/solution.txt` (moves in `u/d/l/r`) for every instance.
It runs on Node 22 as `node /bot/main.ts`, plain TypeScript with erasable
syntax only.
