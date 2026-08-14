<template>
  <section class="section-card">
    <div class="sc-head">
      <div class="sc-head-inner">
        <div class="sc-title-wrap">
          <span class="sc-icon" v-html="icons.play"></span>
          <div>
            <div class="sc-title">Apps</div>
          </div>
        </div>
        <div class="sc-actions">
          <button
            v-if="cleanup.counts.removable"
            class="pill sm danger"
            :title="`${cleanup.counts.removable} stale or duplicate entries`"
            @click="showCleanup = !showCleanup"
            v-html="withLabel(icons.trashFill, `Clean up (${cleanup.counts.removable})`)"
          ></button>
          <span class="status-chip" :class="manager.connected ? 'ok' : ''">
            {{ manager.connected ? 'LIVE' : 'not connected' }}
          </span>
        </div>
      </div>
    </div>
    <div class="sc-body">
      <CleanupPanel v-if="showCleanup" @close="showCleanup = false" />
      <AppsGrid
        :apps="manager.apps"
        :screen-owner="manager.screenOwner"
        @edit-variation="$emit('edit-variation', $event)"
        @open-logs="$emit('open-logs', $event)"
      />
    </div>
  </section>
</template>

<script setup>
import { ref, watch } from 'vue'
import { cleanup, manager } from '../composables/useManager'
import { icons } from '../icons'
import AppsGrid from './AppsGrid.vue'
import CleanupPanel from './CleanupPanel.vue'

defineEmits(['edit-variation', 'open-logs'])

const showCleanup = ref(false)
// Close it once there is nothing left to clean (the badge disappears too).
watch(
  () => cleanup.counts.removable,
  (n) => {
    if (!n) showCleanup.value = false
  }
)

function withLabel(svg, label) {
  return `${svg}<span>${label}</span>`
}
</script>
