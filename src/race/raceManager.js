// P6 owns this file. Contract: see ARCHITECTURE.md.
// createRace(track, cars, opts) -> race
// updateRace(race, dt) — laps, positions, timing, start/finish, penalties

export const AI_ROSTER = [
  {
    id: 'viper',
    name: 'Alex "Viper" Vance',
    badge: 'VIPER',
    archetype: 'viper',
    personality: 'Aggressive / Divebomber',
    colorHex: 0xef4444,
    skill: 1.02,
  },
  {
    id: 'surgeon',
    name: 'Marco "The Surgeon" Rossi',
    badge: 'SURGEON',
    archetype: 'surgeon',
    personality: 'Smooth / Precision',
    colorHex: 0x3b82f6,
    skill: 1.05,
  },
  {
    id: 'wall',
    name: 'Viktor "The Wall" Steiner',
    badge: 'WALL',
    archetype: 'wall',
    personality: 'Defensive / Blocker',
    colorHex: 0xeab308,
    skill: 0.98,
  },
  {
    id: 'rocket',
    name: 'Elena "Rocket" Rostova',
    badge: 'ROCKET',
    archetype: 'rocket',
    personality: 'Daring Late-Braker',
    colorHex: 0xa855f7,
    skill: 1.03,
  },
  {
    id: 'rookie',
    name: 'Lucas "Rookie" Silva',
    badge: 'ROOKIE',
    archetype: 'rookie',
    personality: 'Cautious / Variable',
    colorHex: 0x10b981,
    skill: 0.92,
  },
];

export function createRace(track, cars = [], opts = {}) {
  const totalLaps = opts.totalLaps ?? opts.laps ?? 5;
  let aiIdx = 0;

  cars.forEach((car, i) => {
    car.lap = 1;
    car.lastS = car.progressS || 0;
    car.lapStart = 0;
    car.lastLap = null;
    car.bestLap = null;
    car.totalTime = 0;
    car.finished = false;
    car.place = i + 1;
    car.totalDistance = car.progressS || 0;

    if (!car.isPlayer) {
      const profile = AI_ROSTER[aiIdx % AI_ROSTER.length];
      aiIdx++;
      if (!car.name || car.name.startsWith('AI') || car.name === 'Car') {
        car.name = profile.name;
      }
      car.badge = profile.badge;
      car.archetype = profile.archetype;
      car.personality = profile.personality;
      if (car.colorHex == null || car.colorHex === 0xe10600) {
        car.colorHex = profile.colorHex;
      }
      if (car._aiDriver) {
        car._aiDriver.archetype = profile.archetype;
        car._aiDriver.name = profile.name;
        car._aiDriver.badge = profile.badge;
      }
    } else {
      car.badge = 'YOU';
    }
  });

  return {
    track,
    cars,
    totalLaps,
    laps: totalLaps,
    started: false,
    finished: false,
    time: 0,
    standings: [...cars],
  };
}

export function updateRace(race, dt) {
  if (!race) return;
  race.time += dt;

  const trackLength = race.track ? race.track.length : 1000;
  const halfTrack = trackLength / 2;

  for (const car of race.cars) {
    if (car.finished) continue;

    const currS = car.progressS || 0;
    const lastS = car.lastS ?? currS;

    // Detect forward lap completion across start/finish (progress wraps from ~trackLength to ~0)
    if (currS < lastS - halfTrack) {
      const lapDuration = race.time - car.lapStart;
      car.lastLap = lapDuration;
      if (car.bestLap == null || lapDuration < car.bestLap) {
        car.bestLap = lapDuration;
      }
      car.lap++;
      car.lapStart = race.time;

      if (car.lap > race.totalLaps) {
        car.finished = true;
        car.totalTime = race.time;
      }
    }

    car.lastS = currS;
    // Total simulated race distance for accurate standings
    car.totalDistance = ((car.lap - 1) * trackLength) + currS;
  }

  // Calculate live race standings (descending total distance)
  const carsList = race.cars || [];
  const sorted = [...carsList].sort((a, b) => (b.totalDistance || 0) - (a.totalDistance || 0));
  sorted.forEach((car, index) => {
    car.place = index + 1;
  });
  race.standings = sorted;

  // Check if player or all cars finished
  const player = carsList.find(c => c.isPlayer);
  if (player && player.finished) {
    race.finished = true;
  } else if (carsList.length > 0 && carsList.every(c => c.finished)) {
    race.finished = true;
  }
}
