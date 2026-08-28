<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal glass wide">
      <div class="modal-head">
        <h2 class="card-title" style="margin:0">
          <span class="badge" v-html="icons.edit"></span>Variation — {{ app.name }}
        </h2>
        <button class="modal-close" @click="$emit('close')" v-html="icons.close"></button>
      </div>

      <div class="field">
        <label for="var-select">Edit variation</label>
        <select id="var-select" class="select" v-model="editingName" @change="loadFromVariation">
          <option v-for="name in variationNames" :key="name" :value="name">
            {{ name }}{{ name === app.variation ? ' (active)' : '' }}
          </option>
        </select>
      </div>

      <div class="subhead">Arguments</div>
      <div v-if="!optionFields.length" class="empty-note">This app has no configurable options.</div>
      <div class="form-grid">
        <div class="field" v-for="opt in optionFields" :key="opt.flag">
          <label :for="'opt-' + opt.flag">{{ opt.flag }}</label>
          <select v-if="opt.choices && opt.choices.length" :id="'opt-' + opt.flag" class="select" v-model="formArgs[opt.flag]">
            <option value="">(default: {{ opt.default ?? '—' }})</option>
            <option v-for="c in opt.choices" :key="c" :value="c">{{ c }}</option>
          </select>
          <label v-else-if="opt.type === 'bool'" class="check-row" :for="'opt-' + opt.flag">
            <input :id="'opt-' + opt.flag" type="checkbox" v-model="formArgs[opt.flag]" />
            enable
          </label>
          <div v-else-if="isRange(opt)" class="range-field">
            <div class="range-row">
              <input
                class="range"
                type="range"
                :aria-label="opt.flag"
                :min="opt.min"
                :max="opt.max"
                :step="opt.step ?? 'any'"
                :value="sliderValue(opt)"
                :style="{ '--fill': fillPct(opt) + '%' }"
                @input="formArgs[opt.flag] = $event.target.value"
              />
              <input
                :id="'opt-' + opt.flag"
                class="range-val"
                type="number"
                :min="opt.min"
                :max="opt.max"
                :step="opt.step ?? 'any'"
                :placeholder="String(opt.default ?? opt.min)"
                v-model="formArgs[opt.flag]"
              />
            </div>
            <div class="range-ends"><span>{{ opt.min }}</span><span>{{ opt.max }}</span></div>
          </div>
          <input
            v-else
            :id="'opt-' + opt.flag"
            type="text"
            :placeholder="String(opt.default ?? opt.meta ?? '')"
            v-model="formArgs[opt.flag]"
          />
          <span v-if="opt.help" class="hint">{{ opt.help }}</span>
        </div>
      </div>

      <div class="subhead">Environment variables</div>
      <div v-if="envFields.length" class="form-grid">
        <div class="field" v-for="spec in envFields" :key="spec.key">
          <label :for="'env-' + spec.key">{{ spec.key }}</label>
          <input
            :id="'env-' + spec.key"
            type="text"
            :placeholder="spec.example || 'value'"
            v-model="envValues[spec.key]"
          />
          <span v-if="spec.help" class="hint">{{ spec.help }}</span>
        </div>
      </div>
      <p v-if="envFields.length" class="hint">Discovered from this app's .env.example</p>

      <div v-for="(row, i) in envRows" :key="i" class="kv-row">
        <input type="text" placeholder="KEY" v-model="row.key" />
        <input type="text" placeholder="value" v-model="row.value" />
        <button class="pill sm icon-only" title="Remove" @click="envRows.splice(i, 1)" v-html="icons.trash"></button>
      </div>
      <button class="pill sm kv-add" @click="envRows.push({ key: '', value: '' })" v-html="withLabel(icons.plus, 'Add variable')"></button>

      <div class="subhead">Other</div>
      <div class="form-grid">
        <div class="field">
          <label for="priority">Priority override (1–100)</label>
          <input id="priority" type="number" min="1" max="100" placeholder="app's own priority" v-model="priorityInput" />
        </div>
        <div class="field">
          <label for="saveas">Save as</label>
          <input id="saveas" type="text" v-model="saveAsName" placeholder="variation name" />
        </div>
      </div>

      <p v-if="error" class="hint" style="color:var(--error)">{{ error }}</p>

      <div class="modal-foot">
        <button
          class="pill danger"
          :disabled="busy || variationNames.length <= 1"
          title="Delete variation"
          @click="onDelete"
          v-html="withLabel(icons.trashFill, 'Delete')"
        ></button>
        <button class="pill" :disabled="busy || editingName === app.variation" @click="onSelect">
          Select &amp; restart
        </button>
        <button class="pill brand" :disabled="busy || !saveAsName.trim()" @click="onSave" v-html="withLabel(icons.save, 'Save')"></button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'

const onKeydown = (e) => { if (e.key === 'Escape') emit('close') }
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
import { putVariation, deleteVariation, setVariation } from '../composables/useManager'
import { icons } from '../icons'

const props = defineProps({ app: { type: Object, required: true } })
const emit = defineEmits(['close'])

const busy = ref(false)
const error = ref('')
const editingName = ref(props.app.variation || 'default')
const formArgs = reactive({})
// Env vars the app declares in its .env.example get a fixed field (name not
// editable); anything else stored on the variation stays a free KEY/value row.
const envValues = reactive({})
const envRows = ref([])
const priorityInput = ref('')
const saveAsName = ref(editingName.value)

const optionFields = computed(() => (props.app.options || []).filter((o) => o.flag !== '--host'))
const envFields = computed(() => props.app.envSpec || [])
const variationNames = computed(() => Object.keys(props.app.variations || { default: {} }))

// An option argparse bounded ("--volume 0-100", or choices=range(...)) gets a
// slider. Blank still means "unset": the slider then sits on the app's own
// default and the number field shows it as a placeholder.
function isRange(opt) {
  return (opt.type === 'int' || opt.type === 'float') && Number.isFinite(opt.min) && Number.isFinite(opt.max)
}

function sliderValue(opt) {
  const raw = formArgs[opt.flag]
  const n = Number(raw === '' || raw === undefined || raw === null ? opt.default : raw)
  if (!Number.isFinite(n)) return opt.min
  return Math.min(opt.max, Math.max(opt.min, n))
}

// The track paints its own filled part (CSS cannot read a range input value).
function fillPct(opt) {
  return ((sliderValue(opt) - opt.min) / (opt.max - opt.min)) * 100
}

function withLabel(svg, label) {
  return `${svg}<span>${label}</span>`
}

function loadFromVariation() {
  const v = (props.app.variations || {})[editingName.value] || { args: {}, env: {}, priority: null }
  for (const key of Object.keys(formArgs)) delete formArgs[key]
  for (const opt of optionFields.value) {
    const raw = v.args ? v.args[opt.flag] : undefined
    if (opt.type === 'bool') formArgs[opt.flag] = raw === true || raw === 'true'
    else formArgs[opt.flag] = raw !== undefined ? String(raw) : ''
  }
  const declared = new Set(envFields.value.map((s) => s.key))
  for (const key of Object.keys(envValues)) delete envValues[key]
  for (const spec of envFields.value) {
    const raw = v.env ? v.env[spec.key] : undefined
    envValues[spec.key] = raw === undefined ? '' : String(raw)
  }
  envRows.value = Object.entries(v.env || {})
    .filter(([key]) => !declared.has(key))
    .map(([key, value]) => ({ key, value: String(value) }))
  priorityInput.value = v.priority === null || v.priority === undefined ? '' : String(v.priority)
  saveAsName.value = editingName.value
  error.value = ''
}
loadFromVariation()

watch(
  () => props.app.slug,
  () => {
    editingName.value = props.app.variation || 'default'
    loadFromVariation()
  }
)

// A rescan can surface .env.example keys after the modal is already open
// (first scan of a freshly installed app). Fill those in without touching a
// field that is being typed into.
watch(envFields, (specs) => {
  const v = (props.app.variations || {})[editingName.value] || {}
  for (const spec of specs) {
    if (envValues[spec.key] !== undefined) continue
    const raw = v.env ? v.env[spec.key] : undefined
    envValues[spec.key] = raw === undefined ? '' : String(raw)
  }
})

function buildArgs() {
  const args = {}
  for (const opt of optionFields.value) {
    const val = formArgs[opt.flag]
    if (opt.type === 'bool') {
      if (val) args[opt.flag] = true
    } else if (val !== '' && val !== undefined && val !== null) {
      args[opt.flag] = val
    }
  }
  return args
}

function buildEnv() {
  const env = {}
  for (const row of envRows.value) {
    if (row.key.trim()) env[row.key.trim()] = row.value
  }
  // Declared fields win over a stray row with the same name, and a blank one
  // means "unset" — the example value is a placeholder, never a default.
  for (const spec of envFields.value) {
    const val = envValues[spec.key]
    if (val !== '' && val !== undefined && val !== null) env[spec.key] = val
    else delete env[spec.key]
  }
  return env
}

async function onSave() {
  const name = saveAsName.value.trim()
  if (!name) return
  busy.value = true
  error.value = ''
  const priority = priorityInput.value === '' ? null : Number(priorityInput.value)
  const r = await putVariation(props.app.slug, name, { args: buildArgs(), env: buildEnv(), priority })
  busy.value = false
  if (!r.ok) {
    error.value = r.json?.error || `Save failed (${r.status})`
    return
  }
  editingName.value = name
}

async function onSelect() {
  busy.value = true
  error.value = ''
  const r = await setVariation(props.app.slug, editingName.value)
  busy.value = false
  if (!r.ok) error.value = r.json?.error || `Select failed (${r.status})`
}

async function onDelete() {
  busy.value = true
  error.value = ''
  const r = await deleteVariation(props.app.slug, editingName.value)
  busy.value = false
  if (!r.ok) {
    error.value = r.json?.error || `Delete failed (${r.status})`
    return
  }
  editingName.value = props.app.variation || 'default'
  loadFromVariation()
}
</script>
