// SOLMAR — tunables. Every number the world, cars, police and jobs care about lives here so
// the whole game can be re-balanced without hunting through modules.

export const SEED_DEFAULT = 7;

export const CITY = {
  grid: 12,            // 12 x 12 blocks
  pitch: 64,           // block-to-block distance
  road: 15,            // road width
  pavement: 5,         // pavement width either side
  bound: 384,          // half-extent of the city square
  seaEdge: 330,        // sea starts around this x
  buildingMin: 42,     // count target (midpoint of "about 110" acceptance range)
  buildingMax: 118,
  lampSpacing: 2,      // lamps every N blocks along a row
};

// The sun-soaked palette. Bright blue sky, warm gold sun, whitewashed walls, terracotta roofs,
// turquoise sea, asphalt that looks wet in the shade.
export const PALETTE = {
  skyTop: 0x2f86d6,
  skyHorizon: 0xbfe4f6,
  sun: 0xffd79a,
  sunCore: 0xfff3d0,
  fog: 0xcfe6f2,
  wall: [0xf6efe2, 0xfbf6ea, 0xefe6d4, 0xf2e3c8, 0xe9dfcd],
  roof: [0xb4552f, 0xc2683c, 0x9e4626, 0xcf7a4a],
  terracotta: 0xb4552f,
  window: 0x2a3a45,
  neon: [0xff5fa2, 0x38e8ff, 0xffd166, 0x8bff9a, 0xff8b3d],
  asphalt: 0x2b3138,
  asphaltShade: 0x1d2228,
  pavement: 0xcfc6b4,
  kerb: 0xbdb3a0,
  sea: 0x1f9fb8,
  seaDeep: 0x167d94,
  sand: 0xe7d6a8,
  palmTrunk: 0x7a5230,
  palmLeaf: 0x2f7d3a,
  playerJacket: 0xffd23f,
  policeBody: 0x1b2b52,
  policeBand: 0xf2f4f8,
  redLight: 0xff2d2d,
  blueLight: 0x2d6bff,
  headlight: 0xfff6d8,
  tail: 0xff3322,
  skid: 0x14161a,
  smoke: 0xb9bcc0,
  dust: 0xd8c7a4,
  missionTeal: 0x2ff0d0,
  missionGold: 0xffc94a,
  cash: 0x7dffab,
  crate: 0x3ec46d,
};

export const PLAYER = {
  health: 100,
  walk: 5.0,
  sprint: 8.5,
  gravity: 26,
  jump: 8.2,
  radius: 0.55,
  enterRange: 4.0,
  magSize: 12,
  reserve: 48,
  rpm: 300,
  reloadTime: 1.4,
  bulletRange: 110,
  aimCone: 0.42,       // radians half-angle, deliberately generous
};

export const VEHICLE_CLASSES = {
  sedan: {
    label: 'Sedan', length: 4.5, width: 1.95, height: 1.35,
    accel: 15.5, topSpeed: 33, reverseSpeed: 11, turn: 2.15, grip: 6.4,
    health: 100, mass: 1.0, body: 0x8fb3c9, roof: 0x7aa2ba,
  },
  sports: {
    label: 'Sports', length: 4.4, width: 1.99, height: 1.16,
    accel: 23.5, topSpeed: 46, reverseSpeed: 13, turn: 2.6, grip: 5.4,
    health: 82, mass: 0.9, body: 0xd8332f, roof: 0xb52520,
  },
  taxi: {
    label: 'Taxi', length: 4.6, width: 1.98, height: 1.42,
    accel: 15.0, topSpeed: 32, reverseSpeed: 10.5, turn: 2.1, grip: 6.4,
    health: 100, mass: 1.0, body: 0xf2c53d, roof: 0xe6b62c,
  },
  truck: {
    label: 'Truck', length: 6.6, width: 2.35, height: 2.35,
    accel: 10.5, topSpeed: 25, reverseSpeed: 8, turn: 1.55, grip: 6.0,
    health: 165, mass: 1.9, body: 0xd9d4c6, roof: 0xb9b2a2,
  },
  police: {
    label: 'Cruiser', length: 4.7, width: 2.0, height: 1.44,
    accel: 18.5, topSpeed: 38, reverseSpeed: 11.5, turn: 2.3, grip: 6.6,
    health: 135, mass: 1.15, body: 0x1b2b52, roof: 0x16244a,
  },
};

export const TRAFFIC = {
  cars: 24,
  peds: 34,
  laneOffset: 3.4,
  junctionSlow: 0.45,
  gap: 7.0,
};

export const POLICE = {
  maxStars: 5,
  maxUnits: 9,
  perStar: 2,
  spawnEvery: 3.4,
  arrestRange: 3.0,
  arrestTime: 2.2,
  decayDelay: 12,
  sirenRange: 90,
  officerSpeed: 3.4,
};

export const MISSIONS = [
  {
    id: 'borrowed', name: 'Borrowed Wheels', short: 'Lift a car and bring it to the lock-up on Marlin Row.',
    reward: 450, stars: 1, target: { x: 214, z: -40, label: 'the lock-up on Marlin Row' },
  },
  {
    id: 'collector', name: 'The Debt Collector', short: 'A runner skipped a debt. Wreck his sports car.',
    reward: 800, stars: 2, target: { x: -120, z: 120, label: 'the runner\'s sports car' },
  },
  {
    id: 'harbour', name: 'The Harbour Case', short: 'Pick up the case at the marina, deliver it north with the heat on.',
    reward: 1400, stars: 2,
    pickup: { x: 282, z: -150, label: 'the marina case' },
    target: { x: 150, z: 190, label: 'the north quay' },
  },
  {
    id: 'lastboat', name: 'The Last Boat', short: 'Lift the sports car, shake the tail, reach the hideout.',
    reward: 2600, stars: 3,
    pickup: { x: -262, z: 40, label: 'the harbour deck car' },
    target: { x: -240, z: 210, label: 'the hideout' },
  },
];

export const HUD = {
  minimapSize: 230,
  promptDrive: 'E — get out · Shift — handbrake · H — horn',
};

export const TIME = {
  startMinutes: 16 * 60 + 40,
  realMsPerDay: 7 * 60 * 1000,
};

export const CAMERA = {
  fov: 62,
  near: 0.3,
  far: 1600,
  driveDistance: 10.5,
  driveHeight: 4.2,
  footDistance: 6.5,
  footHeight: 3.0,
  exposure: 1.5,
};
