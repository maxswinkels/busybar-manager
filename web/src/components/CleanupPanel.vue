<template>
  <div class="row-block cleanup-panel">
    <div class="rb-head">
      <div class="rb-title">Clean up installed apps</div>
      <div class="rb-hint">
        Leftover config entries and apps installed twice under a different folder name. Nothing is
        removed until you confirm.
      </div>
    </div>

    <!-- orphans: config entries whose folder is gone -->
    <div v-if="cleanup.orphans.length" class="cleanup-group">
      <div class="cleanup-group-title">Stale config entries <span class="rb-hint">— the app folder is gone</span></div>
      <label v-for="o in cleanup.orphans" :key="o.slug" class="check-row cleanup-item">
        <input type="checkbox" :value="o.slug" v-model="selected" :disabled="running" />
        <span class="cleanup-slug">{{ o.slug }}</span>
        <span class="chip missing">folder missing</span>
        <span v-if="o.hasSettings" class="hint">has custom settings</span>
      </label>
    </div>

    <!-- duplicates: same app under two slugs -->
    <div v-for="g in cleanup.duplicates" :key="g.id" class="cleanup-group">
      <div class="cleanup-group-title">
        Duplicate app
        <span class="rb-hint">— {{ g.keep }} and {{ g.remove.join(', ') }} are the same app</span>
      </div>

      <label v-if="g.confidence === 'certain'" class="check-row cleanup-item">
        <input type="checkbox" :value="g.remove[0]" v-model="selected" :disabled="running" />
        <span class="cleanup-slug">{{ g.remove.join(', ') }}</span>
        <span class="cleanup-arrow">→ keep {{ g.keep }}</span>
      </label>
      <div v-else class="cleanup-item review">
        <span class="cleanup-slug">{{ g.apps.map((a) => a.slug).join('  ·  ') }}</span>
        <span class="chip missing">needs review</span>
      </div>

      <div class="cleanup-detail">
        <span v-for="s in g.signals" :key="s" class="app-tag">{{ signalLabel(s) }}</span>
      </div>
      <p v-if="g.migrate" class="hint">
        Your settings ({{ describeArgs(g.migrate.from) }}) will be moved to <strong>{{ g.migrate.to }}</strong>.
      </p>
      <p v-if="g.reason" class="hint">{{ g.reason }} Remove the one you don't want from its app card.</p>
    </div>

    <p v-if="!cleanup.orphans.length && !cleanup.duplicates.length" class="empty-note">
      Nothing to clean up.
    </p>

    <!-- result of the last run -->
    <template v-if="result">
      <p v-for="s in result.skipped" :key="`sk-${s.slug}`" class="hint">
        {{ s.slug }}: skipped ({{ s.reason }}) — it was no longer stale by the time the server checked.
      </p>
      <p v-for="e in result.errors" :key="`er-${e.slug}`" class="hint" style="color:var(--error)">
        {{ e.slug }}: {{ e.error }}
      </p>
      <p v-if="resultSummary" class="hint">{{ resultSummary }}</p>
    </template>

    <div class="cleanup-foot">
      <button class="pill sm" :disabled="running" @click="$emit('close')">Cancel</button>
      <button
        class="pill sm danger"
        :disabled="running || !selected.length"
        @click="onRun"
        v-html="withLabel(icons.trashFill, buttonLabel)"
      ></button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { cleanup, manager, runCleanup } from '../composables/useManager'
import { icons } from '../icons'

defineEmits(['close'])

// Pre-checked = the server's auto-recommend set (`removable`). Review-only
// groups are never in it, so they can't be selected here at all.
const selected = ref(cleanup.removable.slice())
watch(
  () => cleanup.removable.join('|'),
  () => {
    selected.value = cleanup.removable.slice()
  }
)

const running = ref(false)
const result = ref(null)

const buttonLabel = computed(() => {
  if (running.value) return 'Removing…'
  if (confirming.value) return 'Sure?'
  const n = selected.value.length
  return `Remove ${n} item${n === 1 ? '' : 's'}`
})

const resultSummary = computed(() => {
  if (!result.value) return ''
  const { removed, migrated } = result.value
  if (!removed.length) return ''
  const parts = [`Removed ${removed.length} item${removed.length === 1 ? '' : 's'}`]
  if (migrated.length) parts.push(`moved settings to ${migrated.map((m) => m.to).join(', ')}`)
  return parts.join(', ') + '.'
})

const SIGNAL_LABELS = {
  'same-repo': 'same repo',
  'identical-files': 'identical files',
  'normalized-slug': 'same slug',
  'same-name': 'same name',
}
function signalLabel(s) {
  return SIGNAL_LABELS[s] || s
}

// The args live in the app's own state entry — the cleanup report deliberately
// only names the variations, not their contents.
function describeArgs(slug) {
  const app = manager.apps.find((a) => a.slug === slug)
  const v = app && app.variations && app.variations[app.variation]
  const args = (v && v.args) || {}
  const keys = Object.keys(args)
  if (!keys.length) return 'its settings'
  const shown = keys.slice(0, 2).map((k) => `${k} ${args[k]}`)
  if (keys.length > 2) shown.push('…')
  return shown.join(', ')
}

function withLabel(svg, label) {
  return `${svg}<span>${label}</span>`
}

const confirming = ref(false)
async function onRun() {
  if (!confirming.value) {
    confirming.value = true
    setTimeout(() => {
      confirming.value = false
    }, 3000)
    return
  }
  confirming.value = false
  running.value = true
  result.value = null
  const r = await runCleanup(selected.value.slice())
  running.value = false
  if (r.ok) result.value = r.json
  else result.value = { removed: [], migrated: [], skipped: [], errors: [{ slug: '', error: r.json?.error || `Cleanup failed (${r.status})` }] }
}
</script>
