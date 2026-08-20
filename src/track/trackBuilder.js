import * as THREE from 'three';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Centripetal Catmull-Rom for a closed loop -> dense point list.
function catmullRomClosed(pts, samplesPerSeg = 24, alpha = 0.5) {
  const out = [];
  const n = pts.length;
  const P = (i) => pts[((i % n) + n) % n];
  for (let i = 0; i < n; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const d1 = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    if (d1 < 1e-4) continue;
    for (let j = 0; j < samplesPerSeg; j++) {
      const t = j / samplesPerSeg;
      out.push(crPoint(p0, p1, p2, p3, t, alpha));
    }
  }
  return out;
}

function crPoint(p0, p1, p2, p3, t, alpha) {
  const getT = (a, b) => Math.pow(Math.hypot(b.x - a.x, b.z - a.z), alpha);
  const t0 = 0;
  const t1 = t0 + getT(p0, p1);
  const t2 = t1 + getT(p1, p2);
  const t3 = t2 + getT(p2, p3);
  const tt = t1 + (t2 - t1) * t;
  const lerpP = (a, b, ta, tb) => {
    const f = (tt - ta) / (tb - ta || 1e-6);
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, y: (a.y || 0) + ((b.y || 0) - (a.y || 0)) * f, w: (a.w ?? 12) + ((b.w ?? 12) - (a.w ?? 12)) * f };
  };
  const A1 = lerpP(p0, p1, t0, t1), A2 = lerpP(p1, p2, t1, t2), A3 = lerpP(p2, p3, t2, t3);
  const B1 = lerpP(A1, A2, t0, t2), B2 = lerpP(A2, A3, t1, t3);
  const C = lerpP(B1, B2, t1, t2);
  return C;
}

// Build a ribbon BufferGeometry along samples. offsetFn(sample, i) -> {l, r, y}
// l/r = distance from centre to left/right edge, y = height offset.
function buildRibbon(samples, offsetFn, uvScaleS = 0.25) {
  const n = samples.length;
  const pos = new Float32Array(n * 2 * 3);
  const nor = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const idx = [];
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    const { l, r, y } = offsetFn(s, i);
    const lx = s.pos.x + s.left.x * l, lz = s.pos.z + s.left.y * l;
    const rx = s.pos.x - s.left.x * r, rz = s.pos.z - s.left.y * r;
    const yy = s.pos.y + y;
    pos.set([lx, yy, lz], (i * 2) * 3);
    pos.set([rx, yy, rz], (i * 2 + 1) * 3);
    nor.set([0, 1, 0], (i * 2) * 3);
    nor.set([0, 1, 0], (i * 2 + 1) * 3);
    const v = s.s * uvScaleS;
    uv.set([0, v], (i * 2) * 2);
    uv.set([1, v], (i * 2 + 1) * 2);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
    idx.push(a, b, c, b, d, c); // CCW seen from +Y (normals up)
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildTrack(def) {
  const raw = catmullRomClosed(def.points, def.samplesPerSeg ?? 26);
  // Compute arc length + tangents
  const samples = [];
  let s = 0;
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    const prev = raw[(i - 1 + raw.length) % raw.length];
    const next = raw[(i + 1) % raw.length];
    let tx = next.x - prev.x, tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const segLen = i === 0 ? 0 : Math.hypot(p.x - raw[i - 1].x, p.z - raw[i - 1].z);
    s += segLen;
    samples.push({
      s,
      pos: new THREE.Vector3(p.x, p.y || 0, p.z),
      dir: new THREE.Vector2(tx, tz),
      left: new THREE.Vector2(tz, -tx), // left of travel
      width: p.w ?? 12,
      grip: 1,
    });
  }
  const length = s + Math.hypot(raw[0].x - raw[raw.length - 1].x, raw[0].z - raw[raw.length - 1].z);

  // Spatial hash for nearest()
  const cell = 8;
  const grid = new Map();
  const key = (x, z) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  samples.forEach((sm, i) => {
    const k = key(sm.pos.x, sm.pos.z);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });

  function nearest(pos) {
    const cx = Math.floor(pos.x / cell), cz = Math.floor(pos.z / cell);
    let best = -1, bestD = Infinity;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const arr = grid.get(`${cx + dx},${cz + dz}`);
        if (!arr) continue;
        for (const i of arr) {
          const sm = samples[i];
          const d = (sm.pos.x - pos.x) ** 2 + (sm.pos.z - pos.z) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    if (best < 0) { // fallback full scan (rare)
      for (let i = 0; i < samples.length; i++) {
        const sm = samples[i];
        const d = (sm.pos.x - pos.x) ** 2 + (sm.pos.z - pos.z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    const sm = samples[best];
    const relX = pos.x - sm.pos.x, relZ = pos.z - sm.pos.z;
    const lateral = relX * sm.left.x + relZ * sm.left.y; // +left
    const dist = Math.sqrt(bestD);
    const halfW = sm.width / 2;
    let surface = 'track';
    if (Math.abs(lateral) > halfW + 2.2) surface = def.offroad ?? 'grass';
    else if (Math.abs(lateral) > halfW - 0.9) surface = 'curb';
    return { idx: best, s: sm.s, lateral, dist, surface, grip: sm.grip };
  }

  function sampleAt(ss) {
    let t = ((ss % length) + length) % length;
    // binary search
    let lo = 0, hi = samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].s < t) lo = mid + 1; else hi = mid;
    }
    const i = lo, sm = samples[i];
    return { pos: sm.pos, dir: sm.dir, left: sm.left, width: sm.width, idx: i };
  }

  function heightAt(x, z) {
    const n = nearest({ x, z });
    return samples[n.idx].pos.y;
  }

  // ---- Geometry ----
  const group = new THREE.Group();
  const roadGeo = buildRibbon(samples, (sm) => ({ l: sm.width / 2, r: sm.width / 2, y: 0 }), 0.18);
  const curbLGeo = buildRibbon(samples, (sm) => ({ l: sm.width / 2 + 1.2, r: -sm.width / 2, y: 0.02 }), 0.5);
  const curbRGeo = buildRibbon(samples, (sm) => ({ l: -sm.width / 2, r: sm.width / 2 + 1.2, y: 0.02 }), 0.5);
  const grassGeo = buildRibbon(samples, (sm) => ({ l: 70, r: 70, y: -0.06 }), 0.05);

  // ---- Materials with Shaders ----
  const mats = def._materials || {};
  
  // Asphalt shader
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8 });
  roadMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>\nvarying vec2 vUv2;`
    ).replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>\nvUv2 = uv;`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\nvarying vec2 vUv2;\n
       // Hash and Noise functions for procedural texture
       float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
       float noise(vec2 p) {
         vec2 i = floor(p); vec2 f = fract(p);
         vec2 u = f*f*(3.0-2.0*f);
         return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
                    mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
       }`
    ).replace(
      '#include <map_fragment>',
      `#include <map_fragment>
       float n = noise(vUv2 * 100.0) * 0.1;
       float dash = step(0.9, fract(vUv2.y * 10.0)) * step(0.48, vUv2.x) * step(vUv2.x, 0.52);
       vec3 roadColor = vec3(0.2) + vec3(n);
       diffuseColor.rgb = mix(roadColor, vec3(0.9), dash);
      `
    );
  };

  // Curb shader (red/white)
  const curbMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  curbMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>\nvarying vec2 vUv2;`
    ).replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>\nvUv2 = uv;`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\nvarying vec2 vUv2;`
    ).replace(
      '#include <map_fragment>',
      `#include <map_fragment>
       float stripe = step(0.5, fract(vUv2.y * 2.0));
       diffuseColor.rgb = mix(vec3(0.8, 0.1, 0.1), vec3(0.9), stripe);
      `
    );
  };

  // Grass shader
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x3f7d3a, roughness: 1.0 });
  grassMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>\nvarying vec2 vUv2;`
    ).replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>\nvUv2 = uv;`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\nvarying vec2 vUv2;\n
       float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
       float noise(vec2 p) {
         vec2 i = floor(p); vec2 f = fract(p);
         vec2 u = f*f*(3.0-2.0*f);
         return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
                    mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
       }`
    ).replace(
      '#include <map_fragment>',
      `#include <map_fragment>
       float n = noise(vUv2 * 20.0);
       vec3 gColor = mix(vec3(0.2, 0.4, 0.15), vec3(0.25, 0.5, 0.2), n);
       diffuseColor.rgb = gColor;
      `
    );
  };

  const road = new THREE.Mesh(roadGeo, mats.road || roadMat);
  const curbL = new THREE.Mesh(curbLGeo, mats.curb || curbMat);
  const curbR = new THREE.Mesh(curbRGeo, mats.curb || curbMat);
  const grass = new THREE.Mesh(grassGeo, mats.grass || grassMat);
  road.receiveShadow = curbL.receiveShadow = curbR.receiveShadow = grass.receiveShadow = true;
  group.add(grass, road, curbL, curbR);

  // Walls: offset beyond the grass ribbon edge, following centreline.
  const wallOffset = def.wallOffset ?? 26;
  const walls = [];
  const wallStep = 3;
  for (let i = 0; i < samples.length; i += wallStep) {
    const sm = samples[i];
    const nx = samples[(i + wallStep) % samples.length];
    for (const side of [1, -1]) {
      const ax = sm.pos.x + sm.left.x * wallOffset * side;
      const az = sm.pos.z + sm.left.y * wallOffset * side;
      const bx = nx.pos.x + nx.left.x * wallOffset * side;
      const bz = nx.pos.z + nx.left.y * wallOffset * side;
      walls.push({ a: new THREE.Vector3(ax, sm.pos.y, az), b: new THREE.Vector3(bx, nx.pos.y, bz) });
    }
  }

  return {
    name: def.name,
    length,
    samples,
    mesh: group,
    startS: def.startS ?? 0,
    nearest,
    sampleAt,
    heightAt,
    walls,
  };
}
