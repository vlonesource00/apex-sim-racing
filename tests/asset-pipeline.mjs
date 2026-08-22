import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const models = resolve(root, 'public/assets/models');
const sources = resolve(root, 'assets/blender');
const textures = resolve(root, 'public/assets/textures');

function file(path, minimumBytes) {
  assert.ok(existsSync(path), 'Missing asset: ' + path);
  const size = statSync(path).size;
  assert.ok(size >= minimumBytes, 'Asset too small: ' + path + ' (' + size + ' B)');
  return size;
}

function parseGlb(path) {
  const data = readFileSync(path);
  assert.equal(data.readUInt32LE(0), 0x46546c67, 'Invalid GLB magic: ' + path);
  assert.equal(data.readUInt32LE(4), 2, 'Unsupported GLB version: ' + path);
  assert.equal(data.readUInt32LE(8), data.length, 'GLB length mismatch: ' + path);
  let offset = 12;
  while (offset < data.length) {
    const length = data.readUInt32LE(offset);
    const type = data.readUInt32LE(offset + 4);
    offset += 8;
    if (type === 0x4e4f534a) return JSON.parse(data.subarray(offset, offset + length).toString('utf8').trim());
    offset += length;
  }
  throw new Error('No JSON GLB chunk: ' + path);
}

function nodeNames(path) {
  return new Set((parseGlb(path).nodes || []).map((node) => node.name).filter(Boolean));
}

function glbMetrics(json) {
  let triangles = 0;
  let primitives = 0;
  let uvPrimitives = 0;
  let texturedPrimitives = 0;
  let texturedUvPrimitives = 0;
  const materials = json.materials || [];
  for (const mesh of json.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      primitives += 1;
      const count = primitive.indices === undefined
        ? json.accessors?.[primitive.attributes?.POSITION]?.count || 0
        : json.accessors?.[primitive.indices]?.count || 0;
      triangles += Math.floor(count / 3);
      const hasUv = primitive.attributes?.TEXCOORD_0 !== undefined;
      if (hasUv) uvPrimitives += 1;
      const material = materials[primitive.material];
      const pbr = material?.pbrMetallicRoughness;
      const textured = Boolean(pbr?.baseColorTexture || pbr?.metallicRoughnessTexture || material?.normalTexture);
      if (textured) {
        texturedPrimitives += 1;
        if (hasUv) texturedUvPrimitives += 1;
      }
    }
  }
  return { triangles, primitives, uvPrimitives, texturedPrimitives, texturedUvPrimitives };
}

function pngSize(path) {
  const data = readFileSync(path);
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Invalid PNG: ' + path);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), bytes: data.length };
}

const sourceFiles = [
  resolve(root, 'tools/blender/build_assets.py'),
  resolve(sources, 'car-variants.blend'),
  resolve(sources, 'track-props.blend')
];
sourceFiles.forEach((path) => file(path, path.endsWith('.py') ? 2000 : 10000));

const cars = {
  gt: 'car-gt.glb',
  touring: 'car-touring.glb',
  prototype: 'car-prototype.glb'
};
let totalBytes = 0;
const carMetrics = {};
for (const [variant, filename] of Object.entries(cars)) {
  const path = resolve(models, filename);
  totalBytes += file(path, 30000);
  const json = parseGlb(path);
  const metrics = glbMetrics(json);
  carMetrics[variant] = metrics;
  const names = nodeNames(path);
  assert.ok([...names].some((name) => name === 'CAR_' + variant.toUpperCase()), 'Missing root node for ' + variant);
  for (const label of ['FL', 'FR', 'RL', 'RR']) {
    assert.ok(names.has(label), variant + ' missing wheel node ' + label);
    assert.ok(names.has(label + '_SPIN'), variant + ' missing wheel spin node ' + label + '_SPIN');
  }
  assert.ok(names.has('COCKPIT_CAMERA'), variant + ' missing COCKPIT_CAMERA anchor');
  assert.ok([...names].some((name) => name.startsWith('COCKPIT_HIDE')), variant + ' missing COCKPIT_HIDE exterior tag');
  assert.ok(metrics.triangles >= 5000, variant + ' triangle budget is still blockout quality: ' + metrics.triangles);
  assert.ok((json.images || []).length >= 8, variant + ' must embed its authored PBR texture set');
  assert.ok(metrics.texturedPrimitives >= 8, variant + ' lacks enough textured hero primitives');
  assert.equal(metrics.texturedPrimitives, metrics.texturedUvPrimitives, 'Every textured ' + variant + ' primitive needs TEXCOORD_0');
  for (const image of json.images || []) {
    assert.ok(image.bufferView !== undefined, variant + ' image must be packed in GLB');
    assert.equal(image.uri, undefined, variant + ' must not rely on an external image URI');
  }
  const materials = json.materials || [];
  assert.ok(materials.some((material) => material.pbrMetallicRoughness?.baseColorTexture), variant + ' missing PBR base-color binding');
  assert.ok(materials.some((material) => material.normalTexture), variant + ' missing PBR normal binding');
  assert.ok(materials.some((material) => material.pbrMetallicRoughness?.metallicRoughnessTexture), variant + ' missing PBR metallic/roughness binding');
}

const gtPath = resolve(models, cars.gt);
const gtJson = parseGlb(gtPath);
const gt = glbMetrics(gtJson);
const gtNodes = gtJson.nodes || [];
const gtNodeNames = new Set(gtNodes.map((node) => node.name).filter(Boolean));
for (const name of [
  'COCKPIT_HIDE_GT_CABIN',
  'COCKPIT_HIDE_GT_BODY_SHELL',
  'COCKPIT_HIDE_GT_HOOD_COWL',
  'COCKPIT_HIDE_GT_A_PILLAR_L',
  'COCKPIT_HIDE_GT_A_PILLAR_R',
  'COCKPIT_HIDE_GT_HEADLAMP',
  'GT_SEAT',
  'GT_DASH',
  'GT_STEERING_WHEEL',
  'GT_INSTRUMENT_DISPLAY'
]) {
  assert.ok(gtNodeNames.has(name), 'GT cockpit sightline node missing: ' + name);
}
const gtCamera = gtNodes.find((node) => node.name === 'COCKPIT_CAMERA');
assert.ok(gtCamera?.translation, 'GT cockpit anchor requires explicit translation');
assert.ok(gtCamera.translation[1] >= 1.2, 'GT cockpit eye must sit above dashboard: ' + gtCamera.translation[1]);
assert.ok(gtCamera.translation[2] >= -0.25 && gtCamera.translation[2] <= 0.05, 'GT cockpit eye longitudinal calibration invalid: ' + gtCamera.translation[2]);
const gtDisplay = (gtJson.materials || []).find((material) => material.name === 'MAT_DISPLAY_GT');
assert.ok(gtDisplay, 'GT readable instrument material missing');
assert.ok(gtDisplay.emissiveTexture || gtDisplay.emissiveFactor, 'GT instrument material needs restrained emissive output');
assert.ok(gt.triangles >= 8000 && gt.triangles <= 25000, 'GT triangle count outside hero budget: ' + gt.triangles);
assert.ok((gtJson.materials || []).length >= 9 && (gtJson.materials || []).length <= 24, 'GT material count outside budget: ' + (gtJson.materials || []).length);
assert.ok((gtJson.images || []).length >= 1, 'GT must embed at least one image');
assert.ok((gtJson.textures || []).length >= 3, 'GT must expose at least three textures');
assert.ok(gt.texturedPrimitives >= 3, 'GT lacks textured hero primitives');
assert.equal(gt.texturedPrimitives, gt.texturedUvPrimitives, 'Every textured GT primitive needs TEXCOORD_0');
for (const image of gtJson.images || []) {
  assert.ok(image.bufferView !== undefined, 'GT image must be packed in GLB');
  assert.equal(image.uri, undefined, 'GT must not rely on external image URI');
}
const pbrMaterials = gtJson.materials || [];
assert.ok(pbrMaterials.some((material) => material.pbrMetallicRoughness?.baseColorTexture), 'GT missing PBR base-color texture binding');
assert.ok(pbrMaterials.some((material) => material.normalTexture), 'GT missing PBR normal texture binding');
assert.ok(pbrMaterials.some((material) => material.pbrMetallicRoughness?.metallicRoughnessTexture), 'GT missing PBR metallic/roughness texture binding');
const gtPngs = readdirSync(textures)
  .filter((name) => /^gt-.*\.png$/i.test(name))
  .sort()
  .map((name) => ({ name, ...pngSize(resolve(textures, name)) }));
assert.ok(gtPngs.length >= 3, 'GT texture source PNGs missing');
assert.ok(gtPngs.some((image) => image.width === 1024 && image.height === 1024), 'GT needs a 1024 base-color/livery texture');
assert.ok(gtPngs.every((image) => image.bytes >= 512), 'GT source texture unexpectedly trivial');

const propsPath = resolve(models, 'circuit-props.glb');
const propsBytes = file(propsPath, 70000);
totalBytes += propsBytes;
const propNames = nodeNames(propsPath);
const propsJson = parseGlb(propsPath);
const propsMetrics = glbMetrics(propsJson);
for (const name of [
  'PROP_PIT_MODULE', 'PROP_GRANDSTAND', 'PROP_MARSHAL_POST', 'PROP_TIRE_STACK', 'PROP_TECPRO', 'PROP_GANTRY', 'PROP_LIGHT_TOWER', 'PROP_FENCE_PANEL', 'PROP_TREE',
  'PROP_CONTROL_TOWER', 'PROP_HOSPITALITY', 'PROP_FOOTBRIDGE', 'PROP_SERVICE_TRUCK', 'PROP_CRANE', 'PROP_LIGHT_GANTRY'
]) {
  assert.ok(propNames.has(name), 'Missing prop node ' + name);
}
assert.ok((propsJson.images || []).length >= 10, 'Props must embed the authored surface texture set');
assert.ok(propsMetrics.texturedPrimitives >= 20, 'Prop library lacks textured primitives');
assert.equal(propsMetrics.texturedPrimitives, propsMetrics.texturedUvPrimitives, 'Every textured prop primitive needs TEXCOORD_0');
assert.ok(propsBytes <= 12 * 1024 * 1024, 'Prop GLB exceeds 12 MB browser budget: ' + propsBytes);
assert.ok(propsMetrics.triangles >= 2500 && propsMetrics.triangles <= 20000, 'Prop triangle count outside browser budget: ' + propsMetrics.triangles);
assert.ok(totalBytes <= 15 * 1024 * 1024, 'GLB payload exceeds 15 MB target: ' + totalBytes);

const assetLibrary = readFileSync(resolve(root, 'src/render/AssetLibrary.js'), 'utf8');
const requests = [...assetLibrary.matchAll(/['"]\/assets\/models\/([^'"]+\.glb)['"]/g)].map((match) => match[1]);
assert.equal(new Set(requests).size, 4, 'Expected exactly four GLB runtime requests');
for (const request of requests) file(resolve(models, request), 1);

console.log('Asset pipeline check passed.');
console.log('GLB payload: ' + totalBytes + ' B (' + (totalBytes / 1024).toFixed(1) + ' KiB).');
console.log('GT hero: ' + gt.triangles + ' triangles, ' + (gtJson.materials || []).length + ' materials, ' + (gtJson.images || []).length + ' images, ' + (gtJson.textures || []).length + ' textures, ' + gt.texturedUvPrimitives + ' UV-textured primitives.');
console.log('Touring/prototype: ' + carMetrics.touring.triangles + '/' + carMetrics.prototype.triangles + ' triangles, ' + carMetrics.touring.texturedUvPrimitives + '/' + carMetrics.prototype.texturedUvPrimitives + ' UV-textured primitives.');
console.log('Track props: ' + propsMetrics.triangles + ' triangles, ' + (propsJson.images || []).length + ' embedded images, ' + propsMetrics.texturedUvPrimitives + ' UV-textured primitives.');
console.log('GT PNGs: ' + gtPngs.map((image) => image.name + ' ' + image.width + 'x' + image.height + ' ' + image.bytes + ' B').join('; '));
console.log('Validated: 3 vehicle variants, GT PBR/UV contracts, wheel/cockpit nodes, 15 prop roots, runtime requests.');
