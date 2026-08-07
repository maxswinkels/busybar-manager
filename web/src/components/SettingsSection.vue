<template>
  <section class="section-card">
    <div class="sc-head">
      <div class="sc-head-inner">
        <div class="sc-title-wrap">
          <span class="sc-icon" v-html="icons.settings"></span>
          <div>
            <div class="sc-title">Settings</div>
            <div class="sc-subtitle">Connection settings for this installation.</div>
          </div>
        </div>
      </div>
    </div>
    <div class="sc-body">
      <div class="row-block">
        <div class="field" style="margin-bottom:0">
          <label>Connection</label>
          <div class="seg" role="group" aria-label="Connection mode">
            <button
              type="button"
              class="seg-btn"
              :class="{ active: form.barMode === 'local' }"
              :aria-pressed="form.barMode === 'local'"
              @click="form.barMode = 'local'"
            >
              Local network
            </button>
            <button
              type="button"
              class="seg-btn"
              :class="{ active: form.barMode === 'cloud' }"
              :aria-pressed="form.barMode === 'cloud'"
              @click="form.barMode = 'cloud'"
            >
              BUSY cloud
            </button>
          </div>
          <span class="hint">
            {{
              form.barMode === 'cloud'
                ? 'Requests go to https://api.busy.app/busybar/… with your account token. The bar does not need to be on this network.'
                : 'Requests go straight to the bar over USB or Wi-Fi.'
            }}
          </span>
        </div>
      </div>

      <template v-if="form.barMode === 'local'">
        <div class="row-block">
          <div class="field" style="margin-bottom:0">
            <label for="barHost">Bar host</label>
            <input id="barHost" type="text" v-model="form.barHost" placeholder="10.0.4.20" />
            <span class="hint">Over USB the bar is always 10.0.4.20; enter an IP or host:port for Wi-Fi or the emulator.</span>
          </div>
        </div>
        <div class="row-block">
          <div class="field" style="margin-bottom:0">
            <label for="barToken">Bar token</label>
            <div class="token-row">
              <div class="token-input">
                <input
                  id="barToken"
                  :type="showToken ? 'text' : 'password'"
                  v-model="form.barToken"
                  autocomplete="off"
                  :placeholder="manager.tokenSet ? '•••••••• (saved)' : '12345678'"
                />
                <button
                  type="button"
                  class="token-reveal"
                  :aria-label="showToken ? 'Hide token' : 'Show token'"
                  :aria-pressed="showToken"
                  :title="showToken ? 'Hide token' : 'Show token'"
                  @click="showToken = !showToken"
                  v-html="showToken ? icons.eyeOff : icons.eye"
                ></button>
              </div>
              <button v-if="manager.tokenSet" class="pill sm" :disabled="saving" @click="clearToken('token')">Clear</button>
            </div>
            <span class="hint">
              {{
                manager.tokenSet
                  ? 'Token set. Leave blank to keep it, or type a new one to replace it.'
                  : 'For Wi-Fi, the bar requires a token to connect.'
              }}
            </span>
          </div>
        </div>
      </template>

      <div v-else class="row-block">
        <div class="field" style="margin-bottom:0">
          <label for="cloudToken">Cloud token</label>
          <div class="token-row">
            <div class="token-input">
              <input
                id="cloudToken"
                :type="showCloudToken ? 'text' : 'password'"
                v-model="form.cloudToken"
                autocomplete="off"
                :placeholder="manager.cloudTokenSet ? '•••••••• (saved)' : 'BUSY account token'"
              />
              <button
                type="button"
                class="token-reveal"
                :aria-label="showCloudToken ? 'Hide token' : 'Show token'"
                :aria-pressed="showCloudToken"
                :title="showCloudToken ? 'Hide token' : 'Show token'"
                @click="showCloudToken = !showCloudToken"
                v-html="showCloudToken ? icons.eyeOff : icons.eye"
              ></button>
            </div>
            <button v-if="manager.cloudTokenSet" class="pill sm" :disabled="saving" @click="clearToken('cloudToken')">Clear</button>
          </div>
          <span class="hint">
            {{
              manager.cloudTokenSet
                ? 'Token set. Leave blank to keep it, or type a new one to replace it.'
                : 'Sent as Authorization: Bearer. This is your BUSY account token — not the Wi-Fi bar token.'
            }}
            Create one at
            <a href="https://cloud.busy.app/api-tokens" target="_blank" rel="noopener">cloud.busy.app/api-tokens</a>.
          </span>
        </div>
      </div>

      <div class="settings-foot">
        <button class="pill brand" :disabled="saving" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
      <p v-if="error" class="hint" style="color:var(--error)">{{ error }}</p>
    </div>
  </section>
</template>

<script setup>
import { reactive, ref, watch } from 'vue'
import { manager, updateSettings } from '../composables/useManager'
import { icons } from '../icons'

const saving = ref(false)
const error = ref('')
const showToken = ref(false)
const showCloudToken = ref(false)
const form = reactive({ barMode: 'local', barHost: '', barToken: '', cloudToken: '' })

// Seed once from current state when this tab mounts — no live watch, the SSE
// state stream would clobber whatever Max is mid-typing. Neither token is ever
// sent to the frontend (state only carries `tokenSet` / `cloudTokenSet`), so
// those fields always start empty: blank on save = keep the stored token.
form.barMode = manager.barMode || 'local'
form.barHost = manager.barHost || ''

// A refresh straight onto this tab mounts us before the first state frame
// lands, so the seed above sees ''. Seed again when the real value arrives —
// once, and only while the field is still untouched, never over live typing.
if (!form.barHost) {
  const stop = watch(
    () => [manager.barHost, manager.barMode],
    ([host, mode]) => {
      if (!host) return
      if (!form.barHost) {
        form.barHost = host
        form.barMode = mode || 'local'
      }
      stop()
    }
  )
}

async function save() {
  const token = form.barToken.trim()
  const cloudToken = form.cloudToken.trim()
  saving.value = true
  error.value = ''
  // Only the active mode's fields are sent; the other mode's stored values
  // stay untouched server-side, so toggling back keeps working.
  const patch = { barMode: form.barMode }
  if (form.barMode === 'local') {
    patch.barHost = form.barHost.trim()
    if (token) patch.token = token
  } else if (cloudToken) {
    patch.cloudToken = cloudToken
  }
  const res = await updateSettings(patch)
  saving.value = false
  if (!res.ok) {
    error.value = res.json?.error || `Save failed (${res.status})`
    return
  }
  // never leave a secret sitting in the field (revealed, at that) after a save
  form.barToken = ''
  form.cloudToken = ''
  showToken.value = false
  showCloudToken.value = false
}

async function clearToken(key) {
  saving.value = true
  error.value = ''
  const res = await updateSettings({ [key]: '' })
  saving.value = false
  if (!res.ok) {
    error.value = res.json?.error || `Clear failed (${res.status})`
    return
  }
  if (key === 'token') {
    form.barToken = ''
    showToken.value = false
  } else {
    form.cloudToken = ''
    showCloudToken.value = false
  }
}
</script>
