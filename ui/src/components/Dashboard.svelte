<script>
  import { onMount, onDestroy } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { getWsUrl } from '../lib/api.js';
  import * as api from '../lib/api.js';
  import InstanceCard from './InstanceCard.svelte';
  import MessageLog from './MessageLog.svelte';

  export let user = null;

  const dispatch = createEventDispatcher();

  let instances = [];
  let newInstanceId = '';
  let error = '';
  let success = '';
  let ws = null;

  let messageLogInstanceId = null;
  let newMessageForLog = null;
  let messageLogRefreshToken = 0;

  // Admin state
  let users = [];
  let newUsername = '';
  let newPassword = '';
  let newUserRole = 'user';
  let userAssignments = {}; // userId -> instanceId[]
  let assignInstanceId = {}; // userId -> selected instance id for dropdown
  let newPasswordByUser = {}; // userId -> string (for change password)

  function setError(msg) {
    error = msg;
    success = '';
    setTimeout(() => (error = ''), 5000);
  }

  function setSuccess(msg) {
    success = msg;
    error = '';
    setTimeout(() => (success = ''), 5000);
  }

  async function ensureUser() {
    if (user) return;
    user = await api.getMe();
  }

  function initWebSocket() {
    const url = getWsUrl();
    ws = new WebSocket(url);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth' }));
      instances.forEach((inst) => {
        ws.send(JSON.stringify({ type: 'subscribe', instanceId: inst.id }));
      });
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'message') {
        if (messageLogInstanceId === data.instanceId) {
          newMessageForLog = data.message;
        }
        dispatch('incomingMessage', data);
        return;
      }

      if (data.type === 'messages_cleared') {
        if (messageLogInstanceId === data.instanceId) {
          newMessageForLog = null;
          messageLogRefreshToken += 1;
        }
        return;
      }

      const idx = instances.findIndex((i) => i.id === data.instanceId);
      if (idx === -1) return;

      if (data.type === 'qr') {
        instances[idx] = {
          ...instances[idx],
          status: 'qr_ready',
          qr: data.qr,
          linkedAccount: data.linkedAccount ?? instances[idx].linkedAccount,
          linkedAccountChanged: data.linkedAccountChanged ?? instances[idx].linkedAccountChanged,
          previousLinkedAccount: data.previousLinkedAccount ?? instances[idx].previousLinkedAccount
        };
      } else if (data.type === 'ready') {
        instances[idx] = {
          ...instances[idx],
          status: 'ready',
          qr: null,
          linkedAccount: data.linkedAccount ?? instances[idx].linkedAccount,
          linkedAccountChanged: data.linkedAccountChanged ?? false,
          previousLinkedAccount: data.previousLinkedAccount ?? null
        };
      } else if (data.type === 'authenticated') {
        instances[idx] = { ...instances[idx], status: 'authenticated' };
      } else if (data.type === 'disconnected') {
        instances[idx] = { ...instances[idx], status: 'disconnected' };
      } else if (data.type === 'status') {
        instances[idx] = {
          ...instances[idx],
          status: data.status,
          qr: data.qr ?? instances[idx].qr,
          linkedAccount: data.linkedAccount ?? instances[idx].linkedAccount,
          linkedAccountChanged: data.linkedAccountChanged ?? instances[idx].linkedAccountChanged,
          previousLinkedAccount: data.previousLinkedAccount ?? instances[idx].previousLinkedAccount
        };
      }
      instances = instances;
    };

    ws.onclose = () => {
      setTimeout(initWebSocket, 3000);
    };
  }

  async function loadInstances() {
    try {
      instances = await api.getInstances();
      if (ws && ws.readyState === WebSocket.OPEN) {
        instances.forEach((inst) => {
          ws.send(JSON.stringify({ type: 'subscribe', instanceId: inst.id }));
        });
      }
    } catch (e) {
      setError('Failed to load instances');
    }
  }

  async function loadUsers() {
    try {
      users = await api.getUsers();
      userAssignments = {};
      for (const u of users) {
        if (u.role === 'user') {
          userAssignments[u.id] = await api.getUserInstances(u.id);
        }
      }
      userAssignments = userAssignments;
    } catch (e) {
      setError(e.message || 'Failed to load users');
    }
  }

  async function handleCreate() {
    const id = newInstanceId.trim();
    if (!id) {
      setError('Please enter an instance ID');
      return;
    }
    try {
      await api.createInstance(id);
      newInstanceId = '';
      setSuccess('Instance created successfully');
      await loadInstances();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'subscribe', instanceId: id }));
      }
    } catch (e) {
      setError(e.message || 'Failed to create instance');
    }
  }

  function handleOpenMessageLog(event) {
    messageLogInstanceId = event.detail?.instanceId ?? null;
    newMessageForLog = null;
    messageLogRefreshToken = 0;
  }

  function closeMessageLog() {
    messageLogInstanceId = null;
    newMessageForLog = null;
  }

  async function handleDelete(event) {
    const { instanceId } = event.detail;
    try {
      await api.deleteInstance(instanceId);
      instances = instances.filter((i) => i.id !== instanceId);
      setSuccess('Instance deleted successfully');
      await loadUsers();
    } catch (e) {
      setError('Failed to delete instance');
    }
  }

  async function handleCreateUser() {
    const username = newUsername.trim();
    const password = newPassword;
    if (!username || !password) {
      setError('Username and password required');
      return;
    }
    try {
      await api.createUser(username, password, newUserRole);
      newUsername = '';
      newPassword = '';
      setSuccess('User created');
      await loadUsers();
    } catch (e) {
      setError(e.message || 'Failed to create user');
    }
  }

  async function handleAssign(userId) {
    const instanceId = assignInstanceId[userId];
    if (!instanceId) return;
    try {
      await api.assignInstanceToUser(userId, instanceId);
      assignInstanceId = { ...assignInstanceId, [userId]: '' };
      userAssignments[userId] = [...(userAssignments[userId] || []), instanceId];
      userAssignments = userAssignments;
      setSuccess('Instance assigned');
    } catch (e) {
      setError(e.message || 'Failed to assign');
    }
  }

  async function handleUnassign(userId, instanceId) {
    try {
      await api.removeInstanceFromUser(userId, instanceId);
      userAssignments[userId] = (userAssignments[userId] || []).filter((id) => id !== instanceId);
      userAssignments = userAssignments;
      setSuccess('Assignment removed');
    } catch (e) {
      setError(e.message || 'Failed to remove');
    }
  }

  async function handleChangePassword(userId) {
    const password = (newPasswordByUser[userId] || '').trim();
    if (!password) {
      setError('Enter a new password');
      return;
    }
    try {
      await api.changeUserPassword(userId, password);
      newPasswordByUser = { ...newPasswordByUser, [userId]: '' };
      setSuccess('Password updated');
    } catch (e) {
      setError(e.message || 'Failed to change password');
    }
  }

  async function handleDeleteUser(userId) {
    if (!confirm('Permanently delete this user? Their instance assignments will be removed.')) return;
    try {
      const result = await api.deleteUser(userId);
      users = users.filter((u) => u.id !== userId);
      userAssignments = { ...userAssignments };
      delete userAssignments[userId];
      userAssignments = userAssignments;
      setSuccess(result && result.deleted === false ? 'User removed' : 'User deleted');
    } catch (e) {
      setError(e.message || 'Failed to delete user');
    }
  }

  async function handleLogout() {
    await api.logout();
    if (ws) ws.close();
    dispatch('logout');
  }

  $: isAdmin = user?.role === 'admin';

  onMount(async () => {
    await ensureUser();
    await loadInstances();
    initWebSocket();
    if (user?.role === 'admin') {
      loadUsers();
    }
  });

  onDestroy(() => {
    if (ws) ws.close();
  });
</script>

<div class="container">
  <div class="card">
    <div class="header">
      <div>
        <h1>📱 WhatsApp Instances</h1>
        <p class="subtitle">
          {#if user}
            Logged in as <strong>{user.username}</strong> ({user.role})
          {:else}
            Manage multiple WhatsApp Web instances
          {/if}
        </p>
      </div>
      <div class="header-actions">
        <a href="#docs" class="secondary link-docs">Docs</a>
        <button type="button" class="secondary" on:click={handleLogout}>Logout</button>
      </div>
    </div>

    {#if error}
      <div class="error">{error}</div>
    {/if}
    {#if success}
      <div class="success">{success}</div>
    {/if}

    {#if isAdmin}
      <div class="new-instance-form">
        <input type="text" bind:value={newInstanceId} placeholder="Enter instance ID (e.g., client1)" />
        <button type="button" on:click={handleCreate}>Create Instance</button>
      </div>
    {/if}

    <div class="instances-grid">
      {#if instances.length === 0}
        <p style="grid-column: 1/-1; text-align: center; color: #888;">
          {#if isAdmin}
            No instances yet. Create one to get started!
          {:else}
            No instances assigned to you yet. Ask an admin to assign one.
          {/if}
        </p>
      {:else}
        {#each instances as instance (instance.id)}
          <InstanceCard
            {instance}
            on:delete={handleDelete}
            on:openMessageLog={handleOpenMessageLog}
            canDelete={isAdmin}
          />
        {/each}
      {/if}
    </div>
  </div>

  {#if messageLogInstanceId}
    <div class="message-log-overlay" role="dialog" aria-modal="true" aria-label="Message log">
      <button type="button" class="message-log-backdrop" aria-label="Close message log" on:click={closeMessageLog}></button>
      <div class="message-log-wrap">
        <MessageLog
          instanceId={messageLogInstanceId}
          newMessage={newMessageForLog}
          refreshToken={messageLogRefreshToken}
          on:close={closeMessageLog}
        />
      </div>
    </div>
  {/if}

  {#if isAdmin}
    <div class="card admin-card">
      <h2>👥 User management</h2>
      <p class="subtitle">Create users and assign instances to them. Regular users only see assigned instances.</p>

      <div class="form-group">
        <h3 style="font-size: 14px; color: #555; margin-bottom: 10px;">Create user</h3>
        <div class="new-instance-form">
          <input type="text" bind:value={newUsername} placeholder="Username" />
          <input type="password" bind:value={newPassword} placeholder="Password" />
          <select bind:value={newUserRole} style="padding: 12px 16px; border-radius: 8px; border: 2px solid #e0e0e0;">
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
          <button type="button" on:click={handleCreateUser}>Create user</button>
        </div>
      </div>

      <div class="users-list">
        <h3 style="font-size: 14px; color: #555; margin: 20px 0 10px;">Users &amp; assigned instances</h3>
        {#each users as u (u.id)}
          <div class="user-row">
            <div class="user-info">
              <strong>{u.username}</strong>
              <span class="status-badge status-{u.role === 'admin' ? 'ready' : 'initializing'}">{u.role}</span>
            </div>
            <div class="user-actions">
              <div class="password-change">
                <input
                  type="password"
                  placeholder="New password"
                  value={newPasswordByUser[u.id] ?? ''}
                  on:input={(e) => {
                    newPasswordByUser[u.id] = e.currentTarget.value;
                    newPasswordByUser = newPasswordByUser;
                  }}
                />
                <button type="button" class="secondary" style="padding: 6px 12px; font-size: 13px;" on:click={() => handleChangePassword(u.id)}>Change password</button>
              </div>
              <button
                type="button"
                class="danger"
                style="padding: 6px 12px; font-size: 13px;"
                on:click={() => handleDeleteUser(u.id)}
                disabled={u.id === user?.id}
                title={u.id === user?.id ? 'Cannot delete your own account' : 'Delete user'}
              >
                Delete user
              </button>
            </div>
            {#if u.role === 'user'}
              <div class="user-assignments">
                {#each userAssignments[u.id] || [] as instanceId}
                  <span class="assignment-tag">
                    {instanceId}
                    <button type="button" class="unassign-btn" on:click={() => handleUnassign(u.id, instanceId)} title="Remove">×</button>
                  </span>
                {/each}
                <select
                  value={assignInstanceId[u.id] ?? ''}
                  on:change={(e) => {
                    assignInstanceId[u.id] = e.currentTarget.value;
                    assignInstanceId = assignInstanceId;
                  }}
                  style="padding: 6px 10px; border-radius: 6px; margin-left: 8px;"
                >
                  <option value="">Assign instance…</option>
                  {#each instances as inst (inst.id)}
                    <option value={inst.id} disabled={(userAssignments[u.id] || []).includes(inst.id)}>{inst.id}</option>
                  {/each}
                </select>
                <button type="button" class="secondary" style="padding: 6px 12px; font-size: 13px;" on:click={() => handleAssign(u.id)} disabled={!(assignInstanceId[u.id] || '').trim()}>Assign</button>
              </div>
            {:else}
              <p class="subtitle" style="margin: 0; font-size: 13px;">Admins see all instances</p>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .admin-card {
    margin-top: 20px;
  }
  .users-list {
    margin-top: 10px;
  }
  .user-row {
    padding: 12px 0;
    border-bottom: 1px solid #eee;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .user-row:last-child {
    border-bottom: none;
  }
  .user-info {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 140px;
  }
  .user-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .password-change {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .password-change input {
    width: 120px;
    padding: 6px 10px;
    font-size: 13px;
  }
  .user-assignments {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .assignment-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: #e0e7ff;
    color: #3730a3;
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 13px;
  }
  .unassign-btn {
    background: none;
    border: none;
    color: #3730a3;
    cursor: pointer;
    padding: 0 2px;
    font-size: 16px;
    line-height: 1;
  }
  .unassign-btn:hover {
    color: #1e1b4b;
    transform: none;
  }

  .message-log-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 28px;
  }
  .message-log-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    border: none;
    cursor: pointer;
    padding: 0;
  }
  .message-log-wrap {
    position: relative;
    z-index: 1001;
    width: min(94vw, 1080px);
  }
</style>
