<template>
  <div class="wrap">
    <header class="app-header">
      <div class="h-left">
        <span class="logo" v-html="logoSvg"></span>
        <span class="conn">
          <span class="ci" :class="{ warn: !manager.barReachable }" v-html="connIcon"></span>
          {{ manager.barReachable ? 'Connected' : 'Disconnected' }}
          <span class="host">{{ connTarget }}</span>
          <button
            v-if="configWarning"
            type="button"
            class="conn-warn"
            :title="`${configWarning} — open Settings`"
            @click="activeTab = 'settings'"
          >
            <span v-html="icons.alert"></span>{{ configWarning }}
          </button>
        </span>
      </div>
      <div class="h-center">BUSY Bar Manager</div>
      <div class="h-right">
        <span v-if="battery.ok" class="batt"><span class="bico" :class="[{ live: manager.barReachable }, batteryTier]"><span class="bframe" v-html="batteryIcon"></span><span v-if="batteryCharging" class="bbolt" v-html="batteryLightning"></span></span>{{ battery.charge }}%</span>
        <button class="icon-btn" title="Toggle theme" @click="toggleTheme" v-html="themeIcon"></button>
      </div>
    </header>

    <MirrorPanel :bar-host="manager.barHost" :screen-owner="manager.screenOwner" :apps="manager.apps" />

    <div class="content-grid">
      <nav class="tabs" role="tablist">
        <div
          v-for="t in tabOptions"
          :key="t.value"
          class="tab"
          :class="{ active: activeTab === t.value }"
          role="tab"
          :aria-selected="activeTab === t.value"
          @click="activeTab = t.value"
        >
          <span v-html="activeTab === t.value && t.activeIcon ? t.activeIcon : t.icon"></span>
          <span class="tab-label">
            {{ t.label }}
            <span v-if="t.value === 'library' && (manager.library && manager.library.updatesAvailable) > 0" class="tab-dot"></span>
          </span>
        </div>
      </nav>

      <main>
        <AppsSection v-if="activeTab === 'apps'" @edit-variation="openVariationEditor" @open-logs="openLogs" />
        <LibrarySection v-else-if="activeTab === 'library'" />
        <SettingsSection v-else-if="activeTab === 'settings'" />
      </main>
    </div>

    <footer class="app-footer">
      <span>© {{ year }} <a href="https://github.com/maxswinkels" target="_blank" rel="noopener">Max Swinkels</a> · <a href="https://github.com/maxswinkels/busybar-manager/blob/main/LICENSE" target="_blank" rel="noopener">MIT license</a></span>
      <span>Unofficial project. "BUSY Bar" is a trademark of <a href="https://busy.app" target="_blank" rel="noopener">Flipper Devices</a>. Bundled fonts &amp; artwork © Flipper Devices (CC-BY 4.0 / SIL OFL 1.1).</span>
    </footer>

    <VariationEditor v-if="variationApp" :app="variationApp" @close="variationSlug = null" />
    <LogsPanel v-if="logsApp" :app="logsApp" @close="logsSlug = null" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { manager } from './composables/useManager'
import { icons, batteryIcons } from './icons'
import MirrorPanel from './components/MirrorPanel.vue'
import AppsSection from './components/AppsSection.vue'
import LibrarySection from './components/LibrarySection.vue'
import SettingsSection from './components/SettingsSection.vue'
import VariationEditor from './components/VariationEditor.vue'
import LogsPanel from './components/LogsPanel.vue'

const year = new Date().getFullYear()

// Firmware-format tab rail (replaces the old modal/popover navigation).
const TAB_OPTIONS = [
  { value: 'apps', label: 'Apps', icon: icons.play },
  { value: 'library', label: 'Library', icon: icons.library },
  { value: 'settings', label: 'Settings', icon: icons.settingsOutline, activeIcon: icons.settings },
]
const tabOptions = TAB_OPTIONS
// URL-routed tabs via the History API (no vue-router), same approach as
// busybar-emulator: /apps, /library and /settings each get their own path so
// they're linkable and survive a refresh; `/` falls back to apps.
const TAB_VALUES = TAB_OPTIONS.map((t) => t.value)
function tabFromUrl() {
  const p = location.pathname.replace(/^\//, '')
  if (TAB_VALUES.includes(p)) return p
  const h = location.hash.replace(/^#\/?/, '') // legacy #tab-style links
  return TAB_VALUES.includes(h) ? h : 'apps'
}
const activeTab = ref(tabFromUrl())
if (location.hash) history.replaceState(null, '', '/' + activeTab.value)
watch(activeTab, (v) => { if (location.pathname !== '/' + v) history.pushState(null, '', '/' + v) })
window.addEventListener('popstate', () => { activeTab.value = tabFromUrl() })

// Header connection chip. In cloud mode the bar's IP is meaningless (traffic
// goes to api.busy.app), so the chip names the transport instead of the host.
const cloudMode = computed(() => manager.barMode === 'cloud')
const connIcon = computed(() => {
  if (!manager.barReachable) return icons.alert
  return cloudMode.value ? icons.cloud : icons.usb
})
const connTarget = computed(() => (cloudMode.value ? 'BUSY cloud' : manager.barHost || '—'))

// Credential mistakes the manager can spot without waiting for a request to
// fail: the cloud transport needs a cloud token, and a bar on Wi-Fi (i.e. any
// host other than the fixed USB address) needs a bar token. Rendered as a
// click-through to Settings rather than a passive warning.
const USB_HOST = '10.0.4.20'
const configWarning = computed(() => {
  if (cloudMode.value) return manager.cloudTokenSet ? '' : 'Cloud token required'
  const host = (manager.barHost || '').trim()
  if (!host || host === USB_HOST || host.startsWith(`${USB_HOST}:`)) return ''
  return manager.tokenSet ? '' : 'Bar token required'
})

const variationSlug = ref(null)
const logsSlug = ref(null)
const variationApp = computed(() => manager.apps.find((a) => a.slug === variationSlug.value) || null)
const logsApp = computed(() => manager.apps.find((a) => a.slug === logsSlug.value) || null)
function openVariationEditor(slug) {
  variationSlug.value = slug
}
function openLogs(slug) {
  logsSlug.value = slug
}

// Same brand logo + light/dark theme convention as busybar-emulator's App.vue.
const logoSvg = ref('')
onMounted(() => {
  fetch('/brand/logo-white.svg')
    .then((r) => r.text())
    .then((t) => (logoSvg.value = t))
    .catch(() => {})
})

const root = document.documentElement
const saved = localStorage.getItem('bb-theme')
if (saved) root.setAttribute('data-theme', saved)
const themeState = ref(cur())
function cur() {
  return root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light')
}
const themeIcon = computed(() => (themeState.value === 'dark' ? icons.sun : icons.moon))
function toggleTheme() {
  const n = cur() === 'dark' ? 'light' : 'dark'
  root.setAttribute('data-theme', n)
  localStorage.setItem('bb-theme', n)
  themeState.value = n
}

// Header battery indicator, parity with busybar-emulator's App.vue: poll
// GET /api/status every 30s via the manager's existing generic bar-proxy
// (works against the real firmware and the emulator alike — both expose
// { power: { state, battery_charge } }). Only rendered when the bar is
// reachable AND the poll actually returned a usable reading; any other
// state (unreachable, non-2xx, malformed body) just hides it — no
// placeholder needed, "no data" isn't worth a UI treatment of its own.
const battery = reactive({ charge: 0, state: 'discharging', ok: false })
let batteryTimer = null
async function pollBattery() {
  if (!manager.barReachable) {
    battery.ok = false
    return
  }
  try {
    const r = await fetch('/api/status')
    if (!r.ok) {
      battery.ok = false
      return
    }
    const j = await r.json().catch(() => null)
    const p = j && j.power
    if (!p || typeof p.battery_charge !== 'number') {
      battery.ok = false
      return
    }
    battery.charge = p.battery_charge
    battery.state = p.state || 'discharging'
    battery.ok = true
  } catch (_) {
    battery.ok = false
  }
}
onMounted(() => {
  pollBattery()
  batteryTimer = setInterval(pollBattery, 30000)
})
onBeforeUnmount(() => {
  if (batteryTimer) clearInterval(batteryTimer)
})
// Re-poll promptly when the bar flips reachable again, rather than waiting
// out the rest of a stale 30s cycle before the indicator can reappear.
watch(
  () => manager.barReachable,
  (reachable) => {
    if (reachable) pollBattery()
    else battery.ok = false
  }
)

// Same selection as busybar-emulator's App.vue / the firmware web app's
// BatteryIndicator component.
const batteryIcon = computed(() => {
  const c = battery.charge ?? 0
  const st = battery.state ?? ''
  return st === 'charging'
    ? batteryIcons.charging
    : st === 'charged' || c >= 95
    ? batteryIcons.full
    : c >= 66
    ? batteryIcons.discharging1
    : c >= 33
    ? batteryIcons.discharging2
    : c >= 0
    ? batteryIcons.discharging3
    : batteryIcons.error
})
// Charging state overlays a dedicated lightning bolt on top of the base icon,
// exactly like the firmware's BatteryIndicator (base i-busy-battery-charging +
// absolutely-positioned i-busy-charging-lightning). The bolt stays green
// regardless of the charge tint below.
const batteryCharging = computed(() => (battery.state ?? '') === 'charging')
const batteryLightning = batteryIcons.chargingLightning
// Tint: green above 50%, orange from 50%, red from 20% — same tiers as the emulator.
const batteryTier = computed(() => {
  const c = battery.charge ?? 0
  return c <= 20 ? 'low' : c <= 50 ? 'mid' : 'high'
})
</script>
