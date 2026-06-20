<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import MapView from './components/MapView.vue';
import TerrainProfile from './components/TerrainProfile.vue';
import FlightStats from './components/FlightStats.vue';
import { useDroneStore } from './store/drone';
import type { FlightCheckpoint } from './types';

const store = useDroneStore();
const showResumePicker = ref(false);
const showCheckpointList = ref(false);
const localPreviewIndex = ref(0);

onMounted(() => {
  store.loadMockData();
});

function handlePlanRoute() {
  if (store.waypoints.length < 2) return;
  const first = store.waypoints[0];
  const last = store.waypoints[store.waypoints.length - 1];
  store.planRoute([first.lat, first.lng], [last.lat, last.lng]);
  localPreviewIndex.value = 0;
  showResumePicker.value = false;
}

function formatCPTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function formatCPDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function handleLoadCP(cp: FlightCheckpoint) {
  store.loadCheckpoint(cp);
  showCheckpointList.value = false;
  showResumePicker.value = false;
  localPreviewIndex.value = store.previewResumeIndex;
}

function openResumePicker() {
  localPreviewIndex.value = store.selectedResumeIndex;
  showResumePicker.value = true;
}

const previewStats = computed(() => {
  return store.previewProgressToIndex(localPreviewIndex.value);
});

function handleResumeFromPicker() {
  const idx = localPreviewIndex.value;
  store.resumeFlight(idx);
  showResumePicker.value = false;
}

function handleResumeDirect() {
  store.resumeFlight();
}

function handleStartFlight() {
  if (localPreviewIndex.value > 0) {
    store.resumeFlight(localPreviewIndex.value);
  } else {
    store.simulateFlight();
  }
}
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
    <!-- Header -->
    <header class="bg-slate-900 border-b border-slate-800 px-6 py-3 flex items-center justify-between">
      <h1 class="text-lg font-bold text-sky-400">
        🛸 无人机 3D 航线规划与地形避障
      </h1>
      <div class="text-xs text-slate-500 flex items-center gap-3">
        <span>航点: {{ store.waypoints.length }}</span>
        <span>禁区: {{ store.noFlyZones.length }}</span>
        <span v-if="store.resumeCount > 0" class="text-purple-400">
          已续飞: {{ store.resumeCount }}次
        </span>
        <span v-if="store.isSimulating" class="text-amber-400 animate-pulse">
          ● 飞行中
        </span>
        <span v-else-if="store.isInterrupted" class="text-red-400">
          ◼ 已中断
        </span>
      </div>
    </header>

    <!-- Main content -->
    <div class="flex flex-1 overflow-hidden">
      <!-- Map area -->
      <div class="flex-1 flex flex-col" style="width: 70%">
        <div class="flex-1 relative">
          <MapView />
        </div>

        <!-- Bottom terrain profile -->
        <div class="p-2 bg-slate-900 border-t border-slate-800">
          <TerrainProfile />
        </div>
      </div>

      <!-- Right sidebar -->
      <div class="w-[30%] min-w-[280px] bg-slate-900 border-l border-slate-800 p-3 flex flex-col gap-3 overflow-y-auto">
        <!-- Algorithm selector -->
        <div class="bg-slate-800 rounded-lg p-3">
          <h3 class="text-xs font-semibold text-slate-300 mb-2">规划算法</h3>
          <div class="flex gap-2">
            <label class="flex-1 cursor-pointer">
              <input
                type="radio"
                :value="'astar'"
                v-model="store.selectedAlgorithm"
                class="hidden peer"
              />
              <div class="text-center py-1.5 rounded text-xs font-medium peer-checked:bg-sky-700 peer-checked:text-white bg-slate-700 text-slate-400 transition">
                A* 搜索
              </div>
            </label>
            <label class="flex-1 cursor-pointer">
              <input
                type="radio"
                :value="'rrt'"
                v-model="store.selectedAlgorithm"
                class="hidden peer"
              />
              <div class="text-center py-1.5 rounded text-xs font-medium peer-checked:bg-sky-700 peer-checked:text-white bg-slate-700 text-slate-400 transition">
                RRT 随机树
              </div>
            </label>
          </div>
        </div>

        <!-- Actions: flight simulation & resume -->
        <div class="bg-slate-800 rounded-lg p-3 space-y-2">
          <h3 class="text-xs font-semibold text-slate-300 mb-2">🚁 飞行控制</h3>
          <button
            @click="handlePlanRoute"
            :disabled="store.waypoints.length < 2"
            class="w-full py-2 rounded text-xs font-medium bg-green-700 text-white hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            🧭 规划航线
          </button>

          <!-- Simulate/Interrupt/Resume buttons -->
          <div class="grid grid-cols-2 gap-2">
            <!-- 飞行中：只显示中断按钮 -->
            <button
              v-if="store.canInterrupt"
              @click="store.interruptFlight()"
              class="py-2 rounded text-xs font-medium bg-red-700 text-white hover:bg-red-600 transition col-span-2 animate-pulse"
            >
              ⏸ 中断飞行（保存断点）
            </button>

            <!-- 中断后：显示继续飞行 和 选择航点恢复 -->
            <template v-else-if="store.canResume">
              <button
                @click="handleResumeDirect"
                class="py-2 rounded text-xs font-medium bg-emerald-700 text-white hover:bg-emerald-600 transition"
              >
                ▶ 继续飞行
              </button>
              <button
                @click="openResumePicker"
                class="py-2 rounded text-xs font-medium bg-sky-700 text-white hover:bg-sky-600 transition"
              >
                🎯 选择航点恢复
              </button>
            </template>

            <!-- 未开始或已完成：显示开始飞行按钮 -->
            <button
              v-else-if="store.canSimulate"
              @click="handleStartFlight"
              :disabled="store.waypoints.length < 2"
              class="py-2 rounded text-xs font-medium bg-amber-700 text-white hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed transition col-span-2"
            >
              {{ store.simProgress > 0 ? '▶ 从开头重新飞行' : '▶ 开始模拟飞行' }}
            </button>

            <button
              v-else-if="store.simProgress >= 100"
              @click="store.recomputeProgressToIndex(0); localPreviewIndex = 0"
              class="py-2 rounded text-xs font-medium bg-sky-700 text-white hover:bg-sky-600 transition col-span-2"
            >
              🔄 重置并重新飞行
            </button>
          </div>

          <!-- Pre-flight resume picker (always visible when there are waypoints) -->
          <div
            v-if="store.waypoints.length >= 2 && !store.isSimulating && store.simProgress < 100"
            class="bg-slate-900 rounded p-2 space-y-2"
          >
            <div class="flex justify-between items-center">
              <span class="text-[10px] text-slate-400">选择起点航点：</span>
              <span class="text-[10px] text-sky-400">
                预飞 #{{ localPreviewIndex + 1 }}
              </span>
            </div>
            <input
              type="range"
              :min="0"
              :max="Math.max(0, store.waypoints.length - 1)"
              v-model.number="localPreviewIndex"
              class="w-full"
            />
            <div class="flex justify-between text-[10px]">
              <span class="text-slate-500">WP1 (起点)</span>
              <span class="text-sky-300 font-bold">
                #{{ localPreviewIndex + 1 }} / {{ store.waypoints.length }}
              </span>
              <span class="text-slate-500">WP{{ store.waypoints.length }} (终点)</span>
            </div>
            <div v-if="localPreviewIndex > 0 && previewStats.totalDistance > 0" class="grid grid-cols-3 gap-1 text-[10px] pt-1 border-t border-slate-700">
              <div class="text-slate-400">
                已飞: <span class="text-emerald-400">{{ (store.totalDistance / 1000 - previewStats.totalDistance / 1000).toFixed(2) }}km</span>
              </div>
              <div class="text-slate-400">
                剩余: <span class="text-amber-400">{{ (previewStats.totalDistance / 1000).toFixed(2) }}km</span>
              </div>
              <div class="text-slate-400">
                耗电: <span class="text-purple-400">{{ previewStats.batteryUsage.toFixed(0) }}%</span>
              </div>
            </div>
          </div>

          <!-- Resume from specific waypoint picker (interrupt mode) -->
          <div v-if="showResumePicker && store.isInterrupted" class="bg-slate-900 rounded p-2 space-y-2 border border-red-900/50">
            <div class="flex justify-between items-center">
              <span class="text-[10px] text-slate-400">选择从第几个航点恢复飞行：</span>
              <button
                @click="showResumePicker = false"
                class="text-[10px] text-slate-500 hover:text-slate-300"
              >
                ✕
              </button>
            </div>
            <input
              type="range"
              :min="0"
              :max="Math.max(0, store.waypoints.length - 1)"
              v-model.number="localPreviewIndex"
              class="w-full"
            />
            <div class="flex justify-between text-[10px]">
              <span class="text-slate-500">WP1</span>
              <span class="text-sky-300 font-bold">
                #{{ localPreviewIndex + 1 }} / {{ store.waypoints.length }}
              </span>
              <span class="text-slate-500">WP{{ store.waypoints.length }}</span>
            </div>
            <div v-if="localPreviewIndex > 0" class="grid grid-cols-3 gap-1 text-[10px] pt-1 border-t border-slate-700">
              <div class="text-slate-400">
                已飞: <span class="text-emerald-400">{{ ((store.totalDistance - previewStats.totalDistance) / 1000).toFixed(2) }}km</span>
              </div>
              <div class="text-slate-400">
                剩余: <span class="text-amber-400">{{ (previewStats.totalDistance / 1000).toFixed(2) }}km</span>
              </div>
              <div class="text-slate-400">
                余电: <span class="text-purple-400">{{ (100 - previewStats.batteryUsage).toFixed(0) }}%</span>
              </div>
            </div>
            <button
              @click="handleResumeFromPicker"
              :disabled="store.waypoints.length < 2"
              class="w-full py-1.5 rounded text-[10px] font-medium bg-emerald-700 text-white hover:bg-emerald-600 disabled:opacity-40 transition"
            >
              ✅ 从 #{{ localPreviewIndex + 1 }} 航点恢复飞行
            </button>
          </div>

          <!-- Progress bar -->
          <div v-if="store.isSimulating || store.simProgress > 0" class="space-y-1">
            <div class="flex justify-between text-[10px] text-slate-400">
              <span>模拟进度</span>
              <span>{{ store.simProgress.toFixed(0) }}%</span>
            </div>
            <div class="w-full bg-slate-700 rounded-full h-2">
              <div
                class="h-2 rounded-full transition-all"
                :class="{
                  'bg-amber-500': store.isSimulating,
                  'bg-red-500': store.isInterrupted,
                  'bg-emerald-500': !store.isSimulating && !store.isInterrupted && store.simProgress >= 100,
                  'bg-sky-500': !store.isSimulating && !store.isInterrupted && store.simProgress < 100,
                }"
                :style="{ width: store.simProgress + '%' }"
              />
            </div>
            <div v-if="store.isInterrupted" class="text-[10px] text-red-400 text-center pt-1">
              ⚠ 飞行已中断，可选择恢复或从某航点续飞
            </div>
          </div>

          <button
            @click="store.clearRoute()"
            class="w-full py-2 rounded text-xs font-medium bg-red-800 text-white hover:bg-red-700 transition"
          >
            🗑 清除航线
          </button>
        </div>

        <!-- Checkpoints history -->
        <div class="bg-slate-800 rounded-lg p-3 space-y-2">
          <div class="flex items-center justify-between">
            <h3 class="text-xs font-semibold text-slate-300">💾 断点历史</h3>
            <button
              v-if="store.hasCheckpoints"
              @click="showCheckpointList = !showCheckpointList"
              class="text-[10px] text-sky-400 hover:text-sky-300 transition"
            >
              {{ showCheckpointList ? '收起' : `查看(${store.checkpoints.length})` }}
            </button>
            <span v-else class="text-[10px] text-slate-500">暂无</span>
          </div>
          <div v-if="showCheckpointList && store.hasCheckpoints" class="space-y-1 max-h-[200px] overflow-y-auto">
            <div
              v-for="cp in store.checkpoints"
              :key="cp.id"
              class="bg-slate-900 rounded p-2 space-y-1 border border-slate-700"
            >
              <div class="flex justify-between items-center">
                <span class="text-[10px] text-slate-400">
                  {{ formatCPDate(cp.createdAt) }} {{ formatCPTime(cp.createdAt) }}
                </span>
                <button
                  @click="store.deleteCheckpoint(cp.id)"
                  class="text-[10px] text-red-400 hover:text-red-300 transition"
                >
                  删除
                </button>
              </div>
              <div class="grid grid-cols-2 gap-1 text-[10px]">
                <div class="text-slate-500">
                  中断航点: <span class="text-sky-300">#{{ cp.interruptedAtWaypointIndex + 1 }}</span>
                </div>
                <div class="text-slate-500">
                  进度: <span class="text-amber-300">{{ ((cp.progress.flownDistance / (cp.totalStats.totalDistance || 1)) * 100).toFixed(0) }}%</span>
                </div>
                <div class="text-slate-500">
                  已飞: <span class="text-emerald-400">{{ (cp.progress.flownDistance / 1000).toFixed(2) }}km</span>
                </div>
                <div class="text-slate-500">
                  剩余: <span class="text-purple-400">{{ (cp.remainingStats.totalDistance / 1000).toFixed(2) }}km</span>
                </div>
              </div>
              <button
                @click="handleLoadCP(cp)"
                class="w-full py-1 rounded text-[10px] font-medium bg-sky-700 text-white hover:bg-sky-600 transition"
              >
                📥 加载此断点
              </button>
            </div>
          </div>
        </div>

        <!-- Flight stats -->
        <FlightStats />
      </div>
    </div>
  </div>
</template>
