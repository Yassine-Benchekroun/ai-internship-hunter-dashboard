// Phase 2 dashboard behavior and UI refinements.
// This is deliberately additive: the existing dashboard remains the shell,
// while this layer connects normalized profile data and clarifies state.
(function () {
  'use strict';

  var profileCategories = [
    ['skills', 'Skills'],
    ['projects', 'Projects'],
    ['technologies', 'Technologies'],
    ['experience', 'Experience'],
    ['education', 'Education'],
    ['certifications', 'Certifications'],
    ['languages', 'Languages']
  ];

  function ensurePhase2State() {
    state.profileFacts = Array.isArray(state.profileFacts) ? state.profileFacts : [];
    state.profileSync = state.profileSync && typeof state.profileSync === 'object' ? state.profileSync : null;
    state.connectedEmail = typeof state.connectedEmail === 'string' ? state.connectedEmail : '';
    state.providerConnectionStatus = state.providerConnectionStatus || (state.emailProviderConnected ? 'connected' : 'not_connected');
    state.emailProviderConnected = state.providerConnectionStatus === 'connected';
    // Keep the legacy UI flag derived from the real provider state. Older
    // dashboard payloads used `connected` for sender identity only.
    state.connected = state.providerConnectionStatus === 'connected';
    state.emailProvider = state.emailProvider || '';
    state.domainRelevanceEnabled = state.domainRelevanceEnabled !== false;
    state.opportunityTypes = Array.isArray(state.opportunityTypes) && state.opportunityTypes.length
      ? state.opportunityTypes
      : ['internship', 'research'];
  }

  function thresholdValue() {
    var value = Number(state.threshold);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 70;
  }

  function isApplicationStatus(status) {
    return ['Needs review', 'Ready', 'Already Sent', 'Sent', 'Waiting', 'Replied', 'Interview', 'Offer', 'Rejected', 'No Response', 'Follow-up needed', 'Closed'].includes(status);
  }

  function applicationStatusLabel(status) {
    return isApplicationStatus(status) ? status : 'Needs review';
  }

  function classificationForOpportunity(opportunity) {
    if (Array.isArray(opportunity.activeSections) && opportunity.activeSections.includes('new')) return 'new';
    return Number(opportunity.score || 0) >= thresholdValue() ? 'top' : 'lower';
  }

  function classificationLabel(classification) {
    return classification === 'top' ? 'Top Match' : classification === 'lower' ? 'Lower Match' : 'New / Unreviewed';
  }

  function classificationBadge(opportunity) {
    var classification = classificationForOpportunity(opportunity);
    var css = classification === 'top' ? 'cyan' : classification === 'lower' ? 'blue' : 'yellow';
    return '<span class="pill phase2-classification ' + css + '">' + esc(classificationLabel(classification)) + '</span>';
  }

  function applicationBadge(status) {
    var value = applicationStatusLabel(status);
    var css = ['Ready', 'Replied', 'Interview', 'Offer'].includes(value) ? 'green' : value === 'Already Sent' ? 'cyan' : value === 'Needs review' ? 'yellow' : '';
    return '<span class="pill phase2-application-status ' + css + '"><span class="phase2-pill-label">Application</span> ' + esc(value) + '</span>';
  }

  function applyScoreClassification(opportunity) {
    if (!opportunity) return;
    var sections = Array.isArray(opportunity.activeSections) ? opportunity.activeSections : [];
    var rank = Number(opportunity.score || 0) >= thresholdValue() ? 'top' : 'lower';
    opportunity.activeSections = sections.filter(function (section) {
      return section !== 'new' && section !== 'top' && section !== 'lower';
    });
    opportunity.activeSections.push(rank);
    opportunity.classification = rank;
    if (rank === 'top' && !opportunity.sent && applicationStatusLabel(opportunity.status) === 'Needs review') {
      opportunity.status = 'Ready';
    }
  }

  function classifyByScore(id) {
    var opportunity = typeof opp === 'function' ? opp(id) : null;
    if (!opportunity) return;
    applyScoreClassification(opportunity);
    persist();
    render();
    toast('Classified ' + opportunity.org + ' as ' + classificationLabel(opportunity.classification) + '. Application status remains separate.');
  }

  function profileStatus(status, verified) {
    if (status === 'verified' || verified === true) return { label: 'Verified', css: 'verified' };
    if (status === 'source_missing') return { label: 'Source Missing', css: 'source-missing' };
    if (status === 'unverified') return { label: 'New', css: 'new' };
    return { label: 'Needs Review', css: 'needs-review' };
  }

  function profileCategoryKey(category) {
    var normalized = String(category || '').toLowerCase().replace(/[\s_-]+/g, '');
    if (normalized === 'skill' || normalized === 'skills') return 'skills';
    if (normalized === 'project' || normalized === 'projects') return 'projects';
    if (normalized === 'technology' || normalized === 'technologies' || normalized === 'library' || normalized === 'libraries' || normalized === 'framework' || normalized === 'frameworks') return 'technologies';
    if (normalized === 'experience' || normalized === 'workexperience' || normalized === 'researchexperience') return 'experience';
    if (normalized === 'education' || normalized === 'educational') return 'education';
    if (normalized === 'certification' || normalized === 'certifications') return 'certifications';
    if (normalized === 'language' || normalized === 'languages') return 'languages';
    return 'experience';
  }

  function profileFactsByCategory() {
    var grouped = {};
    profileCategories.forEach(function (item) { grouped[item[0]] = []; });
    (state.profileFacts || []).forEach(function (fact) {
      var key = profileCategoryKey(fact.category);
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(fact);
    });
    Object.keys(grouped).forEach(function (key) {
      grouped[key].sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
    });
    return grouped;
  }

  function profileCounts() {
    var facts = state.profileFacts || [];
    return {
      total: facts.length,
      verified: facts.filter(function (fact) { return profileStatus(fact.verification_status, fact.verified).css === 'verified'; }).length,
      needsReview: facts.filter(function (fact) { return ['needs-review', 'source-missing'].includes(profileStatus(fact.verification_status, fact.verified).css); }).length,
      sourceMissing: facts.filter(function (fact) { return fact.verification_status === 'source_missing'; }).length
    };
  }

  function formatProfileDate(value) {
    if (!value) return 'Not recorded';
    return typeof fmtDate === 'function' ? fmtDate(String(value).slice(0, 10)) : String(value).slice(0, 10);
  }

  function profileSyncSummary() {
    var run = state.profileSync;
    if (!run) {
      return {
        scheduled: false,
        last: 'Not scheduled yet',
        sources: 'GitHub · Portfolio',
        added: '0',
        updated: '0',
        review: '0',
        duplicates: '0'
      };
    }
    var sources = Array.isArray(run.sources_checked)
      ? run.sources_checked.map(function (source) {
        if (typeof source === 'string') return source;
        if (source && typeof source === 'object') return source.source_name || source.source_type || source.name || source.source_url || '';
        return '';
      }).filter(Boolean).join(' · ')
      : 'GitHub · Portfolio';
    return {
      scheduled: true,
      last: formatProfileDate(run.completed_at || run.started_at),
      sources: sources || 'No sources recorded',
      added: String(run.records_inserted || 0),
      updated: String(run.records_updated || 0),
      review: String(run.records_needing_review || 0),
      duplicates: String(run.duplicates_ignored || 0)
    };
  }

  function profileSyncHTML() {
    var summary = profileSyncSummary();
    return '<div class="phase2-sync-card">' +
      '<div class="phase2-sync-head"><div><div class="phase2-eyebrow">Profile synchronization</div><h3>Profile sync status</h3></div><span class="pill ' + (summary.scheduled ? 'green' : 'yellow') + '">' + (summary.scheduled ? esc(String(state.profileSync.status || 'Recorded')) : 'Not scheduled') + '</span></div>' +
      '<div class="phase2-sync-grid"><div><span>Last Profile Sync</span><strong>' + esc(summary.last) + '</strong></div><div><span>Sources</span><strong>' + esc(summary.sources) + '</strong></div><div><span>Changes</span><strong>+ ' + esc(summary.added) + ' added · ~ ' + esc(summary.updated) + ' updated</strong></div><div><span>Review queue</span><strong>! ' + esc(summary.review) + ' needs review · ' + esc(summary.duplicates) + ' duplicates ignored</strong></div></div>' +
      '<div class="phase2-sync-note">' + (summary.scheduled ? 'This summary reflects the latest recorded profile sync run.' : 'Profile synchronization not scheduled yet. No successful synchronization is being claimed.') + '</div>' +
      '</div>';
  }

  function evidenceHTML(fact) {
    var evidence = Array.isArray(fact.evidence) ? fact.evidence : [];
    if (!evidence.length) return '<span class="phase2-source-missing">No source evidence recorded</span>';
    return evidence.map(function (item) {
      var label = item.source_name || item.source_type || 'Approved source';
      var text = item.evidence ? ' · ' + item.evidence : '';
      var safeUrl = safeEvidenceUrl(item.source_url);
      var href = safeUrl ? ' href="' + esc(safeUrl) + '" target="_blank" rel="noopener"' : '';
      return '<a class="phase2-evidence"' + href + '>' + esc(label + text) + '</a>';
    }).join(' ');
  }

  function safeEvidenceUrl(value) {
    if (!value) return '';
    try {
      var url = new URL(String(value));
      var hostname = url.hostname.toLowerCase();
      var approvedHost = hostname === 'github.com' || hostname.endsWith('.github.com') || hostname === 'yassine-benchekroun.github.io';
      return url.protocol === 'https:' && approvedHost ? url.href : '';
    } catch (error) {
      return '';
    }
  }

  function profileFactHTML(fact) {
    var stateLabel = profileStatus(fact.verification_status, fact.verified);
    return '<div class="phase2-fact"><div class="phase2-fact-main"><div class="phase2-fact-name">' + esc(fact.name || 'Unnamed fact') + '</div><div class="phase2-fact-description">' + esc(fact.description || 'No additional description recorded.') + '</div><div class="phase2-fact-evidence">' + evidenceHTML(fact) + '</div></div><div class="phase2-fact-meta"><span class="phase2-status ' + stateLabel.css + '">' + stateLabel.label + '</span><span>Last verified · ' + esc(formatProfileDate(fact.last_verified_at)) + '</span></div></div>';
  }

  function profileCategoryCard(title, facts) {
    return '<div class="profile-card phase2-profile-card"><div class="phase2-category-head"><h3>' + esc(title) + '</h3><span class="pill cyan">' + facts.length + '</span></div>' + (facts.length ? '<div class="profile-items">' + facts.map(profileFactHTML).join('') + '</div>' : '<div class="phase2-empty-fact">No Supabase profile facts recorded yet.</div>') + '</div>';
  }

  function profileHTMLPhase2() {
    ensurePhase2State();
    var grouped = profileFactsByCategory();
    var demoMode = !window.__AIH_OWNER_SESSION;
    return pageIntro('Source of truth', 'Verified Profile Registry', 'The registry is the only source allowed to supply factual claims to CVs and emails.', '<a class="btn ghost" href="https://github.com/Yassine-Benchekroun" target="_blank" rel="noopener">' + icon('external') + ' Open GitHub</a>') +
      (demoMode ? '<div class="notice phase2-demo-notice"><strong>DEMO DATA</strong> · This signed-out preview is not connected to the private profile registry. Empty categories are intentional; no demo fact is presented as verified.</div>' : '') +
      profileSyncHTML() +
      '<div class="source-banner"><div><h3>Approved sources</h3><div class="panel-kicker">Only GitHub and Portfolio evidence may add profile facts.</div></div><div class="source-links"><a class="source-link" href="https://github.com/Yassine-Benchekroun" target="_blank" rel="noopener">GitHub</a><a class="source-link" href="https://yassine-benchekroun.github.io" target="_blank" rel="noopener">Portfolio</a></div></div>' +
      '<div class="profile-grid phase2-profile-grid">' + profileCategories.map(function (item) { return profileCategoryCard(item[1], grouped[item[0]] || []); }).join('') + '</div>';
  }

  function overviewProfileCard() {
    var counts = profileCounts();
    return '<div class="panel pad phase2-overview-profile"><div class="panel-head"><div class="panel-title"><div class="title-icon">' + icon('shield') + '</div><div><h2>Verified Profile</h2><div class="panel-kicker">Live Supabase registry summary</div></div></div><span class="pill ' + (counts.total ? 'cyan' : 'yellow') + '">' + (counts.total ? counts.verified + ' verified' : 'Not populated') + '</span></div><div class="phase2-overview-profile-stats"><div><strong>' + counts.total + '</strong><span>Profile facts</span></div><div><strong>' + counts.verified + '</strong><span>Verified</span></div><div><strong>' + counts.needsReview + '</strong><span>Needs review</span></div></div><div class="phase2-sync-note">Last Sync: ' + esc(profileSyncSummary().last) + '</div><button class="btn small ghost" onclick="navigate(\'profile\')">Open Verified Profile ' + icon('chevron') + '</button></div>';
  }

  function overviewHTMLPhase2() {
    var html = overviewHTMLOriginal();
    var marker = '<div class="dashboard-grid">';
    return html.replace(marker, '<div class="phase2-overview-profile-wrap">' + overviewProfileCard() + '</div>' + marker);
  }

  function settingsHTMLPhase2() {
    ensurePhase2State();
    var identity = state.connectedEmail || '';
    var providerConnected = state.providerConnectionStatus === 'connected';
    return pageIntro('Control room', 'Settings', 'Tune matching and data safeguards. Future automations are placeholders only; no schedules have been created.', '') +
      '<div class="settings-grid phase2-settings-grid">' +
      '<div class="setting-card"><div class="panel-head"><div><h2>Matching & discovery</h2><div class="panel-kicker">Quality over quota</div></div><span class="pill cyan">Manual control</span></div>' +
      '<div class="setting-row"><div><div class="setting-name">Match threshold</div><div class="setting-help">Scores at or above this value are Top Matches. Lower scores remain valid and reviewable.</div></div><div class="range-row"><input type="range" min="50" max="90" step="1" value="' + thresholdValue() + '" oninput="setThreshold(this.value)"/><span class="range-value">' + thresholdValue() + '</span></div></div>' +
      '<div class="setting-row"><div><div class="setting-name">Daily target</div><div class="setting-help">A ceiling for future discovery; never a reason to lower quality.</div></div><select class="select" onchange="state.qualityTarget=Number(this.value);persist();toast(\'Daily target updated\')">' + [10, 20, 30, 40].map(function (value) { return '<option ' + (state.qualityTarget === value ? 'selected' : '') + '>' + value + ' opportunities</option>'; }).join('') + '</select></div>' +
      '<div class="setting-row"><div><div class="setting-name">Domain relevance filter</div><div class="setting-help">Unrelated opportunities are filtered before scoring.</div></div><span class="pill ' + (state.domainRelevanceEnabled ? 'green">Enabled' : 'red">Disabled') + '</span></div></div>' +
      '<div class="setting-card"><div class="panel-head"><div><h2>Email identity & connection</h2><div class="panel-kicker">These are intentionally separate concepts</div></div><span class="pill ' + (providerConnected ? 'green' : 'yellow') + '">' + (providerConnected ? 'Provider connected' : 'Provider not connected') + '</span></div>' +
      '<div class="setting-row phase2-identity-row"><div><div class="setting-name">Sender identity</div><div class="setting-help">Saved address used in drafts. It does not authorize Gmail or another provider.</div></div><div class="phase2-identity-editor"><input id="phase2-sender-email" type="email" value="' + esc(identity) + '" placeholder="you@example.com"/><button class="btn small primary" onclick="saveSenderIdentity()">Save identity</button></div></div>' +
      '<div class="setting-row"><div><div class="setting-name">Gmail / email API connection</div><div class="setting-help">OAuth/provider authorization has not been configured for this dashboard.</div></div><span class="pill ' + (providerConnected ? 'green' : 'red') + '">' + (providerConnected ? 'Connected' : 'Not connected') + '</span></div>' +
      '<div class="setting-row"><div><div class="setting-name">Automatic sending</div><div class="setting-help">Always off. Every draft and send action remains explicit.</div></div><span class="pill red">Disabled</span></div></div>' +
      '<div class="setting-card"><div class="panel-head"><div><h2>Data Management</h2><div class="panel-kicker">Permanent actions require explicit confirmation.</div></div><span class="pill yellow">High impact</span></div>' +
      '<div class="setting-row"><div><div class="setting-name">Clear Opportunity History</div><div class="setting-help">Deletes opportunity history only. Application / Sent History stays intact.</div></div><button class="btn small danger" onclick="confirmClearHistory()">' + icon('trash') + ' Clear history</button></div>' +
      '<div class="setting-row"><div><div class="setting-name">Application history</div><div class="setting-help">A separate record store; deleting an application never deletes its opportunity.</div></div><button class="btn small ghost" onclick="navigate(\'application-history\')">Manage applications</button></div>' +
      '<div class="setting-row"><div><div class="setting-name">Restore seeded demo records</div><div class="setting-help">Creates a clearly labeled local walkthrough state. It never syncs over real Supabase records.</div></div><button class="btn small ghost" onclick="resetDemo()">Restore demo</button></div></div>' +
      '<div class="setting-card phase2-automation-card"><div class="panel-head"><div><h2>Future automations</h2><div class="panel-kicker">Prepared interfaces, not scheduled jobs</div></div><span class="pill yellow">3 placeholders</span></div>' +
      '<div class="phase2-automation"><div class="phase2-automation-num">01</div><div><h3>Verified Profile Sync</h3><p>GitHub + Portfolio → extract → verify → deduplicate → update Verified Profile</p></div><span class="pill yellow">Not scheduled</span></div>' +
      '<div class="phase2-automation"><div class="phase2-automation-num">02</div><div><h3>Opportunity Discovery & Application Preparation</h3><p>Verified Profile → search → verify → match → CV → email draft</p></div><span class="pill yellow">Not scheduled</span></div>' +
      '<div class="phase2-automation"><div class="phase2-automation-num">03</div><div><h3>Application & Email Monitoring</h3><p>Application History → monitor replies → update status → prepare follow-ups</p></div><span class="pill yellow">Not scheduled</span></div>' +
      '<div class="phase2-workflow"><strong>Intended order</strong><span>07:00 Profile Sync</span><span>08:00 Discovery</span><span>Periodic Monitoring</span><em>Times are explanatory placeholders only.</em></div></div>' +
      '</div>';
  }

  function saveSenderIdentity() {
    if (window.AIH_requireOwner && !window.AIH_requireOwner()) return;
    var input = document.getElementById('phase2-sender-email');
    var email = input && input.value ? input.value.trim() : '';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast('Enter a valid sender email address or leave it blank.', true);
      return;
    }
    state.connectedEmail = email;
    state.connected = false;
    state.emailProviderConnected = false;
    state.providerConnectionStatus = 'not_connected';
    persist();
    render();
    toast(email ? 'Sender identity saved. Provider remains not connected.' : 'Sender identity cleared.');
  }

  function setThresholdPhase2(value) {
    state.threshold = Math.max(0, Math.min(100, Math.round(Number(value) || 70)));
    (state.opportunities || []).forEach(function (opportunity) {
      var sections = Array.isArray(opportunity.activeSections) ? opportunity.activeSections : [];
      if (!sections.includes('new') && (sections.includes('top') || sections.includes('lower'))) applyScoreClassification(opportunity);
    });
    persist();
    render();
  }

  function renderPhase2Enhancements() {
    ensurePhase2State();
    var emailStatus = document.querySelector('.email-status');
    if (emailStatus) {
      emailStatus.innerHTML = '<span class="status-dot ' + (state.providerConnectionStatus === 'connected' ? 'connected' : '') + '"></span><span>Email provider: ' + (state.providerConnectionStatus === 'connected' ? 'Connected' : 'Not connected') + '</span>';
    }
    var emailButton = document.querySelector('.topbar-actions > .btn:not(#owner-login-btn)');
    if (emailButton) {
      emailButton.textContent = state.providerConnectionStatus === 'connected' ? 'Manage provider' : 'Set sender identity';
      emailButton.onclick = function () { navigate('settings'); };
    }
    document.querySelectorAll('.phase2-needs-enhance').forEach(function (node) { node.remove(); });
    if (state.route === 'applications') {
      var guardrail = document.querySelector('.content .guardrail p');
      if (guardrail) guardrail.textContent = 'Provider connection: ' + (state.providerConnectionStatus === 'connected' ? 'Connected' : 'Not connected') + '. Sender identity: ' + (state.connectedEmail || 'Not saved') + '. Drafts remain available either way.';
    }
    document.querySelectorAll('.new-card .card-actions button').forEach(function (button) {
      if (button.textContent.trim().toLowerCase().startsWith('classify ')) button.textContent = 'Classify by score';
    });
    document.querySelectorAll('.table-wrap th').forEach(function (heading) {
      if (heading.textContent.trim() === 'Status') heading.textContent = 'Application status';
    });
    document.querySelectorAll('.opp-card').forEach(function (card) {
      if (card.querySelector('.phase2-card-classification')) return;
      var action = card.querySelector('.card-actions button');
      var idMatch = action && String(action.getAttribute('onclick') || '').match(/openDetails\('([^']+)'\)/);
      var opportunity = idMatch && typeof opp === 'function' ? opp(idMatch[1]) : null;
      if (!opportunity) return;
      var marker = document.createElement('div');
      marker.className = 'phase2-card-classification';
      marker.innerHTML = classificationBadge(opportunity);
      var head = card.querySelector('.opp-card-head');
      if (head) card.insertBefore(marker, head);
    });
    if (state.route === 'history') {
      var rows = document.querySelectorAll('.table-wrap tbody tr');
      rows.forEach(function (row) {
        var scoreCell = row.children[5];
        if (!scoreCell || scoreCell.querySelector('.phase2-classification')) return;
        var score = Number(String(scoreCell.textContent).match(/\d+/)?.[0]);
        if (!Number.isFinite(score)) return;
        scoreCell.insertAdjacentHTML('beforeend', '<div>' + classificationBadge({ score: score, activeSections: [] }) + '</div>');
      });
    }
  }

  function injectPhase2Styles() {
    if (document.getElementById('phase2-styles')) return;
    var style = document.createElement('style');
    style.id = 'phase2-styles';
    style.textContent = '.phase2-sync-card{border:1px solid var(--line);background:linear-gradient(145deg,rgba(15,31,47,.96),rgba(11,25,39,.96));border-radius:14px;padding:18px;margin-bottom:15px}.phase2-sync-head,.phase2-category-head,.phase2-overview-profile .panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.phase2-eyebrow{color:var(--cyan);font-size:9px;font-weight:750;text-transform:uppercase;letter-spacing:.12em}.phase2-sync-head h3{margin:4px 0 0}.phase2-sync-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:15px}.phase2-sync-grid div,.phase2-overview-profile-stats div{border:1px solid var(--line);border-radius:10px;padding:11px;background:rgba(255,255,255,.025)}.phase2-sync-grid span,.phase2-overview-profile-stats span{display:block;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.08em}.phase2-sync-grid strong{display:block;color:var(--text);font-size:11px;margin-top:6px;line-height:1.4}.phase2-sync-note{margin-top:12px;color:var(--muted);font-size:10px;line-height:1.5}.phase2-profile-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.phase2-category-head h3{margin:0}.phase2-category-head .pill{min-width:24px;text-align:center}.phase2-fact{display:flex;justify-content:space-between;gap:15px;border-top:1px solid var(--line);padding:11px 0}.phase2-fact:first-child{border-top:0;padding-top:0}.phase2-fact-name{font-weight:700;color:var(--text);font-size:11px}.phase2-fact-description,.phase2-fact-evidence,.phase2-fact-meta{color:var(--muted);font-size:9px;line-height:1.45}.phase2-fact-description{margin-top:3px}.phase2-fact-evidence{margin-top:5px}.phase2-fact-meta{min-width:105px;text-align:right}.phase2-status{display:inline-block;border-radius:999px;padding:3px 7px;font-size:8px;font-weight:750;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}.phase2-status.verified{background:rgba(98,220,155,.12);color:var(--green)}.phase2-status.new{background:rgba(243,200,107,.12);color:var(--yellow)}.phase2-status.needs-review{background:rgba(243,200,107,.12);color:var(--yellow)}.phase2-status.source-missing{background:rgba(239,122,132,.12);color:var(--red)}.phase2-source-missing{color:var(--red)}.phase2-evidence{color:var(--cyan);text-decoration:none}.phase2-empty-fact{border-top:1px solid var(--line);padding-top:13px;color:var(--muted);font-size:10px}.phase2-overview-profile-wrap{margin-bottom:15px}.phase2-overview-profile-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:14px 0}.phase2-overview-profile-stats strong{display:block;font-size:20px;color:var(--text);margin-bottom:4px}.phase2-identity-editor{display:flex;gap:7px;align-items:center}.phase2-identity-editor input{width:210px}.phase2-automation{display:grid;grid-template-columns:34px 1fr auto;align-items:start;gap:12px;padding:14px 0;border-bottom:1px solid var(--line)}.phase2-automation-num{color:var(--cyan);font-family:ui-monospace,monospace;font-weight:700}.phase2-automation h3{margin:0 0 5px;font-size:12px}.phase2-automation p{margin:0;color:var(--muted);font-size:10px;line-height:1.5}.phase2-workflow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:15px;padding:12px;border:1px dashed var(--line2);border-radius:10px;color:var(--muted);font-size:10px}.phase2-workflow strong{color:var(--text)}.phase2-workflow span{color:var(--cyan)}.phase2-workflow em{width:100%;color:var(--muted);font-size:9px}.phase2-classification{margin-right:4px}.phase2-card-classification{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px}.phase2-application-status .phase2-pill-label{color:var(--muted);font-size:8px;text-transform:uppercase;letter-spacing:.05em}.phase2-demo-notice{margin-bottom:15px}.phase2-settings-grid{grid-template-columns:1fr 1fr}.phase2-automation-card{grid-column:1/-1}@media(max-width:800px){.phase2-sync-grid{grid-template-columns:1fr 1fr}.phase2-profile-grid,.phase2-settings-grid{grid-template-columns:1fr}.phase2-automation-card{grid-column:auto}.phase2-fact{display:block}.phase2-fact-meta{text-align:left;margin-top:8px}.phase2-identity-editor{flex-direction:column;align-items:stretch}.phase2-identity-editor input{width:100%}}';
    document.head.appendChild(style);
  }

  ensurePhase2State();
  injectPhase2Styles();

  var overviewHTMLOriginal = overviewHTML;
  overviewHTML = overviewHTMLPhase2;
  profileHTML = profileHTMLPhase2;
  settingsHTML = settingsHTMLPhase2;
  statusPill = applicationBadge;
  setThreshold = function (value) {
    if (window.AIH_requireOwner && !window.AIH_requireOwner()) return;
    setThresholdPhase2(value);
  };
  classifyOpportunity = function (id) {
    if (window.AIH_requireOwner && !window.AIH_requireOwner()) return;
    classifyByScore(id);
  };
  toggleConnection = function () { navigate('settings'); toast('Sender identity and provider connection are managed separately in Settings.'); };
  window.saveSenderIdentity = saveSenderIdentity;
  window.AIH_phase2 = {
    classify: function (opportunity) { applyScoreClassification(opportunity); return opportunity; },
    classificationFor: classificationForOpportunity,
    classificationLabel: classificationLabel,
    profileCounts: profileCounts
  };

  var renderOriginal = render;
  render = function () {
    ensurePhase2State();
    renderOriginal();
    renderPhase2Enhancements();
  };

  var saveManualApplicationOriginal = saveManualApplication;
  saveManualApplication = function (editId) {
    var beforeClassification = JSON.stringify((state.opportunities || []).map(function (opportunity) {
      return { id: opportunity.id, classification: opportunity.classification, activeSections: opportunity.activeSections, status: opportunity.status };
    }));
    var result = saveManualApplicationOriginal(editId);
    ensurePhase2State();
    (state.opportunities || []).forEach(function (opportunity) {
      if (opportunity.sent && Array.isArray(opportunity.activeSections) && opportunity.activeSections.includes('new')) {
        applyScoreClassification(opportunity);
      }
    });
    var afterClassification = JSON.stringify((state.opportunities || []).map(function (opportunity) {
      return { id: opportunity.id, classification: opportunity.classification, activeSections: opportunity.activeSections, status: opportunity.status };
    }));
    if (beforeClassification !== afterClassification) {
      persist();
      if (document.getElementById('content')) render();
    }
    return result;
  };

  render();
})();
