import * as THREE from 'three';
import { clamp } from '../core/math.js';

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'CHASE';
    this.position = new THREE.Vector3(0, 5, -9);
    this.look = new THREE.Vector3();
    this.headInertia = new THREE.Vector3();
    this._targetPosition = new THREE.Vector3();
    this._targetLook = new THREE.Vector3();
    this._cockpitForward = new THREE.Vector3();
    this.standardMode = 'CHASE';
    this.freeYaw = 0;
    this.freePitch = 0;
    this._freeForward = new THREE.Vector3();
    this._freeRight = new THREE.Vector3();
    this._freeMove = new THREE.Vector3();
  }

  toggle() {
    if (this.mode === 'FREE' || this.mode === 'SPECTATE') this.mode = this.standardMode;
    else this.mode = this.mode === 'CHASE' ? 'COCKPIT' : 'CHASE';
    this.standardMode = this.mode;
    return this.mode;
  }

  setSpectate(enabled = true) {
    if (!enabled || this.mode === 'SPECTATE') this.mode = this.standardMode;
    else {
      if (this.mode === 'CHASE' || this.mode === 'COCKPIT') this.standardMode = this.mode;
      this.mode = 'SPECTATE';
    }
    return this.mode;
  }

  setFree(enabled = true) {
    if (!enabled || this.mode === 'FREE') {
      this.mode = this.standardMode;
      return this.mode;
    }
    if (this.mode === 'CHASE' || this.mode === 'COCKPIT') this.standardMode = this.mode;
    const direction = this.camera.getWorldDirection(this._freeForward);
    this.freeYaw = Math.atan2(direction.x, direction.z);
    this.freePitch = Math.asin(clamp(direction.y, -1, 1));
    this.position.copy(this.camera.position);
    this.mode = 'FREE';
    return this.mode;
  }

  updateFree(input = {}, dt = 0) {
    if (this.mode !== 'FREE') return;
    const safeDt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    this.freeYaw += clamp(input.yaw ?? 0, -1, 1) * 1.65 * safeDt;
    this.freePitch = clamp(this.freePitch + clamp(input.pitch ?? 0, -1, 1) * 1.35 * safeDt, -1.48, 1.48);
    const cosPitch = Math.cos(this.freePitch);
    this._freeForward.set(Math.sin(this.freeYaw) * cosPitch, Math.sin(this.freePitch), Math.cos(this.freeYaw) * cosPitch);
    this._freeRight.set(Math.cos(this.freeYaw), 0, -Math.sin(this.freeYaw));
    this._freeMove.set(0, 0, 0)
      .addScaledVector(this._freeForward, clamp(input.forward ?? 0, -1, 1))
      .addScaledVector(this._freeRight, clamp(input.right ?? 0, -1, 1));
    this._freeMove.y += clamp(input.up ?? 0, -1, 1);
    if (this._freeMove.lengthSq() > 1) this._freeMove.normalize();
    const speed = input.boost ? 92 : 24;
    this.position.addScaledVector(this._freeMove, speed * safeDt);
    this.look.copy(this.position).addScaledVector(this._freeForward, 30);
    this.camera.position.copy(this.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.look);
  }

  update(vehicle, dt, cockpitPose = null) {
    const safeDt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    const yaw = vehicle?.yaw ?? 0;
    const speed = Math.max(0, vehicle?.speed ?? 0);
    const vehicleY = vehicle?.position?.y ?? 0;
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const localAcceleration = vehicle?.localAcceleration ?? { x: 0, z: 0 };
    const localVelocity = vehicle?.localVelocity ?? { x: 0, z: 0 };
    const lateralHead = clamp(-localAcceleration.x * 0.012, -0.085, 0.085);
    const longitudinalHead = clamp(-localAcceleration.z * 0.006, -0.045, 0.045);
    const verticalHead = clamp(-(vehicle?.acceleration?.y ?? 0) * 0.003, -0.035, 0.035);
    this.headInertia.lerp(new THREE.Vector3(lateralHead, verticalHead, longitudinalHead), 1 - Math.exp(-9 * safeDt));
    if (this.mode === 'SPECTATE') {
      const stretch = clamp(speed * 0.075, 0, 5.5);
      this._targetPosition.set(
        vehicle.position.x - forwardX * (12.5 + stretch) + rightX * 4.4,
        vehicleY + 6.1 + Math.min(2.2, speed * 0.032),
        vehicle.position.z - forwardZ * (12.5 + stretch) + rightZ * 4.4
      );
      this._targetLook.set(
        vehicle.position.x + forwardX * (9 + stretch * 0.35),
        vehicleY + 1.05,
        vehicle.position.z + forwardZ * (9 + stretch * 0.35)
      );
    } else if (this.mode === 'CHASE') {
      const stretch = clamp(speed * 0.052, 0, 3.4);
      this._targetPosition.set(
        vehicle.position.x - forwardX * (8.35 + stretch) + rightX * 0.35,
        vehicleY + 3.5 + Math.min(1.15, speed * 0.024),
        vehicle.position.z - forwardZ * (8.35 + stretch) + rightZ * 0.35
      );
      this._targetLook.set(
        vehicle.position.x + forwardX * (7.7 + stretch * 0.3),
        vehicleY + 0.92,
        vehicle.position.z + forwardZ * (7.7 + stretch * 0.3)
      );
    } else if (cockpitPose?.position && cockpitPose?.forward) {
      this._targetPosition.copy(cockpitPose.position);
      this._targetPosition.addScaledVector(new THREE.Vector3(rightX, 0, rightZ), this.headInertia.x);
      this._targetPosition.y += this.headInertia.y;
      this._targetPosition.addScaledVector(new THREE.Vector3(forwardX, 0, forwardZ), this.headInertia.z);
      this._cockpitForward.copy(cockpitPose.forward);
      this._cockpitForward.y = 0;
      if (this._cockpitForward.lengthSq() < 0.0001) this._cockpitForward.set(forwardX, 0, forwardZ);
      else this._cockpitForward.normalize();
      // Small apex bias, bounded below a noticeable head turn. With no steering
      // or slip this stays exactly aligned to a cockpit asset anchor.
      const slip = Math.atan2(localVelocity.x ?? 0, Math.max(4, Math.abs(localVelocity.z ?? speed)));
      const apexBias = clamp((vehicle?.steering ?? 0) * 0.12 - slip * 0.18, -0.12, 0.12);
      this._cockpitForward.applyAxisAngle(new THREE.Vector3(0, 1, 0), apexBias).normalize();
      this._targetLook.copy(this._targetPosition).addScaledVector(this._cockpitForward, 24);
      this._targetLook.y = this._targetPosition.y + 0.03;
      this.camera.up.set(0, 1, 0);
    } else {
      this._targetPosition.set(vehicle.position.x + forwardX * 0.12 - rightX * 0.25, vehicleY + 1.08, vehicle.position.z + forwardZ * 0.12 - rightZ * 0.25);
      this._targetLook.set(vehicle.position.x + forwardX * 18, vehicleY + 1.03, vehicle.position.z + forwardZ * 18);
      this.camera.up.set(0, 1, 0);
    }
    const smoothing = 1 - Math.exp(-((this.mode === 'CHASE' || this.mode === 'SPECTATE') ? 6.4 : 18) * safeDt);
    this.position.lerp(this._targetPosition, smoothing);
    this.look.lerp(this._targetLook, smoothing);
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.look);
  }
}
