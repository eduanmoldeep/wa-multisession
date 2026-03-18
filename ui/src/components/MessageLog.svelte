<script>
  import { onMount, createEventDispatcher } from 'svelte';
  import * as api from '../lib/api.js';

  export let instanceId = '';
  export let newMessage = null; // when set (from WebSocket), append to list
  export let refreshToken = 0;

  const dispatch = createEventDispatcher();

  let messages = [];
  let loading = true;
  let error = '';
  let clearing = false;
  let lastRefreshToken = 0;
  let activeFilter = 'all';

  function formatTimestamp(msg) {
    const raw = msg?.timestamp ?? msg?.createdAt ?? null;
    if (!raw) return '';
    const date = new Date(Number(raw) * 1000);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString();
  }

  function getGroupLabel(msg) {
    if (msg?.messageKind !== 'group') return '';
    if (!msg?.groupName || msg.groupName === msg.senderDisplay) return '';
    return msg.groupName;
  }

  function getSenderNumber(msg) {
    return msg?.senderNumber ? `+${msg.senderNumber}` : '';
  }

  async function load() {
    if (!instanceId) return;
    loading = true;
    error = '';
    try {
      messages = await api.getInstanceMessages(instanceId);
    } catch (e) {
      error = e.message || 'Failed to load messages';
      messages = [];
    } finally {
      loading = false;
    }
  }

  function close() {
    dispatch('close');
  }

  async function clearLog() {
    if (!instanceId) return;
    if (!confirm(`Clear the message log for ${instanceId}?`)) return;
    clearing = true;
    error = '';
    try {
      await api.clearInstanceMessages(instanceId);
      messages = [];
    } catch (e) {
      error = e.message || 'Failed to clear messages';
    } finally {
      clearing = false;
    }
  }

  $: if (newMessage && instanceId) {
    const dup = messages.some((m) => m.messageId === newMessage.messageId);
    if (!dup) {
      messages = [
        {
          senderDisplay: newMessage.senderDisplay || newMessage.from || 'Unknown',
          body: newMessage.body || '',
          messageId: newMessage.messageId,
          timestamp: newMessage.timestamp,
          senderNumber: newMessage.senderNumber || '',
          groupName: newMessage.groupName || '',
          source: newMessage.source || 'native',
          messageKind: newMessage.messageKind || 'individual'
        },
        ...messages
      ];
    }
  }

  $: if (instanceId && refreshToken !== lastRefreshToken) {
    lastRefreshToken = refreshToken;
    load();
  }

  $: counts = {
    all: messages.length,
    individual: messages.filter((m) => (m.messageKind || 'individual') === 'individual').length,
    group: messages.filter((m) => m.messageKind === 'group').length,
    status: messages.filter((m) => m.messageKind === 'status').length
  };

  $: filteredMessages =
    activeFilter === 'all' ? messages : messages.filter((m) => (m.messageKind || 'individual') === activeFilter);

  onMount(load);
</script>

<div class="message-log">
  <div class="message-log-header">
    <h3>Message log — {instanceId}</h3>
    <div class="message-log-actions">
      <button type="button" class="secondary close-btn" on:click={clearLog} disabled={clearing}>
        {clearing ? 'Clearing…' : 'Clear log'}
      </button>
      <button type="button" class="secondary close-btn" on:click={close}>Close</button>
    </div>
  </div>

  <div class="message-type-filters">
    <button type="button" class:active={activeFilter === 'all'} on:click={() => (activeFilter = 'all')}>All ({counts.all})</button>
    <button type="button" class:active={activeFilter === 'individual'} on:click={() => (activeFilter = 'individual')}>Individual ({counts.individual})</button>
    <button type="button" class:active={activeFilter === 'group'} on:click={() => (activeFilter = 'group')}>Group ({counts.group})</button>
    <button type="button" class:active={activeFilter === 'status'} on:click={() => (activeFilter = 'status')}>Status ({counts.status})</button>
  </div>

  {#if loading}
    <p class="message-log-loading">Loading messages…</p>
  {:else if error}
    <p class="message-log-error">{error}</p>
  {:else if messages.length === 0}
    <p class="message-log-empty">No messages yet. Incoming messages will appear here.</p>
  {:else if filteredMessages.length === 0}
    <p class="message-log-empty">No {activeFilter} messages in this log yet.</p>
  {:else}
    <div class="message-log-list">
      {#each filteredMessages as msg (msg.messageId || msg.id)}
        <div class="message-log-row">
          <div class="message-log-meta">
            <div class="message-log-meta-main">
              <div class="sender-block">
                <span class="sender">{msg.senderDisplay}</span>
                {#if getGroupLabel(msg)}
                  <span class="group-label">in {getGroupLabel(msg)}</span>
                {/if}
                {#if getSenderNumber(msg)}
                  <span class="sender-number">{getSenderNumber(msg)}</span>
                {/if}
              </div>
              <span class="kind-badge kind-{msg.messageKind || 'individual'}">{msg.messageKind || 'individual'}</span>
              <span class="source-badge source-{msg.source || 'native'}">{msg.source || 'native'}</span>
            </div>
            <span class="timestamp">{formatTimestamp(msg)}</span>
          </div>
          <span class="separator">:</span>
          <span class="body">{msg.body || '(media)'}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .message-log {
    background: #fff;
    border-radius: 24px;
    box-shadow: 0 24px 80px rgba(15, 23, 42, 0.18);
    max-width: 1040px;
    width: 100%;
    max-height: 88vh;
    display: flex;
    flex-direction: column;
  }
  .message-log-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 20px;
    padding: 28px 32px;
    border-bottom: 1px solid #e0e0e0;
  }
  .message-log-header h3 {
    margin: 0;
    font-size: 28px;
    color: #333;
  }
  .close-btn {
    padding: 14px 22px;
  }
  .message-log-actions {
    display: flex;
    gap: 14px;
  }
  .message-log-loading,
  .message-log-error,
  .message-log-empty {
    padding: 40px 32px;
    color: #666;
    text-align: center;
  }
  .message-log-error {
    color: #b91c1c;
  }
  .message-log-list {
    padding: 18px 32px 28px;
    overflow-y: auto;
    flex: 1;
    min-height: 320px;
  }
  .message-type-filters {
    border-bottom: 1px solid #e5e7eb;
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    padding: 18px 32px;
  }
  .message-type-filters button {
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    border-radius: 999px;
    color: #374151;
    cursor: pointer;
    font-size: 15px;
    font-weight: 600;
    padding: 12px 20px;
  }
  .message-type-filters button.active {
    background: #111827;
    border-color: #111827;
    color: #fff;
  }
  .message-log-row {
    padding: 22px 24px;
    border-bottom: 1px solid #f0f0f0;
    font-size: 18px;
    line-height: 1.55;
  }
  .message-log-meta {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 8px;
  }
  .message-log-meta-main {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    min-width: 0;
  }
  .sender-block {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
  }
  .timestamp {
    color: #6b7280;
    flex-shrink: 0;
    font-size: 15px;
  }
  .message-log-row:last-child {
    border-bottom: none;
  }
  .sender {
    font-weight: 600;
    color: #3730a3;
    font-size: 22px;
    margin-right: 8px;
  }
  .group-label {
    color: #6b7280;
    font-size: 15px;
    max-width: 100%;
  }
  .sender-number {
    color: #0f766e;
    font-size: 14px;
    font-weight: 600;
  }
  .separator {
    color: #888;
    display: inline-block;
    font-size: 20px;
    margin-right: 10px;
  }
  .source-badge {
    border-radius: 999px;
    font-size: 13px;
    font-weight: 700;
    padding: 6px 12px;
    text-transform: uppercase;
  }
  .kind-badge {
    border-radius: 999px;
    font-size: 13px;
    font-weight: 700;
    padding: 6px 12px;
    text-transform: uppercase;
  }
  .kind-individual {
    background: #dcfce7;
    color: #166534;
  }
  .kind-group {
    background: #fee2e2;
    color: #b91c1c;
  }
  .kind-status {
    background: #fef3c7;
    color: #b45309;
  }
  .source-native {
    background: #dbeafe;
    color: #1d4ed8;
  }
  .source-webhook {
    background: #ede9fe;
    color: #6d28d9;
  }
  .body {
    color: #333;
    word-break: break-word;
    display: inline-block;
    max-width: min(100%, 840px);
  }

  @media (max-width: 900px) {
    .message-log {
      border-radius: 18px;
      max-height: 92vh;
    }
    .message-log-header {
      align-items: stretch;
      flex-direction: column;
      padding: 22px 22px 18px;
    }
    .message-log-header h3 {
      font-size: 22px;
    }
    .message-log-actions {
      width: 100%;
    }
    .message-log-actions .close-btn {
      flex: 1;
    }
    .message-type-filters,
    .message-log-list {
      padding-left: 22px;
      padding-right: 22px;
    }
    .message-log-row {
      font-size: 16px;
      padding: 18px 14px;
    }
    .message-log-meta {
      flex-direction: column;
      gap: 10px;
    }
    .sender {
      font-size: 18px;
    }
    .group-label {
      font-size: 13px;
    }
    .sender-number {
      font-size: 12px;
    }
    .timestamp {
      font-size: 13px;
    }
  }
</style>
