// Step 3 session boundary.
//
// The dashboard starts empty, clears private state before every identity
// transition, and only renders owner data after the authenticated Supabase
// user has been established. Sender identity is deliberately separate from
// provider authorization; this build has no Gmail OAuth connection.
(function () {
  'use strict';

  var client = window.AIH_SUPABASE_CLIENT || null;
  var currentUserId = null;
  var transitionId = 0;

  function emptyPrivateState() {
    var base = typeof defaultState === 'function' ? defaultState() : {};
    return Object.assign({}, base, {
      opportunities: [],
      applications: [],
      route: 'overview',
      connected: false,
      connectedEmail: null,
      emailProvider: '',
      providerConnectionStatus: 'not_connected',
      emailProviderConnected: false,
      profileFacts: [],
      profileSync: null,
      approvedProfileSources: [],
      selected: [],
      emailDrafts: {},
      cloudOpportunityDeleteQueue: [],
      cloudApplicationDeleteQueue: []
    });
  }

  function removePrivateBrowserCache() {
    try {
      if (typeof STORAGE_KEY !== 'undefined') localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      // Storage can be unavailable in privacy mode; memory is still cleared.
    }
  }

  function clearPrivateState(reason, preserveIdentity) {
    if (!preserveIdentity) currentUserId = null;
    transitionId += 1;
    window.__AIH_PRIVATE_SESSION_EPOCH = transitionId;
    window.__AIH_AUTHENTICATED_SESSION = null;
    window.__AIH_DEMO_PREVIEW = true;
    window.__AIH_SKIP_CLOUD_SYNC = true;
    if (window.AIH_invalidateCloudLoads) window.AIH_invalidateCloudLoads();
    if (window.AIH_invalidatePrivateLoads) window.AIH_invalidatePrivateLoads();
    state = emptyPrivateState();
    removePrivateBrowserCache();
    if (typeof closeModal === 'function') closeModal();
    if (typeof render === 'function') render();
    window.__AIH_LAST_SESSION_TRANSITION = reason || 'unknown';
    setTimeout(function () { window.__AIH_SKIP_CLOUD_SYNC = false; }, 0);
  }

  function acceptSession(event, session) {
    var user = session && session.user ? session.user : null;
    var userId = user && user.id ? user.id : null;
    if (!userId || event === 'SIGNED_OUT') {
      clearPrivateState(event || 'signed-out', false);
      return;
    }
    if (currentUserId && currentUserId !== userId) {
      clearPrivateState('account-switch', false);
    }
    currentUserId = userId;
    window.__AIH_AUTHENTICATED_SESSION = user;
    window.__AIH_DEMO_PREVIEW = false;
  }

  window.AIH_beginPrivateTransition = function () {
    clearPrivateState('session-transition', true);
  };
  window.AIH_privateSessionEvent = acceptSession;
  window.AIH_isCurrentPrivateUser = function (user) {
    return Boolean(user && user.id && currentUserId && user.id === currentUserId &&
      window.__AIH_AUTHENTICATED_SESSION && window.__AIH_AUTHENTICATED_SESSION.id === user.id);
  };
  window.AIH_step3 = {
    emptyState: emptyPrivateState,
    clearPrivateState: clearPrivateState,
    currentUserId: function () { return currentUserId; },
    transitionId: function () { return transitionId; }
  };

  function installAccountControls() {
    var actions = document.querySelector('.topbar-actions');
    if (!actions) return;
    var user = window.__AIH_AUTHENTICATED_SESSION;
    var signedIn = Boolean(user && user.id);
    var emailStatus = actions.querySelector('.email-status');
    if (emailStatus) {
      emailStatus.innerHTML = '<span class="status-dot"></span><span>Dashboard account: ' +
        (signedIn ? 'Signed in' : 'Signed out') + ' · Email provider: Not connected</span>';
    }

    var existingAction = actions.querySelector('.btn:not(#step3-account-control):not(#account-login-btn)');
    if (existingAction) {
      existingAction.textContent = 'Sender identity';
      existingAction.onclick = function () {
        if (signedIn) navigate('settings');
        else if (window.openCloudDatabaseLogin) window.openCloudDatabaseLogin();
      };
    }

    var previous = document.getElementById('step3-account-control');
    if (previous) previous.remove();
    var control = document.createElement('button');
    control.id = 'step3-account-control';
    control.className = 'btn small ' + (signedIn ? 'ghost' : 'primary');
    control.textContent = signedIn ? 'Sign out' : 'Sign in';
    control.onclick = signedIn ? signOut : function () {
      if (window.openCloudDatabaseLogin) window.openCloudDatabaseLogin();
      else toast('Sign-in is temporarily unavailable.', true);
    };
    actions.appendChild(control);

    var legacyLogin = document.getElementById('account-login-btn');
    if (legacyLogin) legacyLogin.remove();
  }

  function signOut() {
    if (!client || !client.auth) {
      clearPrivateState('signed-out', false);
      toast('Signed out.');
      return;
    }
    confirmModal(
      'Sign out?',
      'Your private records remain stored in your account. This browser will clear the current private workspace immediately.',
      'Sign out',
      async function () {
        clearPrivateState('signed-out', false);
        var result = await client.auth.signOut();
        if (result && result.error) {
          toast('The session was cleared locally, but remote sign-out failed. Please try again.', true);
          return;
        }
        toast('Signed out.');
      }
    );
  }

  var previousRender = render;
  render = function () {
    if (!window.__AIH_AUTHENTICATED_SESSION) state = emptyPrivateState();
    previousRender();
    installAccountControls();
  };

  if (client && client.auth) {
    client.auth.onAuthStateChange(function (event, session) {
      acceptSession(event, session);
      if (event === 'SIGNED_OUT') installAccountControls();
    });
  }

  // The initial page is always the signed-out shell until the auth listener
  // and owner-scoped loaders prove that a private session exists.
  if (!window.__AIH_AUTHENTICATED_SESSION) state = emptyPrivateState();
  render();
})();
