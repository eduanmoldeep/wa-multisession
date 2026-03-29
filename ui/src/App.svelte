<script>
  import { onMount } from 'svelte';
  import { checkAuth } from './lib/api.js';
  import Login from './components/Login.svelte';
  import Dashboard from './components/Dashboard.svelte';
  import Docs from './components/Docs.svelte';
  import Disclaimer from './components/Disclaimer.svelte';

  let authenticated = false;
  let user = null;
  let checking = true;
  let showDocs = false;

  function updateShowDocs() {
    if (typeof window !== 'undefined') showDocs = window.location.hash === '#docs';
  }

  onMount(async () => {
    try {
      const { authenticated: auth, user: u } = await checkAuth();
      authenticated = auth;
      user = u;
    } catch {
      authenticated = false;
      user = null;
    }
    checking = false;

    updateShowDocs();
    window.addEventListener('hashchange', updateShowDocs);
    return () => {
      window.removeEventListener('hashchange', updateShowDocs);
    };
  });

  function onLogin(ev) {
    authenticated = true;
    user = ev.detail?.user ?? null;
  }

  function onLogout() {
    authenticated = false;
    user = null;
  }
</script>

<div class="app-shell">
  {#if checking}
    <div class="container">
      <div class="card login-card">
        <p class="subtitle">Checking authentication…</p>
      </div>
    </div>
  {:else if authenticated}
    {#if showDocs}
      <Docs on:back={() => (showDocs = false)} />
    {:else}
      <Dashboard {user} on:logout={onLogout} />
    {/if}
  {:else}
    <Login on:login={onLogin} />
  {/if}
  <Disclaimer />
</div>
