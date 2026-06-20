export interface Waypoint {
  id: string;
  lat: number;
  lng: number;
  altitude: number;   // meters AGL
  speed: number;      // m/s
  action: 'hover' | 'photo' | 'video' | 'none';
}

export interface FlightPlan {
  id: string;
  name: string;
  waypoints: Waypoint[];
  totalDistance: number;
  estimatedTime: number;
  batteryUsage: number;  // percentage
}

export interface NoFlyZone {
  id: string;
  name: string;
  center: [number, number];
  radius: number;  // meters
  type: 'airport' | 'military' | 'restricted';
}

export interface TerrainPoint {
  lat: number;
  lng: number;
  elevation: number;
}

export interface DroneConfig {
  maxAltitude: number;
  maxSpeed: number;
  batteryCapacity: number;  // mAh
  consumptionRate: number;  // mAh/min
  safeDistance: number;     // meters from obstacles
}

export interface FlightSegmentStats {
  totalDistance: number;
  estimatedTime: number;
  batteryUsage: number;
}

export interface FlightProgress {
  currentWaypointIndex: number;
  waypointsCompleted: string[];
  flownDistance: number;
  elapsedTime: number;
  batteryUsed: number;
  startTime: number | null;
  interruptTime: number | null;
  resumeCount: number;
}

export interface FlightCheckpoint {
  id: string;
  planId: string;
  planName: string;
  createdAt: number;
  interruptedAtWaypointIndex: number;
  lastWaypointId: string;
  lastPosition: { lat: number; lng: number; altitude: number };
  remainingWaypoints: Waypoint[];
  completedWaypoints: Waypoint[];
  progress: FlightProgress;
  totalStats: FlightSegmentStats;
  remainingStats: FlightSegmentStats;
}
