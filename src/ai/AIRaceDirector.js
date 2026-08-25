import { RaceSnapshot } from './RaceSnapshot.js';
import { TrackIntelligence } from './TrackIntelligence.js';
import { RacecraftAgent } from './RacecraftAgent.js';
import { TrajectoryPlanner } from './TrajectoryPlanner.js';
import { VehicleController } from './VehicleController.js';
import { AI_TIMING, finite } from './AIConfig.js';

const modeFor = (mode) => ({ PACE: 'RACE', RETURN: 'RACE', PASS: 'PASS',
  FOLLOW: 'FOLLOW', DEFEND: 'DEFEND', RECOVER: 'RECOVER', BRAKE: 'BRAKE',
  LAUNCH: 'GRID', PIT: 'PIT', COOLDOWN: 'COOLDOWN' })[mode] ?? 'RACE';

const strategicPhaseFor = (intent) => ({ PASS: 'ATTACK', FOLLOW: 'FOLLOW', DEFEND: 'DEFEND',
  RETURN: 'RETURN', BRAKE: 'BLOCKED', LAUNCH: 'LAUNCH', RECOVER: 'RECOVER', PIT: 'PIT',
  COOLDOWN: 'COOLDOWN', PACE: 'PACE' })[intent?.mode] ?? 'PACE';

export class AIRaceDirector {
  constructor({ track, vehicles = [] } = {}) {
    this.track = track;
    this.trackModel = TrackIntelligence.for(track);
    this.agents = new Map();
    this.controllers = this.agents;
    this.planner = new TrajectoryPlanner(this.trackModel);
    this.controller = new VehicleController();
    this.tick = 0;
    this.snapshot = null;
    this.lastCommands = new Map();
    this._syncAgents(vehicles);
  }

  _syncAgents(vehicles) {
    const liveIds = new Set();
    for (const vehicle of vehicles) {
      if (vehicle.player) continue;
      liveIds.add(vehicle.id);
      if (!this.agents.has(vehicle.id)) this.agents.set(vehicle.id, new RacecraftAgent(vehicle.id));
    }
    for (const id of this.agents.keys()) if (!liveIds.has(id)) this.agents.delete(id);
  }

  reset({ vehicles = [], track = this.track } = {}) {
    this.track = track;
    this.trackModel = TrackIntelligence.for(track);
    this.planner = new TrajectoryPlanner(this.trackModel);
    this.tick = 0;
    this._syncAgents(vehicles);
    for (const agent of this.agents.values()) agent.reset();
    for (const vehicle of vehicles) {
      if (vehicle.player) continue;
      vehicle.aiTarget = null;
      vehicle.aiTactical = null;
      vehicle.stabilityRequest = null;
    }
  }

  _planField(snapshot) {
    const groups = [];
    for (const agent of this.agents.values()) {
      const ego = snapshot.ego(agent.vehicleId);
      if (!ego || ego.finished || ego.despawned) continue;
      agent.lastTactical = agent.tacticalIntents(snapshot, this.trackModel);
      agent.observeStrategicPhase(strategicPhaseFor(agent.lastTactical[0]));
      const proposals = this.planner.proposalsFor(snapshot, agent, agent.lastTactical);
      for (const proposal of proposals) proposal._vehicle = ego.vehicle;
      groups.push({ agent, ego, proposals,
        priority: Math.max(...agent.lastTactical.map((entry) => finite(entry.priority))),
        raceProgress: finite(snapshot.race?.entries?.get(ego.id)?.unwrappedDistance, ego.distance) });
    }
    groups.sort((a, b) => b.priority - a.priority || b.raceProgress - a.raceProgress
      || a.agent.vehicleId.localeCompare(b.agent.vehicleId));
    const selected = [];
    for (const group of groups) {
      const recovering = group.agent.lastTactical.some((intent) => intent.mode === 'RECOVER');
      let choice = recovering
        ? group.proposals.find((proposal) => proposal.intent.mode === 'RECOVER' && proposal.roadLegal)
        : null;
      const committedMode = group.agent.attack ? 'PASS' : group.agent.defense ? 'DEFEND' : null;
      choice ??= committedMode ? group.proposals.find((proposal) => proposal.intent.mode === committedMode
        && proposal.roadLegal && proposal.collisionFree && proposal.dynamicallyFeasible) : null;
      choice ??= committedMode ? group.proposals
        .filter((proposal) => proposal.intent.mode === committedMode
          && proposal.roadLegal)
        .sort((a, b) => Number(b.collisionFree) - Number(a.collisionFree)
          || finite(b.earliestCollisionTimeS, Infinity) - finite(a.earliestCollisionTimeS, Infinity)
          || Number(b.dynamicallyFeasible) - Number(a.dynamicallyFeasible)
          || b.minimumClearanceM - a.minimumClearanceM || a.score - b.score)[0] : null;
      const previousPhase = group.agent.currentPlan?.intent?.phase;
      choice ??= previousPhase && previousPhase !== 'BRAKE_FALLBACK'
        && group.agent.planPhaseAge < 16
        ? group.proposals.find((proposal) => proposal.intent.phase === previousPhase
          && proposal.roadLegal && proposal.collisionFree && proposal.dynamicallyFeasible)
        : null;
      choice ??= group.proposals.find((proposal) => proposal.intent.phase !== 'BRAKE_FALLBACK'
        && proposal.roadLegal && proposal.collisionFree
        && proposal.dynamicallyFeasible
        && !selected.some((other) => {
          const moving = Math.abs(proposal.terminalLateral - proposal.startLateral) > 0.7;
          const otherMoving = Math.abs(other.terminalLateral - other.startLateral) > 0.7;
          return moving && otherMoving
            && this.planner.trajectoriesConflict(proposal, other, snapshot.track.length);
        }));
      choice ??= group.proposals.find((proposal) => proposal.intent.phase !== 'BRAKE_FALLBACK'
        && proposal.roadLegal && proposal.collisionFree
        && proposal.dynamicallyFeasible);
      choice ??= previousPhase && previousPhase !== 'BRAKE_FALLBACK'
        ? group.proposals
          .filter((proposal) => proposal.intent.phase === previousPhase
            && proposal.roadLegal && proposal.dynamicallyFeasible)
          .sort((a, b) => finite(b.earliestCollisionTimeS, Infinity)
            - finite(a.earliestCollisionTimeS, Infinity)
            || b.minimumClearanceM - a.minimumClearanceM)[0]
        : null;
      choice ??= group.proposals
        .filter((proposal) => proposal.intent.phase !== 'BRAKE_FALLBACK'
          && proposal.roadLegal && proposal.dynamicallyFeasible)
        .sort((a, b) => finite(b.earliestCollisionTimeS, Infinity)
          - finite(a.earliestCollisionTimeS, Infinity)
          || b.minimumClearanceM - a.minimumClearanceM || a.score - b.score)[0];
      choice ??= group.proposals.find((proposal) => proposal.intent.phase === 'BRAKE_FALLBACK');
      choice ??= group.proposals.find((proposal) => proposal.roadLegal && proposal.collisionFree);
      choice ??= group.proposals[group.proposals.length - 1];
      if (choice) {
        choice.candidates = group.proposals;
        group.agent.acceptPlan(choice);
        selected.push(choice);
      }
    }
  }

  step({ vehicles, track = this.track, race, dt = 1 / 120 }) {
    this.track = track;
    this._syncAgents(vehicles);
    this.snapshot = RaceSnapshot.capture({ vehicles, track, race, tick: this.tick });
    if (this.tick % AI_TIMING.trajectoryIntervalTicks === 0) this._planField(this.snapshot);

    const commands = new Map();
    for (const [id, agent] of this.agents) {
      const ego = this.snapshot.ego(id);
      if (!ego || ego.despawned) continue;
      if (ego.finished) {
        const cooldownTime = finite(ego.vehicle.cooldownTime);
        const desiredSpeed = cooldownTime < 4 ? 16 : cooldownTime < 10 ? 8 : 0;
        const cooldownIntent = Object.freeze({
          mode: 'COOLDOWN', phase: 'COOLDOWN', targetId: null,
          terminalLateral: 0, priority: -1, committed: false,
          desiredSpeed, reason: 'FINISH_COOLDOWN'
        });
        const plan = this.planner.proposalsFor(this.snapshot, agent, [cooldownIntent])
          .find((proposal) => proposal.intent.mode === 'COOLDOWN' && proposal.roadLegal)
          ?? this.planner.proposalsFor(this.snapshot, agent, [cooldownIntent])[0];
        agent.acceptPlan(plan);
      }
      if (!agent.currentPlan) {
        agent.lastTactical = agent.tacticalIntents(this.snapshot, this.trackModel);
        agent.acceptPlan(this.planner.proposalsFor(this.snapshot, agent, agent.lastTactical)[0]);
      }
      const actuation = this.controller.compute(this.snapshot, agent, agent.currentPlan, dt);
      const command = this._commandFor(ego, agent, agent.currentPlan, actuation);
      commands.set(id, command);
    }
    this.lastCommands = commands;
    this.tick += 1;
    return commands;
  }

  _commandFor(ego, agent, plan, actuation) {
    const intent = plan.intent;
    const requestedIntent = agent.lastTactical?.[0] ?? intent;
    const targetTraffic = intent.targetId ? this.snapshot.trafficFor(ego.id, 120)
      .find((entry) => entry.other.id === intent.targetId) : null;
    const nearbyTraffic = this.snapshot.trafficFor(ego.id, 120);
    const candidates = (plan.candidates ?? []).slice(0, 12).map((candidate) => ({
      phase: candidate.intent.phase,
      mode: modeFor(candidate.intent.mode),
      score: candidate.score,
      offset: candidate.terminalLateral,
      collisionFree: candidate.collisionFree,
      hardCollisionFree: candidate.hardCollisionFree,
      collisionResponse: candidate.collisionResponse,
      roadLegal: candidate.roadLegal,
      dynamicallyFeasible: candidate.dynamicallyFeasible,
      minimumClearanceM: candidate.minimumClearanceM,
      minimumBodyClearanceM: candidate.minimumBodyClearanceM,
      selected: candidate === plan,
      points: candidate.points
    }));
    const debugState = {
      vehicleId: ego.id,
      name: ego.vehicle.name,
      classKey: ego.classKey,
      mode: modeFor(intent.mode),
      reason: intent.reason,
      racecraftPhase: intent.phase,
      strategicPhase: agent.strategicPhase,
      targetId: intent.targetId,
      passTargetId: intent.mode === 'PASS' ? intent.targetId : null,
      draftTargetId: intent.phase === 'SLIPSTREAM_TOW' ? intent.targetId : null,
      committed: Boolean(intent.committed || agent.attack),
      attackSide: finite(intent.attackSide),
      urgentPass: Boolean(intent.urgentPass),
      defending: intent.mode === 'DEFEND',
      targetOffset: plan.terminalLateral,
      desiredOffset: plan.terminalLateral,
      lineOffset: ego.lateral,
      currentSpeed: ego.speed,
      desiredSpeed: actuation.targetSpeed,
      targetSpeed: actuation.targetSpeed,
      speedError: actuation.targetSpeed - ego.speed,
      recovering: intent.mode === 'RECOVER',
      target: actuation.target ? { x: actuation.target.x, y: actuation.target.y, z: actuation.target.z,
        lateral: actuation.target.lateral } : null,
      controls: { ...actuation.controls },
      output: { ...actuation.controls },
      planPath: plan.points,
      path: plan.points,
      candidates,
      traffic: {
        entries: nearbyTraffic.slice(0, 12).map((entry) => ({
          other: entry.other.vehicle,
          delta: entry.delta,
          lateralDelta: entry.lateralDelta,
          otherLateral: entry.other.lateral,
          closingSpeed: entry.closingSpeed,
          ttc: entry.ttc,
          overlapLongitudinal: entry.overlapLongitudinal,
          overlapLateral: entry.overlapLateral
        }))
      },
      candidateCount: plan.candidates?.length ?? 1,
      trajectorySelectedOffsetM: plan.terminalLateral,
      trajectoryRequestedOffsetM: intent.terminalLateral,
      trajectoryTransitionS: plan.transitionTimeS,
      trajectoryScore: plan.score,
      trajectoryMinimumClearanceM: plan.minimumClearanceM,
      trajectoryFutureMinimumClearanceM: plan.minimumClearanceM,
      trajectoryCollisionFree: plan.collisionFree,
      trajectoryHardCollisionFree: plan.hardCollisionFree,
      trajectoryCollisionResponse: plan.collisionResponse,
      trajectoryRoadLegal: plan.roadLegal,
      trajectoryDynamicallyFeasible: plan.dynamicallyFeasible,
      closeFront: targetTraffic ? {
        id: targetTraffic.other.id, deltaM: targetTraffic.delta,
        lateralM: targetTraffic.lateralDelta, relativeSpeedMps: targetTraffic.closingSpeed,
        ttc: targetTraffic.ttc
      } : null,
      thought: {
        requestedManeuver: requestedIntent.phase,
        deployedManeuver: intent.phase,
        maneuver: intent.phase,
        targetId: intent.targetId,
        committed: Boolean(intent.committed || agent.attack),
        defending: intent.mode === 'DEFEND',
        straightSend: intent.mode === 'PASS' && intent.phase !== 'SLIPSTREAM_TOW',
        divebombing: intent.phase === 'DIVEBOMB',
        switchbacking: intent.phase === 'SWITCHBACK',
        predictedTimeGainS: targetTraffic ? Math.max(0,
          80 / Math.max(4, targetTraffic.other.forwardSpeed) - 80 / Math.max(4, actuation.targetSpeed)) : 0,
        trajectoryCollisionFree: plan.collisionFree,
        trajectoryRoadLegal: plan.roadLegal,
        trajectoryMinimumClearanceM: plan.minimumClearanceM,
        trajectorySelectedOffsetM: plan.terminalLateral,
        waitReason: intent.mode === 'FOLLOW' ? intent.reason : null,
        abortReason: intent.phase === 'ABORT' ? intent.reason : null,
        escActive: actuation.stability.active,
        escReason: actuation.stability.reason
      },
      telemetry: {
        lateralAccelMps2: Math.abs(ego.speed * ego.yawRate),
        lateralUtilization: actuation.lateralUtilization,
        throttle: actuation.controls.throttle,
        brake: actuation.controls.brake,
        steer: actuation.controls.steer,
        yawRate: ego.yawRate,
        sideslipRadians: actuation.stability.slipAngle,
        escDemand: actuation.stability.demand,
        escActive: actuation.stability.active,
        tractionCut: actuation.tractionCut,
        wakeStrength: ego.wake.strength,
        frontDownforceLoss: ego.wake.frontLoss
      }
    };
    agent.debugState = agent.debugEnabled ? debugState : null;
    return {
      vehicleId: ego.id,
      controls: actuation.controls,
      stability: actuation.stability,
      intent: {
        mode: intent.mode,
        phase: intent.phase,
        targetId: intent.targetId,
        targetLaneOffsetM: plan.terminalLateral,
        committed: Boolean(intent.committed || agent.attack),
        attackSide: finite(intent.attackSide),
        urgentPass: Boolean(intent.urgentPass),
        reason: intent.reason
      },
      target: actuation.target,
      plan,
      marshalRequested: Boolean(intent.marshalRequested),
      cooldownDt: intent.mode === 'COOLDOWN' ? 1 / AI_TIMING.physicsHz : 0,
      debugState
    };
  }

  apply(commands, { vehicles, track = this.track } = {}) {
    const byId = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
    for (const [id, command] of commands) {
      const vehicle = byId.get(id);
      if (!vehicle) continue;
      vehicle.controls = { ...command.controls };
      vehicle.stabilityRequest = command.stability;
      vehicle.aiTarget = command.target ? { x: command.target.x, z: command.target.z,
        lateral: command.intent.targetLaneOffsetM } : null;
      vehicle.aiTactical = {
        source: 'HEURISTIC_RACE_DIRECTOR',
        mode: command.intent.mode,
        reason: command.intent.reason,
        racecraftPhase: command.intent.phase,
        strategicPhase: command.debugState.strategicPhase,
        targetId: command.intent.targetId,
        targetLaneOffsetM: command.intent.targetLaneOffsetM,
        committed: command.intent.committed,
        desiredSpeed: command.debugState.desiredSpeed,
        controls: { ...command.controls },
        esc: { ...command.stability }
      };
      vehicle.racecraft = { ...command.intent };
      if (command.intent.mode === 'COOLDOWN') {
        vehicle.trafficGhost = true;
        vehicle.cooldownTime = finite(vehicle.cooldownTime) + finite(command.cooldownDt);
        if (vehicle.cooldownTime > 16 && vehicle.speed < 0.6) vehicle.despawned = true;
      }
      if (vehicle.ers?.enabled) vehicle.setERSMode?.(
        command.intent.mode === 'PASS' || command.intent.mode === 'DEFEND' ? 'ATTACK' : 'AUTO');
      if (command.marshalRequested) {
        vehicle.marshalRecoverTo(track, vehicle.distance + 10, 0);
        vehicle.aiMarshalRecoveries = finite(vehicle.aiMarshalRecoveries) + 1;
      }
    }
  }

  debugSnapshot(vehicleId = null) {
    if (vehicleId) return this.agents.get(vehicleId)?.debugState ?? null;
    return [...this.agents.values()].map((agent) => agent.debugState).filter(Boolean);
  }
}
