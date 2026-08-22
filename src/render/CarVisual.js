import * as THREE from 'three';

const WHEEL_LABELS = ['FL', 'FR', 'RL', 'RR'];
const tireMaterial = new THREE.MeshStandardMaterial({ color: '#0a0d0b', roughness: 0.94, metalness: 0.01 });
const rimMaterial = new THREE.MeshStandardMaterial({ color: '#b7c1bf', roughness: 0.24, metalness: 0.9 });
const darkMaterial = new THREE.MeshStandardMaterial({ color: '#101614', roughness: 0.38, metalness: 0.62 });

function isGlass(material) {
  return material?.name?.startsWith('MAT_GLASS');
}

function shadow(object) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
  });
  return object;
}

export class CarVisual {
  constructor(vehicle, { variant = 'gt' } = {}) {
    this.vehicle = vehicle;
    this.variant = variant;
    this.group = new THREE.Group();
    this.group.name = 'CAR_VISUAL_' + vehicle.id;
    this.group.rotation.order = 'YXZ';
    this.rollCenterHeight = 0.33;
    this.chassisPivot = new THREE.Group();
    this.chassisPivot.name = 'CHASSIS_ATTITUDE_PIVOT';
    this.chassisPivot.position.y = this.rollCenterHeight;
    this.chassisPivot.rotation.order = 'YXZ';
    this.group.add(this.chassisPivot);
    this.chassis = new THREE.Group();
    this.chassis.name = 'SPRUNG_CHASSIS';
    // Keep every authored asset coordinate unchanged at zero attitude while
    // making the pivot explicit and low, close to the car's roll centre.
    this.chassis.position.y = -this.rollCenterHeight;
    this.chassisPivot.add(this.chassis);
    this.assetModel = null;
    this.assetWheels = [];
    this.cockpitAnchor = null;
    this.cockpitHiddenNodes = [];
    this.cockpitGlassBindings = [];
    this.cockpitActive = false;
    this._cockpitPose = { position: new THREE.Vector3(), forward: new THREE.Vector3() };
    this.fallback = new THREE.Group();
    this.chassis.add(this.fallback);
    this.fallbackWheels = this._createFallback();
  }

  _createFallback() {
    const paint = new THREE.MeshStandardMaterial({ color: this.vehicle.color, roughness: 0.3, metalness: 0.52 });
    const glass = new THREE.MeshStandardMaterial({ color: '#08171b', roughness: 0.14, metalness: 0.42, transparent: true, opacity: 0.8 });
    const lamp = new THREE.MeshStandardMaterial({ color: '#f5f8e9', emissive: '#d8ff95', emissiveIntensity: 1.1, roughness: 0.2 });
    const body = shadow(new THREE.Mesh(new THREE.BoxGeometry(1.84, 0.42, 4.1), paint));
    body.position.y = 0.55;
    this.fallback.add(body);
    const cabin = shadow(new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.44, 1.58), glass));
    cabin.position.set(0, 0.94, -0.23);
    cabin.rotation.x = -0.13;
    this.fallback.add(cabin);
    const splitter = shadow(new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.08, 0.58), darkMaterial));
    splitter.position.set(0, 0.31, 2.17);
    this.fallback.add(splitter);
    const wing = shadow(new THREE.Mesh(new THREE.BoxGeometry(1.74, 0.07, 0.3), darkMaterial));
    wing.position.set(0, 1.08, -2.02);
    this.fallback.add(wing);
    for (const x of [-0.55, 0.55]) {
      const headlamp = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.1, 0.08), lamp);
      headlamp.position.set(x, 0.64, 2.08);
      this.fallback.add(headlamp);
    }
    return this.vehicle.wheels.map((wheel) => {
      const pivot = new THREE.Group();
      pivot.position.set(wheel.x, 0.34, wheel.z);
      const rubber = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.335, 0.335, 0.245, 16), tireMaterial));
      rubber.geometry.rotateZ(Math.PI / 2);
      pivot.add(rubber);
      const rim = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.196, 0.196, 0.252, 12), rimMaterial));
      rim.geometry.rotateZ(Math.PI / 2);
      pivot.add(rim);
      this.group.add(pivot);
      return { pivot, rubber, rim };
    });
  }

  _bindAssetWheels(model) {
    return WHEEL_LABELS.map((label) => {
      const pivot = model.getObjectByName(label);
      const spin = model.getObjectByName(label + '_SPIN') || pivot;
      if (!pivot || !spin) return null;
      return {
        pivot,
        spin,
        baseY: pivot.position.y,
        baseYaw: pivot.rotation.y
      };
    });
  }

  _bindCockpit(model) {
    this.cockpitAnchor = model.getObjectByName('COCKPIT_CAMERA') || null;
    this.cockpitHiddenNodes = [];
    this.cockpitGlassBindings = [];
    model.traverse((object) => {
      if (object.name.startsWith('COCKPIT_HIDE')) this.cockpitHiddenNodes.push(object);
      if (!object.isMesh || !object.material) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some(isGlass)) this.cockpitGlassBindings.push({ mesh: object, original: object.material });
    });
  }

  attachAsset(assets) {
    if (this.assetModel) return true;
    const model = assets.cloneCar(this.variant, this.vehicle.color);
    if (!model) return false;
    const wheels = this._bindAssetWheels(model);
    if (wheels.some((wheel) => !wheel)) return false;
    shadow(model);
    this.assetModel = model;
    this.assetWheels = wheels;
    this._bindCockpit(model);
    this.chassis.add(model);
    // Authored GLBs contain the wheel pivots under their model root.  Detach
    // those pivots after the body is placed so road bank/grade reaches wheels,
    // while the sprung chassis pivot affects body/cockpit geometry only.
    this.group.updateWorldMatrix(true, true);
    model.updateWorldMatrix(true, true);
    wheels.forEach((wheel) => this.group.attach(wheel.pivot));
    this.fallback.visible = false;
    this.fallbackWheels.forEach((wheel) => { wheel.pivot.visible = false; });
    return true;
  }

  setCockpitView(active) {
    if (!this.vehicle.player || !this.assetModel) return false;
    const desired = Boolean(active);
    if (desired === this.cockpitActive) return Boolean(this.cockpitAnchor);
    this.cockpitActive = desired;
    this.cockpitHiddenNodes.forEach((node) => { node.visible = !desired; });
    this.cockpitGlassBindings.forEach((binding) => {
      if (!desired) {
        binding.mesh.material = binding.original;
        return;
      }
      const tune = (material) => {
        if (!isGlass(material)) return material;
        const cockpitGlass = material.clone();
        cockpitGlass.transparent = true;
        cockpitGlass.opacity = Math.min(material.opacity ?? 1, 0.12);
        cockpitGlass.depthWrite = false;
        cockpitGlass.side = THREE.DoubleSide;
        cockpitGlass.needsUpdate = true;
        return cockpitGlass;
      };
      binding.mesh.material = Array.isArray(binding.original) ? binding.original.map(tune) : tune(binding.original);
    });
    return Boolean(this.cockpitAnchor);
  }

  getCockpitPose() {
    if (!this.vehicle.player || !this.assetModel || !this.cockpitAnchor) return null;
    this.group.updateWorldMatrix(true, true);
    this.cockpitAnchor.getWorldPosition(this._cockpitPose.position);
    this.cockpitAnchor.getWorldDirection(this._cockpitPose.forward);
    return this._cockpitPose.forward.lengthSq() > 0.0001 ? this._cockpitPose : null;
  }

  update(dt) {
    const car = this.vehicle;
    this.group.visible = !car.despawned;
    if (car.despawned) return;
    const datumHeight = car.spec?.aero?.designRideHeight != null
      ? car.spec.aero.designRideHeight + 0.006
      : (car.rideHeight ?? 0.068);
    const rootY = (car.position.y ?? 0) - datumHeight + 0.04;
    const roadBank = Number.isFinite(car.roadBank) ? car.roadBank : (car.surface?.bank ?? 0);
    const roadGrade = Number.isFinite(car.roadGrade) ? car.roadGrade : (car.surface?.grade ?? 0);
    // The group is the unsprung road pose.  With +Z forward, positive grade
    // raises the front under -X rotation and positive bank raises the local
    // left side under -Z rotation.
    this.group.position.set(car.position.x, rootY, car.position.z);
    this.group.rotation.set(-roadGrade, car.yaw, -roadBank);
    this.chassisPivot.rotation.set(car.pitch, 0, car.roll);
    this.chassis.rotation.set(0, 0, 0);

    this.fallbackWheels.forEach((visual, index) => {
      const wheel = car.wheels[index];
      visual.pivot.position.y = 0.34 - wheel.compression;
      visual.pivot.rotation.y = wheel.steer;
      visual.rubber.rotation.x += wheel.omega * dt;
      visual.rim.rotation.x += wheel.omega * dt;
    });
    this.assetWheels.forEach((visual, index) => {
      const wheel = car.wheels[index];
      visual.pivot.position.y = visual.baseY - wheel.compression;
      visual.pivot.rotation.y = visual.baseYaw + wheel.steer;
      visual.spin.rotation.x += wheel.omega * dt;
    });
  }
}
