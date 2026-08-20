# APEX — Browser Sim Racing (Three.js)

Goal: an iRacing-grade sim racing experience in the browser. Third-person + first-person
driving, real tire physics, AI racecraft, animations, effects, coherent feel.

Method: decompose into the smallest judgeable pieces, fan out builder sub-agents per piece,
then a separate harsh fresh-context critic inspects the RUNNING game (screenshots + telemetry,
never the builder's summary), compares blind vs iRacing, and names the single biggest gap.
Loop each piece until the critic is wowed. Between waves a fresh agent drives the whole game
and smooths it into one coherent thing.

## How to run
```
npm install
npm run dev        # then open the printed URL (default http://localhost:5173)
```
Screenshots / telemetry used by critics:
```
npm run shot       # headless Edge screenshots of the running game
npm run telemetry  # headless physics/AI telemetry dump
```

## Piece board
Legend: [ ] todo · [b] building · [c] in critic loop · [x] critic-approved

| #  | Piece                              | Status | Critic verdict (latest)            |
|----|------------------------------------|--------|------------------------------------|
| P0 | Engine scaffold / loop / modules   | [b]    | -                                  |
| P1 | Vehicle physics (tires/aero/drive) | [ ]    | -                                  |
| P2 | Track system (geo/curbs/walls/grip)| [ ]    | -                                  |
| P3 | Car control + input                | [ ]    | -                                  |
| P4 | Cameras (cockpit/chase/hood)       | [ ]    | -                                  |
| P5 | AI racecraft                       | [ ]    | -                                  |
| P6 | Race orchestration/timing          | [ ]    | -                                  |
| P7 | Sound (procedural WebAudio)        | [ ]    | -                                  |
| P8 | Environment + lighting             | [ ]    | -                                  |
| P9 | Car visuals + animation            | [ ]    | -                                  |
| P10| Effects (smoke/skids/sparks)       | [ ]    | -                                  |
| P11| HUD + UI                           | [ ]    | -                                  |
| P12| Performance                        | [ ]    | -                                  |
| P13| Coherence / feel integration       | [ ]    | -                                  |

## Wave log
(newest first)

### Wave 0 — foundation
- Scaffolded Vite + Three.js project, progress page, architecture contract.
- Building foundation vertical slice: scaffold + physics + track + control + chase cam.
