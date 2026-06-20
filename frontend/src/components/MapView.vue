<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick, computed } from 'vue';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useDroneStore } from '../store/drone';

const store = useDroneStore();
const mapContainer = ref<HTMLElement>();
let map: L.Map | null = null;
let waypointLayer: L.LayerGroup | null = null;
let routeLayerFlown: L.Polyline | null = null;
let routeLayerRemaining: L.Polyline | null = null;
let zoneLayer: L.LayerGroup | null = null;
let droneMarker: L.CircleMarker | null = null;

const addMode = ref(false);

const completedWpIds = computed(() => new Set(store.flightProgress.waypointsCompleted));
const currentWpIndex = computed(() => store.flightProgress.currentWaypointIndex);

function initMap() {
  if (!mapContainer.value || map) return;
  map = L.map(mapContainer.value).setView(store.mapCenter, 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 18,
  }).addTo(map);

  waypointLayer = L.layerGroup().addTo(map);
  zoneLayer = L.layerGroup().addTo(map);

  map.on('click', (e: L.LeafletMouseEvent) => {
    if (addMode.value) {
      store.addWaypoint(e.latlng.lat, e.latlng.lng);
    }
  });
}

function drawNoFlyZones() {
  if (!zoneLayer) return;
  zoneLayer.clearLayers();
  for (const zone of store.noFlyZones) {
    const color =
      zone.type === 'airport' ? '#ef4444' :
      zone.type === 'military' ? '#f97316' : '#a855f7';
    L.circle([zone.center[0], zone.center[1]], {
      radius: zone.radius,
      color,
      fillColor: color,
      fillOpacity: 0.15,
      weight: 2,
    })
      .bindPopup(`<b>${zone.name}</b><br>Type: ${zone.type}<br>Radius: ${zone.radius}m`)
      .addTo(zoneLayer);
  }
}

function drawWaypoints() {
  if (!waypointLayer) return;
  waypointLayer.clearLayers();
  const completed = completedWpIds.value;
  const currentIdx = currentWpIndex.value;
  store.waypoints.forEach((wp, idx) => {
    const isCompleted = completed.has(wp.id) || idx < currentIdx;
    const isCurrent = idx === currentIdx && store.isSimulating;
    const isInterruptPoint = idx === currentIdx && store.isInterrupted;

    let color = '#3b82f6';
    let fillColor = '#60a5fa';
    let radius = 8;
    let weight = 2;
    let dashArray: string | undefined;

    if (isCompleted) {
      color = '#22c55e';
      fillColor = '#16a34a';
    }
    if (isCurrent) {
      color = '#fbbf24';
      fillColor = '#f59e0b';
      radius = 12;
      weight = 3;
      dashArray = '4,2';
    }
    if (isInterruptPoint) {
      color = '#ef4444';
      fillColor = '#dc2626';
      radius = 12;
      weight = 3;
      dashArray = '2,2';
    }

    const marker = L.circleMarker([wp.lat, wp.lng], {
      radius,
      color,
      fillColor,
      fillOpacity: 0.9,
      weight,
      dashArray,
    });

    const labelPrefix = isInterruptPoint ? '⚠ ' : isCurrent ? '📍 ' : isCompleted ? '✓ ' : '';
    marker.bindTooltip(`${labelPrefix}WP${idx + 1}`, {
      permanent: true,
      direction: 'top',
      className: 'wp-tooltip ' + (isCompleted ? 'wp-completed' : isCurrent || isInterruptPoint ? 'wp-active' : ''),
    });

    const statusTag =
      isInterruptPoint ? '<span style="color:#ef4444">中断点</span>' :
      isCurrent ? '<span style="color:#f59e0b">当前位置</span>' :
      isCompleted ? '<span style="color:#22c55e">已飞过</span>' :
      '<span style="color:#94a3b8">未飞</span>';

    marker.bindPopup(`
      <div style="min-width:160px">
        <b>航点 ${idx + 1}</b> ${statusTag ? '(' + statusTag + ')' : ''}<br>
        高度: ${wp.altitude}m<br>
        速度: ${wp.speed} m/s<br>
        动作: ${wp.action}<br>
        <button onclick="this.closest('.leaflet-popup').remove()" style="margin-top:4px;color:#ef4444">删除</button>
      </div>
    `);
    marker.on('dragend', (e: any) => {
      const ll = e.target.getLatLng();
      store.updateWaypoint(wp.id, { lat: ll.lat, lng: ll.lng });
    });
    marker.addTo(waypointLayer!);
  });
}

function drawRoute() {
  if (routeLayerFlown && map) {
    map.removeLayer(routeLayerFlown);
    routeLayerFlown = null;
  }
  if (routeLayerRemaining && map) {
    map.removeLayer(routeLayerRemaining);
    routeLayerRemaining = null;
  }
  if (store.waypoints.length < 2 || !map) return;

  const currentIdx = currentWpIndex.value;
  const allWps = store.waypoints;

  if (currentIdx > 0 && currentIdx < allWps.length) {
    const flownCoords: [number, number][] = [];
    for (let i = 0; i <= currentIdx; i++) {
      flownCoords.push([allWps[i].lat, allWps[i].lng]);
    }
    if (flownCoords.length >= 2) {
      routeLayerFlown = L.polyline(flownCoords, {
        color: '#22c55e',
        weight: 4,
        opacity: 0.85,
      }).addTo(map);
    }

    const remainingCoords: [number, number][] = [];
    for (let i = currentIdx; i < allWps.length; i++) {
      remainingCoords.push([allWps[i].lat, allWps[i].lng]);
    }
    if (remainingCoords.length >= 2) {
      let hasDanger = false;
      for (let i = currentIdx; i < allWps.length; i++) {
        const wp = allWps[i];
        for (const zone of store.noFlyZones) {
          const d = Math.sqrt(
            (wp.lat - zone.center[0]) ** 2 + (wp.lng - zone.center[1]) ** 2
          ) * 111000;
          if (d < zone.radius * 1.5) hasDanger = true;
        }
      }
      routeLayerRemaining = L.polyline(remainingCoords, {
        color: hasDanger ? '#ef4444' : '#94a3b8',
        weight: 3,
        opacity: 0.6,
        dashArray: hasDanger ? '8,4' : '6,6',
      }).addTo(map);
    }
  } else {
    const latlngs = store.waypoints.map((w) => [w.lat, w.lng] as [number, number]);
    let hasDanger = false;
    for (const wp of store.waypoints) {
      for (const zone of store.noFlyZones) {
        const d = Math.sqrt(
          (wp.lat - zone.center[0]) ** 2 + (wp.lng - zone.center[1]) ** 2
        ) * 111000;
        if (d < zone.radius * 1.5) hasDanger = true;
      }
    }
    routeLayerRemaining = L.polyline(latlngs, {
      color: hasDanger ? '#ef4444' : '#22c55e',
      weight: 3,
      opacity: 0.8,
      dashArray: hasDanger ? '8,4' : undefined,
    }).addTo(map);
  }
}

function drawSimDrone() {
  if (!map || store.waypoints.length < 2) return;
  const shouldShowDrone =
    store.isSimulating ||
    store.isInterrupted ||
    store.flightProgress.currentWaypointIndex > 0 ||
    store.simProgress > 0;

  if (!shouldShowDrone) {
    if (droneMarker) {
      map.removeLayer(droneMarker);
      droneMarker = null;
    }
    return;
  }

  const pos = store.getCurrentDronePosition();
  if (!pos) return;

  if (droneMarker) {
    droneMarker.setLatLng([pos.lat, pos.lng]);
    if (store.isInterrupted) {
      droneMarker.setStyle({
        radius: 12,
        color: '#ef4444',
        fillColor: '#dc2626',
      });
      droneMarker.setTooltipContent('⚠ 中断');
    } else if (store.isSimulating) {
      droneMarker.setStyle({
        radius: 10,
        color: '#fbbf24',
        fillColor: '#f59e0b',
      });
      droneMarker.setTooltipContent('🚁 无人机');
    } else {
      droneMarker.setStyle({
        radius: 9,
        color: '#60a5fa',
        fillColor: '#3b82f6',
      });
      droneMarker.setTooltipContent('📍 起点');
    }
  } else {
    const isInt = store.isInterrupted;
    droneMarker = L.circleMarker([pos.lat, pos.lng], {
      radius: isInt ? 12 : 10,
      color: isInt ? '#ef4444' : '#fbbf24',
      fillColor: isInt ? '#dc2626' : '#f59e0b',
      fillOpacity: 1,
      weight: 3,
    }).addTo(map);
    droneMarker.bindTooltip(
      isInt ? '⚠ 中断' : '🚁 无人机',
      { permanent: true, direction: 'right', className: 'drone-tooltip' }
    );
  }
}

watch(() => [store.waypoints.length, store.waypoints], () => {
  drawWaypoints();
  drawRoute();
}, { deep: true });

watch(() => store.noFlyZones.length, drawNoFlyZones);
watch(() => store.simProgress, drawSimDrone);
watch(() => [store.flightProgress.currentWaypointIndex, store.isSimulating, store.isInterrupted], () => {
  drawWaypoints();
  drawRoute();
  drawSimDrone();
}, { deep: true });

onMounted(() => {
  nextTick(initMap);
});

onUnmounted(() => {
  if (map) {
    map.remove();
    map = null;
  }
});

function toggleAddMode() {
  addMode.value = !addMode.value;
}

function handlePlanRoute() {
  if (store.waypoints.length < 2) return;
  const first = store.waypoints[0];
  const last = store.waypoints[store.waypoints.length - 1];
  store.planRoute([first.lat, first.lng], [last.lat, last.lng]);
}
</script>

<template>
  <div class="relative w-full h-full">
    <div ref="mapContainer" class="w-full h-full rounded-lg" />
    <div class="absolute top-2 right-2 z-[1000] flex flex-col gap-1">
      <button
        @click="toggleAddMode"
        :class="addMode ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'"
        class="px-3 py-1 rounded text-xs font-medium shadow hover:opacity-90 transition"
      >
        {{ addMode ? '✦ 添加模式' : '○ 点击添加' }}
      </button>
      <button
        @click="handlePlanRoute"
        class="px-3 py-1 rounded text-xs font-medium bg-green-700 text-white shadow hover:opacity-90 transition"
      >
        规划航线
      </button>
      <button
        @click="store.clearRoute()"
        class="px-3 py-1 rounded text-xs font-medium bg-red-700 text-white shadow hover:opacity-90 transition"
      >
        清除
      </button>
    </div>

    <div class="absolute bottom-2 left-2 z-[1000] bg-slate-900/90 rounded p-2 text-[10px] space-y-1 border border-slate-700">
      <div class="font-bold text-slate-300 mb-1">图例</div>
      <div class="flex items-center gap-1.5">
        <span class="inline-block w-3 h-3 rounded-full bg-green-500"></span>
        <span class="text-slate-400">已飞过</span>
      </div>
      <div class="flex items-center gap-1.5">
        <span class="inline-block w-3 h-3 rounded-full bg-blue-500"></span>
        <span class="text-slate-400">未飞航点</span>
      </div>
      <div class="flex items-center gap-1.5">
        <span class="inline-block w-3 h-3 rounded-full bg-amber-500"></span>
        <span class="text-slate-400">当前位置</span>
      </div>
      <div class="flex items-center gap-1.5">
        <span class="inline-block w-3 h-3 rounded-full bg-red-500"></span>
        <span class="text-slate-400">中断点</span>
      </div>
      <div class="flex items-center gap-1.5 pt-1 border-t border-slate-700 mt-1">
        <span class="inline-block w-5 h-1 bg-green-500"></span>
        <span class="text-slate-400">已飞航线</span>
      </div>
      <div class="flex items-center gap-1.5">
        <span class="inline-block w-5 h-1 bg-slate-400" style="border-top:2px dashed #94a3b8;background:transparent;"></span>
        <span class="text-slate-400">待飞航线</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
:deep(.wp-tooltip) {
  background: rgba(30, 41, 59, 0.9);
  color: #e2e8f0;
  border: 1px solid #475569;
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 4px;
}
:deep(.wp-tooltip.wp-completed) {
  background: rgba(22, 101, 52, 0.85);
  border-color: #22c55e;
  color: #bbf7d0;
}
:deep(.wp-tooltip.wp-active) {
  background: rgba(146, 64, 14, 0.85);
  border-color: #f59e0b;
  color: #fde68a;
  font-weight: bold;
}
:deep(.drone-tooltip) {
  background: rgba(146, 64, 14, 0.9);
  color: #fef3c7;
  border: 1px solid #f59e0b;
  font-size: 10px;
  font-weight: bold;
  padding: 2px 6px;
  border-radius: 4px;
}
</style>
