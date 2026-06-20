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
  }

  function clearRoute() {
    waypoints.value = [];
    currentPlan.value = null;
    simProgress.value = 0;
    stopSimInterval();
    isSimulating.value = false;
    isInterrupted.value = false;
    resetFlightProgress();
  }

  function resetFlightProgress() {
    flightProgress.value = createInitialProgress();
    selectedResumeIndex.value = 0;
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
    isSimulating.value = true;
    isInterrupted.value = false;
    if (flightProgress.value.startTime === null) {
      flightProgress.value.startTime = Date.now();
    }
    simInterval = setInterval(() => {
      advanceSimulationStep();
    }, 300);
  }

  function interruptFlight() {
    if (!isSimulating.value) return;
    stopSimInterval();
    isSimulating.value = false;
    isInterrupted.value = true;
    flightProgress.value.interruptTime = Date.now();
    saveCheckpoint();
  }

  function resumeFlight(fromIndex?: number) {
    if (waypoints.value.length < 2) return;
    if (fromIndex !== undefined) {
      if (fromIndex < 0) return;
      if (fromIndex >= waypoints.value.length) return;
      recomputeProgressToIndex(fromIndex);
    }
    flightProgress.value.resumeCount += 1;
    isInterrupted.value = false;
    simulateFlight();
  }

  function recomputeProgressToIndex(targetIndex: number) {
    if (waypoints.value.length < 2) return;
    const clamped = Math.max(0, Math.min(targetIndex, waypoints.value.length - 1));
    const flownStats = calculateSegmentStats(waypoints.value, droneConfig.value, 0, clamped);
    flightProgress.value.currentWaypointIndex = clamped;
    flightProgress.value.waypointsCompleted = waypoints.value
      .slice(0, clamped + 1)
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
    waypoints.value = [...cp.progress.waypointsCompleted.map((id) => {
      const found = cp.completedWaypoints.find((w) => w.id === id);
      if (found) return found;
      return cp.completedWaypoints[cp.completedWaypoints.length - 1];
    }), ...cp.remainingWaypoints.slice(1)];

    const unique: Waypoint[] = [];
    const seen = new Set<string>();
    for (const wp of waypoints.value) {
      if (!seen.has(wp.id)) {
        seen.add(wp.id);
        unique.push(wp);
      }
    }
    waypoints.value = unique;

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

  const resumedSegmentStats = computed<FlightSegmentStats>(() => {
    const idx = selectedResumeIndex.value;
    return calculateSegmentStats(waypoints.value, droneConfig.value, idx);
  });

  const hasCheckpoints = computed(() => checkpoints.value.length > 0);

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
    resumedSegmentStats,
    hasCheckpoints,
    addWaypoint,
    removeWaypoint,
    updateWaypoint,
    planRoute,
    clearRoute,
    simulateFlight,
    interruptFlight,
    resumeFlight,
    recomputeProgressToIndex,
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
