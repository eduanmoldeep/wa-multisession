<script>
  import { createEventDispatcher } from 'svelte';
  import * as api from '../lib/api.js';

  export let instance = { id: '', status: '', qr: null, linkedAccount: null, linkedAccountChanged: false, previousLinkedAccount: null };
  export let canDelete = true;

  const dispatch = createEventDispatcher();

  let qrVisible = true;
  let apiKey = '';
  let apiKeyVisible = false;
  let apiKeyLoading = false;
  let sendTo = '';
  let sendMessage = '';
  let sendLoading = false;
  let sendError = '';
  let sendSuccess = false;
  let toast = '';
  function showToast(text) {
    toast = text;
    setTimeout(() => (toast = ''), 2500);
  }

  function toggleQr() {
    qrVisible = !qrVisible;
  }

  async function loadAndShowApiKey() {
    if (apiKey && apiKeyVisible) return;
    apiKeyLoading = true;
    apiKey = '';
    try {
      apiKey = await api.getInstanceApiKey(instance.id);
      apiKeyVisible = true;
    } catch (e) {
      apiKey = '';
    } finally {
      apiKeyLoading = false;
    }
  }

  async function copyApiKey() {
    if (!apiKey) await loadAndShowApiKey();
    if (apiKey) {
      await navigator.clipboard.writeText(apiKey);
      showToast('API key copied');
    }
  }

  async function regenerateKey() {
    if (!confirm('Regenerate API key? The old key will stop working.')) return;
    try {
      apiKey = await api.regenerateInstanceApiKey(instance.id);
      apiKeyVisible = true;
      showToast('New API key generated');
    } catch (e) {
      showToast(e.message || 'Failed to regenerate');
    }
  }

  async function onSendMessage() {
    const to = sendTo.trim();
    const msg = sendMessage.trim();
    if (!to || !msg) return;
    sendLoading = true;
    sendError = '';
    sendSuccess = false;
    try {
      await api.sendInstanceMessage(instance.id, to, msg);
      sendSuccess = true;
      sendMessage = '';
      setTimeout(() => (sendSuccess = false), 3000);
    } catch (e) {
      sendError = e.message || 'Failed to send';
    } finally {
      sendLoading = false;
    }
  }

  function onDelete() {
    if (confirm(`Delete instance ${instance.id}?`)) {
      dispatch('delete', { instanceId: instance.id });
    }
  }

  function openMessageLog() {
    dispatch('openMessageLog', { instanceId: instance.id });
  }

  $: hasQr = instance.qr != null && instance.qr !== '';
  $: cardClass = instance.status === 'ready' ? 'active' : instance.status === 'qr_ready' ? 'pending' : '';
  $: statusClass = `status-${instance.status}`;
  $: isReady = instance.status === 'ready';
  $: apiKeyInputId = `api-key-input-${instance.id}`;
  $: linkedAccountLabel = instance.linkedAccount?.label || instance.linkedAccount?.name || instance.linkedAccount?.number || '';
  $: previousLinkedAccountLabel =
    instance.previousLinkedAccount?.label || instance.previousLinkedAccount?.name || instance.previousLinkedAccount?.number || '';
</script>

<div class="instance-card {cardClass}">
  <div class="instance-header">
    <div class="instance-id">{instance.id}</div>
    <span class="status-badge {statusClass}">{instance.status.replace('_', ' ')}</span>
  </div>

  {#if hasQr}
    <div class="instance-actions" style="margin-top: 10px; margin-bottom: 0;">
      <button type="button" class="secondary" on:click={toggleQr}>
        {qrVisible ? 'Hide QR' : 'Show QR'}
      </button>
    </div>
    {#if qrVisible}
      <div class="qr-container">
        <img src={instance.qr} alt="QR Code" />
        <p style="margin-top: 10px; color: #888; font-size: 14px;">Scan with WhatsApp</p>
      </div>
    {/if}
  {/if}

  <div class="instance-api-section">
    <h4 style="font-size: 13px; color: #555; margin-bottom: 8px;">Linked WhatsApp</h4>
    {#if linkedAccountLabel}
      <p class="linked-account-value">{linkedAccountLabel}</p>
      {#if instance.linkedAccountChanged && previousLinkedAccountLabel}
        <p class="linked-account-warning">
          This instance was re-linked from {previousLinkedAccountLabel}. Older message log entries may belong to the previous account.
        </p>
      {/if}
    {:else}
      <p class="linked-account-empty">No linked account detected yet. Scan the QR code and wait for the instance to become ready.</p>
    {/if}
  </div>

  <!-- API key: always visible for every instance -->
  <div class="instance-api-section">
    <h4 style="font-size: 13px; color: #555; margin-bottom: 8px;">View API key</h4>
    <p style="font-size: 11px; color: #888; margin-bottom: 8px;">Use header <code>X-API-Key: &lt;key&gt;</code> for instance API calls.</p>
    <div class="api-key-actions">
      <label class="api-key-label" for={apiKeyInputId}>View / modify key</label>
      <div class="api-key-row">
        <input
          id={apiKeyInputId}
          type="text"
          class="api-key-input"
          readonly
          value={apiKeyVisible ? apiKey : ''}
          placeholder={apiKeyLoading ? 'Loading…' : 'Click Reveal to see key'}
        />
        <button
          type="button"
          class="secondary api-key-btn"
          on:click={() => { if (apiKeyVisible) apiKeyVisible = false; else loadAndShowApiKey(); }}
          disabled={apiKeyLoading}
          title={apiKeyVisible ? 'Hide API key' : 'Reveal API key'}
        >
          {apiKeyLoading ? '…' : apiKeyVisible ? 'Hide' : 'Reveal'}
        </button>
        <button type="button" class="secondary api-key-btn" on:click={copyApiKey} title="Copy to clipboard">
          Copy
        </button>
        <button type="button" class="secondary api-key-btn" on:click={regenerateKey} title="Generate new key (old key will stop working)">
          Regenerate
        </button>
      </div>
    </div>
    {#if toast}
      <p class="toast">{toast}</p>
    {/if}
  </div>

  {#if instance.status === 'ready'}
    <p style="color: #10b981; font-weight: 600; text-align: center; margin: 15px 0;">✓ Connected</p>

    <div class="instance-api-section">
      <h4 style="font-size: 13px; color: #555; margin-bottom: 8px;">Send message</h4>
      <div class="send-form">
        <input type="text" bind:value={sendTo} placeholder="Phone (e.g. 919876543210)" style="padding: 6px 10px; font-size: 13px;" />
        <textarea bind:value={sendMessage} placeholder="Message" rows="2" style="padding: 6px 10px; font-size: 13px; resize: vertical;"></textarea>
        <button type="button" on:click={onSendMessage} disabled={sendLoading || !sendTo.trim() || !sendMessage.trim()}>
          {sendLoading ? 'Sending…' : 'Send'}
        </button>
      </div>
      {#if sendError}
        <p class="send-error">{sendError}</p>
      {/if}
      {#if sendSuccess}
        <p class="send-success">Message sent.</p>
      {/if}
    </div>
  {/if}

  <div class="instance-actions">
    <button type="button" class="secondary" on:click={openMessageLog} title="View incoming message log">
      View message log
    </button>
    {#if canDelete}
      <button type="button" class="danger" on:click={onDelete}>Delete</button>
    {/if}
  </div>
</div>

<style>
  .instance-api-section {
    margin: 12px 0;
    padding: 10px;
    background: #fff;
    border-radius: 8px;
    border: 1px solid #e0e0e0;
  }
  .api-key-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .api-key-label {
    font-size: 12px;
    color: #555;
    font-weight: 500;
  }
  .api-key-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .api-key-input {
    flex: 1;
    min-width: 140px;
    font-size: 12px;
    font-family: ui-monospace, monospace;
    padding: 8px 10px;
    background: #f8f9fa;
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    color: #333;
  }
  .api-key-input::placeholder {
    color: #999;
  }
  .api-key-btn {
    padding: 6px 12px;
    font-size: 12px;
  }
  .send-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .send-form input,
  .send-form textarea {
    width: 100%;
    box-sizing: border-box;
  }
  .send-error {
    color: #b91c1c;
    font-size: 13px;
    margin-top: 6px;
  }
  .send-success {
    color: #059669;
    font-size: 13px;
    margin-top: 6px;
  }
  .linked-account-value {
    color: #111827;
    font-size: 13px;
    font-weight: 600;
    margin: 0;
  }
  .linked-account-empty {
    color: #6b7280;
    font-size: 12px;
    margin: 0;
  }
  .linked-account-warning {
    color: #9a3412;
    background: #fff7ed;
    border: 1px solid #fdba74;
    border-radius: 6px;
    font-size: 12px;
    margin: 8px 0 0;
    padding: 8px 10px;
  }
  .toast {
    font-size: 12px;
    color: #059669;
    margin-top: 6px;
  }
</style>
