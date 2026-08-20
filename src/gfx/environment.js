import * as THREE from 'three';

export function buildEnvironment(track, scene) {
  const group = new THREE.Group();
  scene.add(group);

  const dummy = new THREE.Object3D();

  // Mountains
  const mtnGeo = new THREE.CylinderGeometry(0, 400, 300, 8, 1, true);
  const mtnMat = new THREE.MeshStandardMaterial({
    color: 0x808b96,
    roughness: 0.8,
    flatShading: true
  });
  const mountains = new THREE.InstancedMesh(mtnGeo, mtnMat, 40);
  for (let i = 0; i < 40; i++) {
    const angle = (i / 40) * Math.PI * 2;
    const r = 900 + Math.random() * 300;
    dummy.position.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
    dummy.rotation.y = Math.random() * Math.PI * 2;
    dummy.scale.set(1 + Math.random() * 0.5, 1 + Math.random() * 1.5, 1 + Math.random() * 0.5);
    dummy.updateMatrix();
    mountains.setMatrixAt(i, dummy.matrix);
  }
  group.add(mountains);

  // Trees (Alpine pines)
  const treeGeo = new THREE.ConeGeometry(3, 10, 5);
  treeGeo.translate(0, 5, 0);
  const treeMat = new THREE.MeshStandardMaterial({ color: 0x2d4c1e, roughness: 0.9, flatShading: true });
  const treeCount = 2000;
  const trees = new THREE.InstancedMesh(treeGeo, treeMat, treeCount);
  trees.castShadow = true;
  trees.receiveShadow = true;
  for (let i = 0; i < treeCount; i++) {
    const sm = track.samples[Math.floor(Math.random() * track.samples.length)];
    const dist = 20 + Math.random() * 60; // distance from center
    const side = Math.random() > 0.5 ? 1 : -1;
    dummy.position.set(
      sm.pos.x + sm.left.x * dist * side + (Math.random() - 0.5) * 10,
      sm.pos.y,
      sm.pos.z + sm.left.y * dist * side + (Math.random() - 0.5) * 10
    );
    dummy.rotation.y = Math.random() * Math.PI * 2;
    const s = 0.5 + Math.random() * 2.0;
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    trees.setMatrixAt(i, dummy.matrix);
  }
  group.add(trees);

  // Barriers
  let barriers = null;
  if (track.walls && track.walls.length > 0) {
    const barrierGeo = new THREE.BoxGeometry(1, 1.2, 1);
    const barrierMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.7 });
    barriers = new THREE.InstancedMesh(barrierGeo, barrierMat, track.walls.length);
    barriers.castShadow = true;
    barriers.receiveShadow = true;
    for (let i = 0; i < track.walls.length; i++) {
      const w = track.walls[i];
      const midX = (w.a.x + w.b.x) / 2;
      const midZ = (w.a.z + w.b.z) / 2;
      dummy.position.set(midX, w.a.y + 0.6, midZ);
      const angle = Math.atan2(w.b.x - w.a.x, w.b.z - w.a.z);
      dummy.rotation.set(0, angle, 0);
      const dist = Math.hypot(w.b.x - w.a.x, w.b.z - w.a.z);
      dummy.scale.set(1, 1, dist);
      dummy.updateMatrix();
      barriers.setMatrixAt(i, dummy.matrix);
    }
    group.add(barriers);
  }

  // Grandstand
  const smStart = track.samples[0];
  const gsGeo = new THREE.BoxGeometry(40, 15, 10);
  const gsMat = new THREE.MeshStandardMaterial({ color: 0x883333 });
  const grandstand = new THREE.Mesh(gsGeo, gsMat);
  grandstand.position.set(smStart.pos.x + smStart.left.x * 20, smStart.pos.y + 7.5, smStart.pos.z + smStart.left.y * 20);
  grandstand.rotation.y = Math.atan2(smStart.dir.x, smStart.dir.z) - Math.PI / 2;
  grandstand.castShadow = true;
  grandstand.receiveShadow = true;
  group.add(grandstand);

  // Gantry
  const gantryGeo = new THREE.BoxGeometry(30, 2, 2);
  const gantryMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
  const gantry = new THREE.Mesh(gantryGeo, gantryMat);
  gantry.position.set(smStart.pos.x, smStart.pos.y + 10, smStart.pos.z);
  gantry.rotation.y = Math.atan2(smStart.dir.x, smStart.dir.z) - Math.PI / 2;
  gantry.castShadow = true;
  group.add(gantry);

  return { group, trees, barriers, mountains, grandstand, gantry };
}
