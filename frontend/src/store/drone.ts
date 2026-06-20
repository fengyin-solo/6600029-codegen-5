import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Waypoint, NoFlyZone, TerrainPoint, FlightPlan, DroneConfig, FlightProgress, FlightCheckpoint, FlightSegmentStats } from '../types';
import {
  aStarPathfind,
  rrtPathfind,
  smoothPath,
  calculateFlightStats,
  calculateSegmentStats,
  checkTerrainCollision,
  exportKML,
  mockNoFlyZones,
  mockTerrainData,
  haversine,
} from '../utils/pathfinding';

const CHECKPOINTS_KEY = 'drone_checkpoints';

function createInitialProgress(): FlightProgress {
  return {
    currentWaypointIndex: 0,
    waypointsCompleted: [],
    flownDistance: 0,
    elapsedTime: 0,
    batteryUsed: 0,
    startTime: null,
    interruptTime: null,
    resumeCount: 0,
  };
}

function loadCheckpointsFromStorage(): FlightCheckpoint[] {
  try {
    const raw = localStorage.getItem(CHECKPOINTS_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveCheckpointsToStorage(cps: FlightCheckpoint[]) {
  try {
    localStorage.setItem(CHECKPOINTS_KEY, JSON.stringify(cps));
  } catch {
    /* ignore */
  }
}

export const useDroneStore = defineStore('drone', () => {
  const waypoints = ref<Waypoint[]>([]);
  const noFlyZones = ref<NoFlyZone[]>([]);
  const terrainData = ref<TerrainPoint[]>([]);
  const currentPlan = ref<FlightPlan | null>(null);
  const selectedAlgorithm = ref<'astar' | 'rrt'>('astar');
  const isSimulating = ref(false);
  const isInterrupted = ref(false);
  const simProgress = ref(0);
  const mapCenter = ref<[number, number]>([39.9, 116.4]);
  const checkpoints = ref<FlightCheckpoint[]>(loadCheckpointsFromStorage());
  const flightProgress = ref<FlightProgress>(createInitialProgress());
  const selectedResumeIndex = ref<number>(0);
  const previewResumeIndex = ref<number>(0);

  const droneConfig = ref<DroneConfig>({
    maxAltitude: 500,
    maxSpeed: 20,
    batteryCapacity: 5000,
    consumptionRate: 100,
    safeDistance: 30,
  });

  let simInterval: ReturnType<typeof setInterval> | null = null;

  // ─── Actions ──────────────────────────────────────────────────────────────
  function addWaypoint(
    lat: number,
    lng: number,
    altitude = 100,
    speed = 10,
    action: Waypoint['action'] = 'none'
  ) {
    const id = `wp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    waypoints.value.push({ id, lat, lng, altitude, speed, action });
  }

  function removeWaypoint(id: string) {
    waypoints.value = waypoints.value.filter((w) => w.id !== id);
  }

  function updateWaypoint(id: string, updates: Partial<Waypoint>) {
    const wp = waypoints.value.find((w) => w.id === id);
    if (wp) Object.assign(wp, updates);
  }

  function planRoute(start: [number, number], goal: [number, number]) {
    const bounds = { minLat: 39.85, maxLat: 39.95, minLng: 116.35, maxLng: 116.45 };
    let raw: Waypoint[];
    if (selectedAlgorithm.value === 'astar') {
      raw = aStarPathfind(start, goal, 30, noFlyZones.value, bounds);
    } else {
      raw = rrtPathfind(start, goal, noFlyZones.value);
    }
    const smoothed = smoothPath(raw);
    waypoints.value = smoothed;
    updatePlan();
    resetFlightProgress();
    selectedResumeIndex.value = 0;
    previewResumeIndex.value = 0;
    isInterrupted.value = false;
    isSimulating.value = false;
    simProgress.value = 0;
  }

  function clearRoute() {
    waypoints.value = [];
    currentPlan.value = null;
    simProgress.value = 0;
    stopSimInterval();
    isSimulating.value = false;
    isInterrupted.value = false;
    resetFlightProgress();
    selectedResumeIndex.value = 0;
    previewResumeIndex.value = 0;
  }

  function resetFlightProgress() {
    flightProgress.value = createInitialProgress();
  }

  function updatePlan() {
    const stats = calculateFlightStats(waypoints.value, droneConfig.value);
    currentPlan.value = {
      id: `plan-${Date.now()}`,
      name: 'Flight Plan',
      waypoints: [...waypoints.value],
      totalDistance: stats.totalDistance,
      estimatedTime: stats.estimatedTime,
      batteryUsage: stats.batteryUsage,
    };
  }

  function stopSimInterval() {
    if (simInterval) {
      clearInterval(simInterval);
      simInterval = null;
    }
  }

  function getCurrentDronePosition(): { lat: number; lng: number; altitude: number } | null {
    const idx = flightProgress.value.currentWaypointIndex;
    if (waypoints.value.length === 0) return null;
    const wp = waypoints.value[Math.min(idx, waypoints.value.length - 1)];
    return { lat: wp.lat, lng: wp.lng, altitude: wp.altitude };
  }

  function advanceSimulationStep() {
    const progress = flightProgress.value;
    const wps = waypoints.value;
    const totalWps = wps.length;
    if (totalWps < 2) return;

    const nextIdx = progress.currentWaypointIndex + 1;
    if (nextIdx >= totalWps) {
      simProgress.value = 100;
      isSimulating.value = false;
      isInterrupted.value = false;
      stopSimInterval();
      return;
    }

    const fromWp = wps[progress.currentWaypointIndex];
    const toWp = wps[nextIdx];
    const segDist = haversine(fromWp.lat, fromWp.lng, toWp.lat, toWp.lng);
    const segTime = segDist / ((fromWp.speed + toWp.speed) / 2 || 1);
    const segMinutes = segTime / 60;
    const segBattery = (segMinutes * droneConfig.value.consumptionRate / droneConfig.value.batteryCapacity) * 100;

    progress.currentWaypointIndex = nextIdx;
    progress.waypointsCompleted.push(toWp.id);
    progress.flownDistance += segDist;
    progress.elapsedTime += segTime;
    progress.batteryUsed = Math.min(100, progress.batteryUsed + segBattery);

    const total = currentPlan.value?.totalDistance || 1;
    simProgress.value = Math.min(100, (progress.flownDistance / total) * 100);

    if (nextIdx >= totalWps - 1) {
      simProgress.value = 100;
      isSimulating.value = false;
      isInterrupted.value = false;
      stopSimInterval();
    }
  }

  function simulateFlight() {
    if (waypoints.value.length < 2 || isSimulating.value) return;

    if (flightProgress.value.startTime === null) {
      flightProgress.value.startTime = Date.now();
    }

    isSimulating.value = true;
    isInterrupted.value = false;

    simInterval = setInterval(() => {
      advanceSimulationStep();
    }, 800);
  }

  function interruptFlight() {
    if (!isSimulating.value) return;
    stopSimInterval();
    isSimulating.value = false;
    isInterrupted.value = true;
    flightProgress.value.interruptTime = Date.now();
    selectedResumeIndex.value = flightProgress.value.currentWaypointIndex;
    previewResumeIndex.value = flightProgress.value.currentWaypointIndex;
    saveCheckpoint();
  }

  function resumeFlight(fromIndex?: number) {
    if (waypoints.value.length < 2) return;

    if (fromIndex !== undefined) {
      const clamped = Math.max(0, Math.min(fromIndex, waypoints.value.length - 1));
      if (clamped !== flightProgress.value.currentWaypointIndex) {
        recomputeProgressToIndex(clamped);
      }
    }

    flightProgress.value.resumeCount += 1;
    isInterrupted.value = false;
    simulateFlight();
  }

  function recomputeProgressToIndex(targetIndex: number) {
    if (waypoints.value.length < 2) return;
    const clamped = Math.max(0, Math.min(targetIndex, waypoints.value.length - 1));
    if (clamped === 0) {
      resetFlightProgress();
      simProgress.value = 0;
      return;
    }
    const flownStats = calculateSegmentStats(waypoints.value, droneConfig.value, 0, clamped);
    flightProgress.value.currentWaypointIndex = clamped;
    flightProgress.value.waypointsCompleted = waypoints.value
      .slice(1, clamped + 1)
      .map((w) => w.id);
    flightProgress.value.flownDistance = flownStats.totalDistance;
    flightProgress.value.elapsedTime = flownStats.estimatedTime;
    flightProgress.value.batteryUsed = flownStats.batteryUsage;
    if (!flightProgress.value.startTime) {
      flightProgress.value.startTime = Date.now();
    }
    const total = currentPlan.value?.totalDistance || 1;
    simProgress.value = Math.min(100, (flownStats.totalDistance / total) * 100);
  }

  function previewProgressToIndex(targetIndex: number): FlightSegmentStats {
    if (waypoints.value.length < 2) {
      return { totalDistance: 0, estimatedTime: 0, batteryUsage: 0 };
    }
    const clamped = Math.max(0, Math.min(targetIndex, waypoints.value.length - 1));
    return calculateSegmentStats(waypoints.value, droneConfig.value, clamped);
  }

  function saveCheckpoint(): FlightCheckpoint | null {
    if (!currentPlan.value || waypoints.value.length < 2) return null;
    const progress = flightProgress.value;
    const idx = progress.currentWaypointIndex;
    const lastWp = waypoints.value[Math.min(idx, waypoints.value.length - 1)];
    const totalStats = calculateFlightStats(waypoints.value, droneConfig.value);
    const remainingStats = calculateSegmentStats(
      waypoints.value,
      droneConfig.value,
      idx,
      waypoints.value.length - 1
    );

    const cp: FlightCheckpoint = {
      id: `cp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      planId: currentPlan.value.id,
      planName: currentPlan.value.name,
      createdAt: Date.now(),
      interruptedAtWaypointIndex: idx,
      lastWaypointId: lastWp.id,
      lastPosition: { lat: lastWp.lat, lng: lastWp.lng, altitude: lastWp.altitude },
      remainingWaypoints: waypoints.value.slice(idx),
      completedWaypoints: waypoints.value.slice(0, idx + 1),
      progress: JSON.parse(JSON.stringify(progress)),
      totalStats,
      remainingStats,
    };

    checkpoints.value.unshift(cp);
    if (checkpoints.value.length > 10) {
      checkpoints.value = checkpoints.value.slice(0, 10);
    }
    saveCheckpointsToStorage(checkpoints.value);
    return cp;
  }

  function deleteCheckpoint(id: string) {
    checkpoints.value = checkpoints.value.filter((c) => c.id !== id);
    saveCheckpointsToStorage(checkpoints.value);
  }

  function loadCheckpoint(cp: FlightCheckpoint) {
    if (!cp.remainingWaypoints || cp.remainingWaypoints.length === 0) return;

    const allWpIds = new Set<string>();
    const allWps: Waypoint[] = [];
    for (const w of cp.completedWaypoints) {
      if (!allWpIds.has(w.id)) {
        allWpIds.add(w.id);
        allWps.push(w);
      }
    }
    for (const w of cp.remainingWaypoints) {
      if (!allWpIds.has(w.id)) {
        allWpIds.add(w.id);
        allWps.push(w);
      }
    }
    waypoints.value = allWps;

    currentPlan.value = {
      id: cp.planId,
      name: cp.planName + ' (恢复)',
      waypoints: [...waypoints.value],
      totalDistance: cp.totalStats.totalDistance,
      estimatedTime: cp.totalStats.estimatedTime,
      batteryUsage: cp.totalStats.batteryUsage,
    };

    flightProgress.value = JSON.parse(JSON.stringify(cp.progress));
    selectedResumeIndex.value = cp.interruptedAtWaypointIndex;
    previewResumeIndex.value = cp.interruptedAtWaypointIndex;

    simProgress.value = Math.min(
      100,
      (flightProgress.value.flownDistance / (cp.totalStats.totalDistance || 1)) * 100
    );
    isInterrupted.value = true;
    isSimulating.value = false;
  }

  function loadMockData() {
    noFlyZones.value = mockNoFlyZones;
    terrainData.value = mockTerrainData;
  }

  function exportPlan(): string {
    if (!currentPlan.value) return '';
    return exportKML(currentPlan.value);
  }

  // ─── Computed ─────────────────────────────────────────────────────────────
  const totalDistance = computed(() => {
    if (!currentPlan.value) return 0;
    return currentPlan.value.totalDistance;
  });

  const estimatedTime = computed(() => {
    if (!currentPlan.value) return 0;
    return currentPlan.value.estimatedTime;
  });

  const batteryPercent = computed(() => {
    if (!currentPlan.value) return 0;
    return currentPlan.value.batteryUsage;
  });

  const currentWaypoint = computed<Waypoint | null>(() => {
    const idx = flightProgress.value.currentWaypointIndex;
    if (idx < 0 || idx >= waypoints.value.length) return null;
    return waypoints.value[idx];
  });

  const flownDistance = computed(() => flightProgress.value.flownDistance);
  const remainingDistance = computed(() => Math.max(0, totalDistance.value - flownDistance.value));
  const elapsedFlightTime = computed(() => flightProgress.value.elapsedTime);
  const remainingFlightTime = computed(() => Math.max(0, estimatedTime.value - elapsedFlightTime.value));
  const batteryUsed = computed(() => flightProgress.value.batteryUsed);
  const batteryRemaining = computed(() => Math.max(0, 100 - batteryUsed.value));
  const waypointsCompletedCount = computed(() => flightProgress.value.waypointsCompleted.length);
  const waypointsRemainingCount = computed(() =>
    Math.max(0, waypoints.value.length - flightProgress.value.currentWaypointIndex - 1)
  );
  const resumeCount = computed(() => flightProgress.value.resumeCount);

  const terrainProfile = computed(() => {
    if (waypoints.value.length < 2) return [];
    return waypoints.value.map((wp) => {
      let nearestElev = 0;
      let minDist = Infinity;
      for (const tp of terrainData.value) {
        const d =
          (tp.lat - wp.lat) ** 2 + (tp.lng - wp.lng) ** 2;
        if (d < minDist) {
          minDist = d;
          nearestElev = tp.elevation;
        }
      }
      return {
        lat: wp.lat,
        lng: wp.lng,
        altitude: wp.altitude,
        terrainElevation: nearestElev,
      };
    });
  });

  const hasCheckpoints = computed(() => checkpoints.value.length > 0);

  const canInterrupt = computed(() => isSimulating.value && waypoints.value.length >= 2);
  const canResume = computed(() =>
    (isInterrupted.value || flightProgress.value.currentWaypointIndex > 0) &&
    !isSimulating.value &&
    waypoints.value.length >= 2 &&
    flightProgress.value.currentWaypointIndex < waypoints.value.length - 1
  );
  const canSimulate = computed(() =>
    !isSimulating.value &&
    waypoints.value.length >= 2 &&
    flightProgress.value.currentWaypointIndex < waypoints.value.length - 1
  );

  return {
    waypoints,
    noFlyZones,
    terrainData,
    currentPlan,
    droneConfig,
    selectedAlgorithm,
    isSimulating,
    isInterrupted,
    simProgress,
    mapCenter,
    flightProgress,
    selectedResumeIndex,
    previewResumeIndex,
    checkpoints,
    totalDistance,
    estimatedTime,
    batteryPercent,
    currentWaypoint,
    flownDistance,
    remainingDistance,
    elapsedFlightTime,
    remainingFlightTime,
    batteryUsed,
    batteryRemaining,
    waypointsCompletedCount,
    waypointsRemainingCount,
    resumeCount,
    terrainProfile,
    hasCheckpoints,
    canInterrupt,
    canResume,
    canSimulate,
    addWaypoint,
    removeWaypoint,
    updateWaypoint,
    planRoute,
    clearRoute,
    simulateFlight,
    interruptFlight,
    resumeFlight,
    recomputeProgressToIndex,
    previewProgressToIndex,
    saveCheckpoint,
    deleteCheckpoint,
    loadCheckpoint,
    loadMockData,
    exportPlan,
    updatePlan,
    resetFlightProgress,
    getCurrentDronePosition,
  };
});
