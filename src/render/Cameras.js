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
  }

  toggle() { this.mode = this.mode === 'CHASE' ? 'COCKPIT' : 'CHASE'; return this.mode; }

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
    if (this.mode === 'CHASE') {
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
    const smoothing = 1 - Math.exp(-(this.mode === 'CHASE' ? 6.4 : 18) * safeDt);
    this.position.lerp(this._targetPosition, smoothing);
    this.look.lerp(this._targetLook, smoothing);
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.look);
  }
}
