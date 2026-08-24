import { ResearchAIController } from '../ai/ResearchAIController.js';
import { ReferenceLapManager } from '../telemetry/GeminiReferenceLap.js';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const modeFor = (mode) => mode === 'ATTACK' ? 'PASS' : mode === 'PACE' ? 'RACE' : mode;

const trafficSummary = (entry) => entry ? {
  id: entry.other?.id ?? null,
  name: entry.other?.name ?? entry.other?.id ?? 'CAR',
  deltaM: finite(entry.delta, 99),
  directM: finite(entry.direct, 99),
  lateralM: finite(entry.side),
  relativeSpeedMps: finite(entry.relativeLongitudinalVelocity),
  ttc: finite(entry.ttc, 99)
} : null;

const compactCandidate = (candidate = {}) => ({
  intentType: candidate.intentType ?? 'STANDARD',
  terminalLateral: finite(candidate.terminalLateral),
  transitionTime: finite(candidate.transitionTime),
  score: finite(candidate.score),
  collisionFree: Boolean(candidate.collisionFree),
  roadLegal: Boolean(candidate.roadLegal),
  minimumClearanceM: finite(candidate.minimumClearanceM, 99),
  futureMinimumClearanceM: finite(candidate.futureMinimumClearanceM, 99),
  maxCurvaturePerM: finite(candidate.maxCurvaturePerM),
  maxLateralAccelerationMps2: finite(candidate.maxLateralAccelerationMps2)
});

/**
 * GPT Racing compatibility shell around Gemini Gauntlet's complete deterministic
 * research controller. Gemini's pace, lattice, attack, defense and rubbing
 * rules are authoritative; this class only publishes the interfaces consumed
 * by the existing race, telemetry and debug presentation.
 */
export class AIController extends ResearchAIController {
  constructor(index = 1) {
    const personality = ((index * 37) % 7) / 100;
    super(index, {
      aggression: Math.min(1, 0.92 + personality),
      diveMargin: Math.min(1, 0.72 + personality),
      defenseReactivity: Math.min(1, 0.93 + personality),
      kerbUsage: 0.96,
      lookahead: 24,
      trailBrakingSkill: 0.98,
      ersAttackMode: true,
      skill: Math.min(1, 0.96 + personality * 0.5)
    });
    this.debugEnabled = false;
    this.debugState = null;
    this._debugPlanPath = [];
    this.referenceTuning = {};
    this.externalReferenceProfile = null;
    this.geminiReference = null;
    this.hybridReference = null;
    this.hybridReferenceExternal = null;
    this.lastDecision = null;
    this.lastTraffic = null;
    this.passPhase = 'PACE';
    this.passTargetId = null;
    this.draftTargetId = null;
    this.passTimer = 0;
    this.trafficTTC = 99;
    this.predictedLateralSeparation = 99;
  }

  _referenceLapTime(profile) {
    return finite(profile?.summary?.lapTimeS,
      finite(profile?.activeProfile?.lapTime, finite(profile?.lapTime, Infinity)));
  }

  _ensureGeminiReference(track) {
    if (!this.geminiReference) this.geminiReference = new ReferenceLapManager(track);
    if (this.externalReferenceProfile?.paceAtDistance) {
      if (!this.hybridReference || this.hybridReferenceExternal !== this.externalReferenceProfile) {
        const humanReference = this.externalReferenceProfile;
        const fastReference = this.geminiReference;
        this.hybridReferenceExternal = humanReference;
        this.hybridReference = {
          summary: {
            lapTimeS: Math.min(this._referenceLapTime(humanReference), this._referenceLapTime(fastReference)),
            source: 'HUMAN_LINE_GEMINI_PACE'
          },
          paceAtDistance(distance) {
            const fast = fastReference.paceAtDistance(distance);
            const human = humanReference.paceAtDistance(distance);
            return {
              ...fast,
              // The bundled human lap is the authoritative spatial path.  It
              // is a real, continuous driven line; Gemini's generated 57.4 s
              // profile supplies only the faster speed and pedal intent.
              lineLateral: finite(human?.lineLateral, finite(human?.lateral, fast?.lineLateral)),
              humanSpeed: finite(human?.envelopeSpeed, finite(human?.speed)),
              humanThrottle: finite(human?.throttle),
              humanBrake: finite(human?.brake)
            };
          }
        };
      }
      super.setReferenceProfile(this.hybridReference);
      return;
    }
    this.hybridReference = null;
    this.hybridReferenceExternal = null;
    super.setReferenceProfile(this.geminiReference);
  }

  setReferenceProfile(profile = null) {
    this.externalReferenceProfile = profile;
    this.hybridReference = null;
    this.hybridReferenceExternal = null;
    if (this.geminiReference) this._ensureGeminiReference(this.geminiReference.track);
    else super.setReferenceProfile(profile);
    return Boolean(profile || this.geminiReference);
  }

  setReferenceTuning(tuning = {}) {
    this.referenceTuning = { ...tuning };
    return this.referenceTuning;
  }

  // RL is deliberately removed from the live authority chain.
  setTacticalPolicy() { return false; }

  setDebugEnabled(enabled) {
    const result = super.setDebugEnabled(enabled);
    if (!result) this._debugPlanPath = [];
    return result;
  }

  resetForRace(vehicle = null) {
    super.resetForRace(vehicle);
    this.lastDecision = null;
    this.lastTraffic = null;
    this._debugPlanPath = [];
    this.passPhase = 'PACE';
    this.passTargetId = null;
    this.draftTargetId = null;
    this.passTimer = 0;
    if (vehicle) {
      vehicle.aiTactical = null;
      vehicle.racecraft = null;
    }
    return this;
  }

  update(vehicle, vehicles, track, race = null, dt = 1 / 120) {
    this._ensureGeminiReference(track);
    super.update(vehicle, vehicles, track, race, dt);
    this._publishCompatibility(vehicle, track, dt);
  }

  _publishCompatibility(vehicle, track, dt) {
    const decision = this.lastDecision;
    if (!decision) return;

    const attack = decision.attDecision ?? {};
    const defense = decision.defDecision ?? {};
    const phase = decision.defending
      ? defense.phase ?? 'DEFEND'
      : attack.phase && attack.phase !== 'NONE' ? attack.phase : decision.tacticalMode;
    const targetId = decision.targetId ?? attack.target?.other?.id ?? defense.target?.other?.id ?? null;
    const traffic = decision.traffic ?? this.lastTraffic ?? {};
    const plan = this.trajectoryPlan ?? {};
    this.awareness.lastScan = traffic;
    this.trajectoryPlanner.lastCandidates = plan.candidates ?? [];
    const target = decision.targetPos ?? plan.trackingPoint ?? vehicle.aiTarget ?? null;
    const currentLateral = finite(traffic.current?.lateral, finite(vehicle.surface?.lateral));
    const minimumClearance = finite(plan.minimumClearanceM, 99);

    this.passPhase = phase;
    this.passTargetId = decision.committed ? targetId : null;
    this.draftTargetId = phase === 'DRAFT' ? targetId : null;
    this.passTimer = decision.committed ? finite(this.attackEngine?.age) : 0;
    this.trafficTTC = finite(traffic.ahead?.ttc, 99);
    this.predictedLateralSeparation = minimumClearance;

    vehicle.racecraft = {
      phase,
      targetId,
      passTargetId: this.passTargetId,
      defenseTargetId: decision.defending ? targetId : null,
      targetOffset: finite(decision.targetOffset),
      committed: Boolean(decision.committed),
      defending: Boolean(decision.defending),
      reason: decision.tacticalReason
    };

    vehicle.aiTactical = {
      source: 'GEMINI_HEURISTIC',
      mode: decision.tacticalMode,
      reason: decision.tacticalReason,
      racecraftPhase: phase,
      desiredSpeed: finite(decision.desiredSpeed),
      trajectorySpeedLimit: finite(decision.trajectorySpeedLimit, finite(decision.desiredSpeed)),
      targetLaneOffsetM: finite(decision.targetOffset),
      targetId,
      committed: Boolean(decision.committed),
      defending: Boolean(decision.defending),
      straightSend: Boolean(decision.straightSend),
      ersMode: decision.ersMode ?? 'AUTO',
      ersTargetSoc: finite(this.ersPlan?.targetSoc, finite(vehicle.ers?.soc)),
      tireGripFactor: finite(decision.tireGripFactor, 1),
      controls: { ...vehicle.controls }
    };

    if (!this.debugEnabled) {
      this.debugState = null;
      this._debugPlanPath = [];
      return;
    }

    this._debugPlanPath = (plan.points ?? []).map((point) => ({
      x: finite(point.x),
      y: finite(point.y),
      z: finite(point.z),
      s: finite(point.s),
      lateral: finite(point.lateral),
      time: finite(point.time),
      speed: finite(point.speed, finite(point.predictedSpeed)),
      predictedSpeed: finite(point.predictedSpeed, finite(point.speed))
    }));
    if (this._debugPlanPath[0]) {
      // Physics advances immediately after the controller in the fixed-step
      // loop, so publish point zero at the imminent post-step pose.
      this._debugPlanPath[0].x = finite(vehicle.position.x) + finite(vehicle.velocity?.x) * dt;
      this._debugPlanPath[0].y = finite(vehicle.position.y);
      this._debugPlanPath[0].z = finite(vehicle.position.z) + finite(vehicle.velocity?.z) * dt;
    }

    const requested = decision.defending
      ? defense.phase ?? 'DEFEND'
      : attack.phase ?? decision.tacticalMode;
    const thought = {
      requestedManeuver: requested,
      deployedManeuver: phase,
      maneuver: phase,
      targetId,
      committed: Boolean(decision.committed),
      defending: Boolean(decision.defending),
      defensivePhase: defense.phase ?? 'NONE',
      attackerIntent: defense.attackerIntent ?? 'NONE',
      straightSend: Boolean(decision.straightSend),
      divebombing: Boolean(attack.divebombing),
      switchbacking: Boolean(attack.switchbacking),
      predictedTimeGainS: finite(attack.predictedTimeGainS),
      requestedClosingSpeedMps: finite(attack.requestedClosingSpeedMps,
        finite(attack.closingSpeed, finite(traffic.ahead?.relativeLongitudinalVelocity))),
      safetyThresholdM: finite(decision.safetyThresholdM),
      kerbAllowanceM: finite(attack.kerbAllowance),
      corridorCollisionFree: Boolean(attack.corridor?.collisionFree ?? true),
      corridorMinimumClearanceM: finite(attack.corridor?.minimumClearanceM, 99),
      trajectoryCollisionFree: Boolean(plan.collisionFree),
      trajectoryRoadLegal: Boolean(plan.roadLegal),
      trajectorySelectedOffsetM: finite(plan.selectedOffset),
      trajectoryMinimumClearanceM: minimumClearance,
      thresholdSafeTrajectory: Boolean(decision.committed && plan.roadLegal),
      waitReason: attack.waitReason ?? null,
      abortReason: attack.abortReason ?? null
    };

    this.debugState = {
      vehicleId: vehicle.id,
      name: vehicle.name,
      classKey: vehicle.classKey,
      skill: finite(this.skill, 0.98),
      aggression: finite(this.aggression, 0.95),
      mode: modeFor(decision.tacticalMode),
      reason: decision.tacticalReason,
      racecraftPhase: phase,
      passTargetId: this.passTargetId,
      draftTargetId: this.draftTargetId,
      passTimer: this.passTimer,
      targetId,
      desiredOffset: finite(decision.targetOffset),
      targetOffset: finite(decision.targetOffset),
      lineOffset: currentLateral,
      desiredSpeed: finite(decision.desiredSpeed),
      targetSpeed: finite(decision.desiredSpeed),
      currentSpeed: finite(vehicle.speed),
      speedKmh: finite(vehicle.speed * 3.6),
      speedError: finite(decision.desiredSpeed - vehicle.speed),
      recovering: Boolean(decision.recovering),
      trafficThreat: defense.threatLevel ?? (traffic.ahead ? 'FRONT' : 'CLEAR'),
      trafficTTC: this.trafficTTC,
      closeFront: trafficSummary(traffic.ahead),
      closeBehind: trafficSummary(traffic.behind),
      nearestSide: trafficSummary(traffic.alongside),
      occupancy: traffic.occupancy ?? {},
      target: target ? {
        x: finite(target.x, vehicle.position.x),
        y: finite(target.y, vehicle.position.y),
        z: finite(target.z, vehicle.position.z),
        lateral: finite(decision.targetOffset)
      } : null,
      controls: { ...vehicle.controls },
      output: { ...vehicle.controls },
      planPath: this._debugPlanPath,
      path: this._debugPlanPath,
      candidates: (plan.candidates ?? []).map(compactCandidate),
      candidateCount: finite(plan.candidateCount, (plan.candidates ?? []).length),
      trajectorySelectedOffsetM: finite(plan.selectedOffset),
      trajectoryRequestedOffsetM: finite(plan.requestedOffset),
      trajectoryTransitionS: finite(plan.transitionTimeS),
      trajectoryScore: finite(plan.score),
      trajectoryMinimumClearanceM: minimumClearance,
      trajectoryFutureMinimumClearanceM: finite(plan.futureMinimumClearanceM, 99),
      trajectoryCollisionFree: Boolean(plan.collisionFree),
      trajectoryRoadLegal: Boolean(plan.roadLegal),
      threat: {
        challengerId: traffic.behind?.other?.id ?? null,
        threatLevel: defense.threatLevel ?? 'NONE',
        threatScore: finite(defense.threatScore),
        attackerIntent: defense.attackerIntent ?? 'NONE',
        gapM: finite(traffic.behind?.delta, 99),
        closingSpeedMps: finite(traffic.behind?.relativeLongitudinalVelocity),
        ttc: finite(traffic.behind?.ttc, 99)
      },
      thought,
      telemetry: {
        lateralAccelMps2: finite(vehicle.telemetry?.lateralG) * 9.81,
        lateralUtilization: finite(decision.pedals?.friction?.latUtilization),
        maxG: finite(decision.pedals?.friction?.maxTotalAccel, 9.81) / 9.81,
        trailBrakingActive: Boolean(decision.pedals?.trailBraking),
        throttle: finite(vehicle.controls.throttle),
        brake: finite(vehicle.controls.brake),
        steer: finite(vehicle.controls.steer),
        ersMode: decision.ersMode ?? 'AUTO',
        ersSoc: finite(vehicle.ers?.soc),
        yawRate: finite(vehicle.yawRate),
        emergency: Boolean(decision.hazard?.emergency)
      }
    };
  }
}
