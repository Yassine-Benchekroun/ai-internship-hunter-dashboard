// Connect the dashboard's opportunity, application, and artifact models to
// normalized Supabase tables. dashboard_state remains UI/cache state only.
(function () {
  var config = window.SUPABASE_CONFIG || {};
  var hasConfig = Boolean(config.url && config.publishableKey);
  var bridgeClient = hasConfig && window.supabase && typeof window.supabase.createClient === 'function'
    ? window.supabase.createClient(config.url, config.publishableKey)
    : null;
  var bridgeUser = null;
  var bridgeReady = false;
  var knownOpportunityIds = new Set();
  var syncQueue = Promise.resolve();
  var priorPersist = window.persist;

  function isUuid(value) {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  function newOpportunityId() {
    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'opp-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  window.createCloudOpportunityId = newOpportunityId;

  function cleanText(value, fallback) {
    var result = String(value == null ? '' : value).trim();
    return result || (fallback || null);
  }

  function arrayValue(value) {
    return Array.isArray(value) ? value.filter(function (item) { return typeof item === 'string'; }) : [];
  }

  var applicationStatusLabels = {
    not_sent: 'Needs review',
    ready: 'Ready',
    already_sent: 'Already Sent',
    sent: 'Sent',
    waiting: 'Waiting',
    replied: 'Replied',
    interview: 'Interview',
    offer: 'Offer',
    rejected: 'Rejected',
    no_response: 'No Response',
    follow_up_needed: 'Follow-up needed',
    closed: 'Closed'
  };

  function normalizeApplicationStatus(opportunity) {
    var status = String(opportunity.status || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    var aliases = {
      'needs_review': 'not_sent',
      'already_sent': 'already_sent',
      'already': 'already_sent',
      'follow_up': 'follow_up_needed',
      'noresponse': 'no_response'
    };
    status = aliases[status] || status;
    if (status === 'not_sent' && opportunity.sent) return 'already_sent';
    return applicationStatusLabels[status] ? status : (opportunity.sent ? 'already_sent' : 'not_sent');
  }

  function labelForApplicationStatus(status) {
    return applicationStatusLabels[status] || 'Needs review';
  }

  function statusCode(value, sent) {
    var status = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    var aliases = {
      needs_review: 'not_sent',
      already: 'already_sent',
      follow_up: 'follow_up_needed',
      noresponse: 'no_response'
    };
    status = aliases[status] || status;
    if (status === 'not_sent' && sent) return 'already_sent';
    return applicationStatusLabels[status] ? status : (sent ? 'already_sent' : 'not_sent');
  }

  function versionNumber(value, fallback) {
    var match = String(value || '').match(/(\d+)/);
    var version = match ? Number(match[1]) : Number(fallback || 1);
    return Number.isInteger(version) && version > 0 ? version : Number(fallback || 1);
  }

  function queueValues(key, values) {
    var current = Array.isArray(state[key]) ? state[key] : [];
    var next = current.concat(Array.isArray(values) ? values : [values])
      .filter(function (value) { return isUuid(value); });
    state[key] = Array.from(new Set(next));
  }

  window.queueCloudOpportunityDeletion = function (ids) {
    queueValues('cloudOpportunityDeleteQueue', ids);
  };

  window.queueCloudApplicationDeletion = function (ids) {
    queueValues('cloudApplicationDeleteQueue', ids);
  };

  function dateOnly(value) {
    var result = String(value == null ? '' : value).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null;
  }

  function timestampOrNow(value) {
    return dateOnly(value) || new Date().toISOString();
  }

  function normalizedUrl(value) {
    var source = cleanText(value, '');
    if (!source) return '';
    try {
      var url = new URL(source.indexOf('://') === -1 ? 'https://' + source : source);
      url.hash = '';
      return url.toString().replace(/\/$/, '');
    } catch (error) {
      return source;
    }
  }

  function displayUrl(value) {
    var source = cleanText(value, '');
    if (!source) return '';
    return /^https?:\/\//i.test(source) ? source : 'https://' + source;
  }

  async function sha256(value) {
    var bytes = new TextEncoder().encode(value);
    var digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  async function dedupeKey(opportunity) {
    var source = normalizedUrl(opportunity.source || opportunity.source_url || opportunity.sourceUrl);
    var organization = cleanText(opportunity.org || opportunity.organization, '');
    var position = cleanText(opportunity.position, '');
    return sha256(source.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '')
      + '|' + organization.toLowerCase().replace(/\s+/g, ' ')
      + '|' + position.toLowerCase().replace(/\s+/g, ' '));
  }

  function rowToOpportunity(row) {
    var applicationStatus = row.application_status || (row.sent ? 'already_sent' : 'not_sent');
    if (applicationStatus === 'not_sent' && row.sent) applicationStatus = 'already_sent';
    var displayStatus = labelForApplicationStatus(applicationStatus);
    return {
      id: row.id,
      cloudId: row.id,
      origin: row.origin || 'automation',
      label: row.label || '',
      demo: false,
      kind: row.kind || 'internship',
      org: row.organization || 'Organization not listed',
      contact: row.contact || 'Contact not listed',
      position: row.position || 'Opportunity not listed',
      lab: row.lab || '',
      country: row.country || 'Not listed',
      city: row.city || '',
      type: row.opportunity_type || 'Internship',
      score: Number(row.match_score || 0),
      deadline: row.deadline || 'Not listed',
      funding: row.funding || 'Unknown',
      workMode: row.work_mode || 'Unknown',
      status: displayStatus,
      discovered: String(row.first_discovered_at || '').slice(0, 10),
      lastChecked: String(row.last_checked_at || '').slice(0, 10),
      firstDiscoveredAt: row.first_discovered_at || null,
      lastCheckedAt: row.last_checked_at || null,
      source: displayUrl(row.source_url),
      description: row.description || '',
      requirements: arrayValue(row.requirements),
      verifiedSkills: arrayValue(row.verified_skills),
      missingSkills: arrayValue(row.missing_skills),
      projects: arrayValue(row.projects),
      breakdown: row.score_breakdown && typeof row.score_breakdown === 'object' ? row.score_breakdown : {},
      activeSections: Array.isArray(row.active_sections) ? row.active_sections : ['new'],
      classification: row.classification || 'new',
      active: row.active !== false,
      sent: Boolean(row.sent) || !['not_sent', 'ready'].includes(applicationStatus),
      sentDate: row.sent_date || '',
      cvVersion: row.cv_version || 'CV v1',
      emailVersion: row.email_version || 'Email v1',
      summary: row.summary || row.description || 'No summary recorded.'
    };
  }

  async function opportunityToRow(opportunity, userId) {
    var sourceUrl = normalizedUrl(opportunity.source || opportunity.source_url || opportunity.sourceUrl);
    if (!sourceUrl) sourceUrl = 'https://local.invalid/opportunity/' + encodeURIComponent(opportunity.id);
    var score = Number(opportunity.score);
    if (!Number.isFinite(score)) score = 0;
    score = Math.max(0, Math.min(100, Math.round(score)));
    var activeSections = Array.isArray(opportunity.activeSections) ? opportunity.activeSections : ['new'];
    var cloudId = isUuid(opportunity.id) ? opportunity.id : newOpportunityId();
    if (opportunity.id !== cloudId) {
      var legacyId = opportunity.id;
      opportunity.id = cloudId;
      state.applications = (state.applications || []).map(function (application) {
        return application.opportunityId === legacyId
          ? Object.assign({}, application, { opportunityId: cloudId })
          : application;
      });
    }
    return {
      id: cloudId,
      user_id: userId,
      dedupe_key: opportunity.dedupeKey || await dedupeKey({
        source: sourceUrl,
        org: opportunity.org,
        position: opportunity.position
      }),
      origin: cleanText(opportunity.origin, 'dashboard'),
      label: cleanText(opportunity.label),
      kind: cleanText(opportunity.kind, 'internship'),
      organization: cleanText(opportunity.org, 'Organization not listed'),
      contact: cleanText(opportunity.contact),
      position: cleanText(opportunity.position, 'Opportunity not listed'),
      lab: cleanText(opportunity.lab),
      country: cleanText(opportunity.country),
      city: cleanText(opportunity.city),
      opportunity_type: cleanText(opportunity.type),
      match_score: score,
      application_status: normalizeApplicationStatus(opportunity),
      score_breakdown: opportunity.breakdown && typeof opportunity.breakdown === 'object' ? opportunity.breakdown : {},
      deadline: dateOnly(opportunity.deadline),
      funding: cleanText(opportunity.funding),
      work_mode: cleanText(opportunity.workMode),
      status: cleanText(opportunity.status, 'Needs review'),
      first_discovered_at: opportunity.firstDiscoveredAt || timestampOrNow(opportunity.discovered),
      last_checked_at: opportunity.lastCheckedAt || timestampOrNow(opportunity.lastChecked || opportunity.discovered),
      source_url: sourceUrl,
      description: cleanText(opportunity.description),
      requirements: arrayValue(opportunity.requirements),
      verified_skills: arrayValue(opportunity.verifiedSkills),
      missing_skills: arrayValue(opportunity.missingSkills),
      projects: arrayValue(opportunity.projects),
      active_sections: activeSections,
      active: activeSections.length > 0,
      sent: Boolean(opportunity.sent),
      sent_date: dateOnly(opportunity.sentDate),
      cv_version: cleanText(opportunity.cvVersion),
      email_version: cleanText(opportunity.emailVersion),
      summary: cleanText(opportunity.summary),
      updated_at: new Date().toISOString()
    };
  }

  async function migrateLegacyOpportunities(legacy) {
    if (!legacy.length) return [];
    var prepared = [];
    for (var i = 0; i < legacy.length; i += 1) {
      prepared.push({ sourceId: legacy[i].id, row: await opportunityToRow(legacy[i], bridgeUser.id) });
    }
    var result = await bridgeClient.from('opportunity_records')
      .upsert(prepared.map(function (item) { return item.row; }), { onConflict: 'user_id,dedupe_key' })
      .select('*');
    if (result.error) throw result.error;
    var byKey = new Map((result.data || []).map(function (row) { return [row.dedupe_key, row]; }));
    var idMap = new Map();
    prepared.forEach(function (item) {
      var saved = byKey.get(item.row.dedupe_key);
      if (saved) idMap.set(item.sourceId, saved.id);
    });
    state.applications = state.applications.map(function (application) {
      var mapped = idMap.get(application.opportunityId);
      return mapped ? Object.assign({}, application, { opportunityId: mapped }) : application;
    });
    return result.data || [];
  }

  async function saveDashboardPayload() {
    if (!bridgeUser) return;
    var result = await bridgeClient.from('dashboard_state').upsert({
      user_id: bridgeUser.id,
      payload: state,
      updated_at: new Date().toISOString()
    });
    if (result.error) throw result.error;
  }

  function applicationToRow(application, validOpportunityIds) {
    var legacyId = application.id;
    var applicationId = isUuid(legacyId) ? legacyId : newOpportunityId();
    if (legacyId !== applicationId) {
      application.id = applicationId;
      state.opportunities = (state.opportunities || []).map(function (opportunity) {
        return opportunity.applicationId === legacyId
          ? Object.assign({}, opportunity, { applicationId: applicationId })
          : opportunity;
      });
    }
    var opportunityId = isUuid(application.opportunityId) && validOpportunityIds.has(application.opportunityId)
      ? application.opportunityId
      : null;
    return {
      id: applicationId,
      user_id: bridgeUser.id,
      opportunity_id: opportunityId,
      organization: cleanText(application.org, 'Organization not listed'),
      position: cleanText(application.position, 'Application record'),
      country: cleanText(application.country),
      contact: cleanText(application.contact),
      recipient_email: cleanText(application.recipient),
      source_url: normalizedUrl(application.source) || null,
      sent_at: dateOnly(application.sentDate) ? dateOnly(application.sentDate) + 'T00:00:00.000Z' : null,
      email_subject: cleanText(application.subject),
      email_body: cleanText(application.body, ''),
      cv_version: cleanText(application.cvVersion, 'CV v1'),
      email_version: cleanText(application.emailVersion, 'Email v1'),
      application_status: statusCode(application.status, true),
      notes: cleanText(application.notes)
    };
  }

  function rowToApplication(row, opportunitiesById) {
    var linked = row.opportunity_id ? opportunitiesById.get(row.opportunity_id) : null;
    return {
      id: row.id,
      opportunityId: row.opportunity_id || null,
      org: row.organization || linked?.org || 'Organization not listed',
      position: row.position || linked?.position || 'Application record',
      country: row.country || linked?.country || '',
      contact: row.contact || linked?.contact || '',
      recipient: row.recipient_email || '',
      sentDate: row.sent_at ? String(row.sent_at).slice(0, 10) : '',
      subject: row.email_subject || '',
      source: row.source_url || linked?.source || '',
      notes: row.notes || '',
      status: labelForApplicationStatus(row.application_status || 'already_sent'),
      cvVersion: row.cv_version || 'CV v1',
      emailVersion: row.email_version || 'Email v1',
      body: row.email_body || '',
      demo: false,
      createdManually: false
    };
  }

  async function upsertApplicationRows(applications, validOpportunityIds) {
    if (!applications.length) return;
    var rows = applications.map(function (application) {
      return applicationToRow(application, validOpportunityIds);
    });
    var result = await bridgeClient.from('application_records')
      .upsert(rows, { onConflict: 'id' }).select('*');
    if (result.error) throw result.error;
  }

  async function syncApplicationRecords() {
    if (window.__AIH_SKIP_CLOUD_SYNC || window.__AIH_DEMO_PREVIEW || !bridgeClient || !bridgeUser || !bridgeReady) return false;
    var opportunities = (state.opportunities || []).filter(function (opportunity) {
      return !opportunity.demo && isUuid(opportunity.id);
    });
    var validOpportunityIds = new Set(opportunities.map(function (opportunity) { return opportunity.id; }));
    var applications = (state.applications || []).filter(function (application) {
      return !application.demo && application.org && application.position;
    });
    await upsertApplicationRows(applications, validOpportunityIds);
    var pendingDeletes = Array.isArray(state.cloudApplicationDeleteQueue)
      ? state.cloudApplicationDeleteQueue.filter(isUuid)
      : [];
    if (pendingDeletes.length) {
      var deleteResult = await bridgeClient.from('application_records')
        .delete().eq('user_id', bridgeUser.id).in('id', pendingDeletes);
      if (deleteResult.error) throw deleteResult.error;
      state.cloudApplicationDeleteQueue = [];
      return true;
    }
    return false;
  }

  async function saveVersionedRow(table, filters, row) {
    var query = bridgeClient.from(table).select('id');
    Object.keys(filters).forEach(function (key) { query = query.eq(key, filters[key]); });
    var existing = await query.maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      var updateResult = await bridgeClient.from(table).update(row).eq('id', existing.data.id);
      if (updateResult.error) throw updateResult.error;
    } else {
      var insertResult = await bridgeClient.from(table).insert(row);
      if (insertResult.error) throw insertResult.error;
    }
  }

  function cvSnapshot(opportunity) {
    return JSON.stringify({
      organization: opportunity.org,
      position: opportunity.position,
      verifiedSkills: opportunity.verifiedSkills || [],
      projects: opportunity.projects || [],
      summary: opportunity.summary || '',
      missingSkills: opportunity.missingSkills || []
    });
  }

  async function syncNormalizedArtifacts() {
    if (window.__AIH_SKIP_CLOUD_SYNC || window.__AIH_DEMO_PREVIEW || !bridgeClient || !bridgeUser || !bridgeReady) return;
    var opportunities = (state.opportunities || []).filter(function (opportunity) {
      return !opportunity.demo && isUuid(opportunity.id);
    });
    var applicationsByOpportunity = new Map();
    (state.applications || []).forEach(function (application) {
      if (application.opportunityId && isUuid(application.id)) applicationsByOpportunity.set(application.opportunityId, application);
    });
    for (var i = 0; i < opportunities.length; i += 1) {
      var opportunity = opportunities[i];
      var cvVersion = versionNumber(opportunity.cvVersion, 1);
      var clearCvResult = await bridgeClient.from('cv_versions').update({ is_current: false })
        .eq('user_id', bridgeUser.id).eq('opportunity_id', opportunity.id);
      if (clearCvResult.error) throw clearCvResult.error;
      await saveVersionedRow('cv_versions', {
        user_id: bridgeUser.id,
        opportunity_id: opportunity.id,
        version: cvVersion
      }, {
        user_id: bridgeUser.id,
        opportunity_id: opportunity.id,
        version: cvVersion,
        is_current: true,
        change_summary: cvVersion > 1 ? 'Dashboard revision using verified evidence only.' : 'Initial dashboard CV version.',
        content: cvSnapshot(opportunity)
      });

      var application = applicationsByOpportunity.get(opportunity.id);
      var emailBody = (state.emailDrafts && state.emailDrafts[opportunity.id]) || application?.body || '';
      var emailVersion = versionNumber(opportunity.emailVersion || application?.emailVersion, 1);
      var hasEmailArtifact = Boolean(emailBody || application?.subject || application?.body || emailVersion > 1);
      if (hasEmailArtifact) {
        var clearEmailResult = await bridgeClient.from('email_drafts').update({ is_current: false })
          .eq('user_id', bridgeUser.id).eq('opportunity_id', opportunity.id);
        if (clearEmailResult.error) throw clearEmailResult.error;
        await saveVersionedRow('email_drafts', {
          user_id: bridgeUser.id,
          opportunity_id: opportunity.id,
          version: emailVersion
        }, {
          user_id: bridgeUser.id,
          opportunity_id: opportunity.id,
          application_id: application?.id || null,
          recipient: application?.recipient || opportunity.contact || null,
          subject: application?.subject || ('Application — ' + opportunity.position),
          body: emailBody,
          version: emailVersion,
          is_current: true
        });
      }
    }
  }

  function settingsRow() {
    var threshold = Number(state.threshold);
    if (!Number.isFinite(threshold)) threshold = 70;
    threshold = Math.max(0, Math.min(100, Math.round(threshold)));
    var target = Number(state.qualityTarget);
    if (!Number.isFinite(target)) target = 30;
    target = Math.max(0, Math.min(1000, Math.round(target)));
    return {
      user_id: bridgeUser.id,
      match_threshold: threshold,
      daily_opportunity_target: target,
      domain_relevance_enabled: state.domainRelevanceEnabled !== false,
      target_countries: Array.isArray(state.countries) ? state.countries : [],
      opportunity_types: Array.isArray(state.opportunityTypes) && state.opportunityTypes.length
        ? state.opportunityTypes
        : ['internship', 'research'],
      sender_identity_email: state.connectedEmail || null,
      provider_connection_status: state.providerConnectionStatus || (state.emailProviderConnected ? 'connected' : 'not_connected')
    };
  }

  async function loadProfileRegistry() {
    if (!bridgeClient || !bridgeUser) return;
    var factsResult = await bridgeClient.from('profile_facts').select('*').order('category', { ascending: true }).order('name', { ascending: true });
    if (factsResult.error) throw factsResult.error;
    var facts = factsResult.data || [];
    var evidenceResult = await bridgeClient.from('profile_fact_evidence').select('*');
    if (evidenceResult.error) throw evidenceResult.error;
    var evidenceByFact = new Map();
    (evidenceResult.data || []).forEach(function (evidence) {
      if (!evidenceByFact.has(evidence.fact_id)) evidenceByFact.set(evidence.fact_id, []);
      evidenceByFact.get(evidence.fact_id).push(evidence);
    });
    state.profileFacts = facts.map(function (fact) {
      return Object.assign({}, fact, { evidence: evidenceByFact.get(fact.id) || [] });
    });
    var runsResult = await bridgeClient.from('profile_sync_runs').select('*').order('started_at', { ascending: false }).limit(1);
    if (runsResult.error) throw runsResult.error;
    state.profileSync = (runsResult.data || [])[0] || null;
  }

  async function loadUserSettings() {
    var result = await bridgeClient.from('user_settings').select('*').eq('user_id', bridgeUser.id).maybeSingle();
    if (result.error) throw result.error;
    if (result.data) {
      state.threshold = result.data.match_threshold;
      state.qualityTarget = result.data.daily_opportunity_target;
      state.countries = Array.isArray(result.data.target_countries) ? result.data.target_countries : state.countries;
      state.domainRelevanceEnabled = result.data.domain_relevance_enabled !== false;
      state.opportunityTypes = Array.isArray(result.data.opportunity_types) && result.data.opportunity_types.length
        ? result.data.opportunity_types
        : ['internship', 'research'];
      state.providerConnectionStatus = result.data.provider_connection_status || 'not_connected';
      state.emailProviderConnected = state.providerConnectionStatus === 'connected';
      state.connected = state.providerConnectionStatus === 'connected';
      state.connectedEmail = result.data.sender_identity_email || '';
    } else {
      var initialSettings = await bridgeClient.from('user_settings').upsert(settingsRow(), { onConflict: 'user_id' });
      if (initialSettings.error) throw initialSettings.error;
    }
  }

  async function syncUserSettings() {
    if (!bridgeUser) return;
    var result = await bridgeClient.from('user_settings').upsert(settingsRow(), { onConflict: 'user_id' });
    if (result.error) throw result.error;
  }

  async function loadNormalizedApplications() {
    var pendingDeletes = Array.isArray(state.cloudApplicationDeleteQueue)
      ? state.cloudApplicationDeleteQueue.filter(isUuid)
      : [];
    if (pendingDeletes.length) {
      var deleteResult = await bridgeClient.from('application_records')
        .delete().eq('user_id', bridgeUser.id).in('id', pendingDeletes);
      if (deleteResult.error) throw deleteResult.error;
      state.cloudApplicationDeleteQueue = [];
    }

    var opportunitiesById = new Map((state.opportunities || []).map(function (opportunity) {
      return [opportunity.id, opportunity];
    }));
    var validOpportunityIds = new Set(Array.from(opportunitiesById.keys()).filter(isUuid));
    var legacyApplications = (state.applications || []).filter(function (application) {
      return !application.demo && application.org && application.position;
    });
    if (legacyApplications.length) {
      await upsertApplicationRows(legacyApplications, validOpportunityIds);
    }
    var result = await bridgeClient.from('application_records').select('*').order('sent_at', { ascending: false });
    if (result.error) throw result.error;
    var demoApplications = (state.applications || []).filter(function (application) { return application.demo; });
    state.applications = (result.data || []).map(function (row) {
      return rowToApplication(row, opportunitiesById);
    }).concat(demoApplications);
  }

  async function loadNormalizedArtifacts() {
    var cvResult = await bridgeClient.from('cv_versions').select('*').eq('is_current', true);
    if (cvResult.error) throw cvResult.error;
    (cvResult.data || []).forEach(function (row) {
      var opportunity = (state.opportunities || []).find(function (item) { return item.id === row.opportunity_id; });
      if (opportunity) opportunity.cvVersion = 'CV v' + row.version;
    });
    var emailResult = await bridgeClient.from('email_drafts').select('*').eq('is_current', true);
    if (emailResult.error) throw emailResult.error;
    state.emailDrafts = state.emailDrafts || {};
    (emailResult.data || []).forEach(function (row) {
      if (!row.opportunity_id) return;
      state.emailDrafts[row.opportunity_id] = row.body || '';
      var opportunity = (state.opportunities || []).find(function (item) { return item.id === row.opportunity_id; });
      if (opportunity) opportunity.emailVersion = 'Email v' + row.version;
      var application = (state.applications || []).find(function (item) { return item.id === row.application_id; });
      if (application) {
        application.body = row.body || application.body || '';
        application.emailVersion = 'Email v' + row.version;
      }
    });
  }

  async function flushOpportunityDeleteQueue() {
    var pendingDeletes = Array.isArray(state.cloudOpportunityDeleteQueue)
      ? state.cloudOpportunityDeleteQueue.filter(isUuid)
      : [];
    if (!pendingDeletes.length) return false;
    var deleteResult = await bridgeClient.from('opportunity_records')
      .delete().eq('user_id', bridgeUser.id).in('id', pendingDeletes);
    if (deleteResult.error) throw deleteResult.error;
    state.cloudOpportunityDeleteQueue = [];
    return true;
  }

  async function loadOpportunityRecords() {
    if (!bridgeClient) return;
    var sessionResult = await bridgeClient.auth.getSession();
    bridgeUser = sessionResult.data && sessionResult.data.session ? sessionResult.data.session.user : null;
    if (!bridgeUser || !window.AIH_isOwnerSession || !window.AIH_isOwnerSession(bridgeUser)) {
      bridgeUser = null;
      bridgeReady = false;
      return;
    }
    await loadUserSettings();
    try {
      await loadProfileRegistry();
    } catch (error) {
      console.error('Profile registry could not be loaded', error);
      state.profileFacts = [];
      state.profileSync = null;
    }
    var opportunityQueueChanged = await flushOpportunityDeleteQueue();
    var result = await bridgeClient.from('opportunity_records').select('*').order('updated_at', { ascending: false });
    if (result.error) throw result.error;
    var rows = result.data || [];
    if (!rows.length) {
      var legacy = (state.opportunities || []).filter(function (opportunity) {
        return !opportunity.demo && opportunity.org && opportunity.position;
      });
      if (legacy.length) {
        rows = await migrateLegacyOpportunities(legacy);
        await saveDashboardPayload();
      }
    }
    knownOpportunityIds = new Set(rows.map(function (row) { return row.id; }));
    var demoRows = (state.opportunities || []).filter(function (opportunity) { return opportunity.demo; });
    state.opportunities = rows.map(rowToOpportunity).concat(demoRows);
    await loadNormalizedApplications();
    await loadNormalizedArtifacts();
    bridgeReady = true;
    if (opportunityQueueChanged) await saveDashboardPayload();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render();
  }

  async function syncOpportunityRecords() {
    if (window.__AIH_SKIP_CLOUD_SYNC || window.__AIH_DEMO_PREVIEW || !bridgeClient || !bridgeUser || !bridgeReady) return;
    var opportunities = (state.opportunities || []).filter(function (opportunity) {
      return !opportunity.demo && opportunity.org && opportunity.position;
    });
    var rows = [];
    for (var i = 0; i < opportunities.length; i += 1) {
      rows.push(await opportunityToRow(opportunities[i], bridgeUser.id));
    }
    var currentIds = new Set(rows.map(function (row) { return row.id; }));
    if (rows.length) {
      var upsertResult = await bridgeClient.from('opportunity_records')
        .upsert(rows, { onConflict: 'id' }).select('*');
      if (upsertResult.error) throw upsertResult.error;
      (upsertResult.data || []).forEach(function (row) { currentIds.add(row.id); });
    }
    var pendingDeletes = Array.isArray(state.cloudOpportunityDeleteQueue)
      ? state.cloudOpportunityDeleteQueue.filter(isUuid)
      : [];
    if (pendingDeletes.length) {
      var deleteResult = await bridgeClient.from('opportunity_records')
        .delete().eq('user_id', bridgeUser.id).in('id', pendingDeletes);
      if (deleteResult.error) throw deleteResult.error;
      state.cloudOpportunityDeleteQueue = [];
    }
    knownOpportunityIds = currentIds;
    return pendingDeletes.length > 0;
  }

  window.persist = function () {
    var priorResult;
    try { priorResult = priorPersist && priorPersist(); } catch (error) { console.error('Dashboard persistence failed', error); }
    syncQueue = syncQueue.then(async function () {
      await syncUserSettings();
      var opportunityQueueChanged = await syncOpportunityRecords();
      var applicationQueueChanged = await syncApplicationRecords();
      await syncNormalizedArtifacts();
      if (opportunityQueueChanged || applicationQueueChanged) await saveDashboardPayload();
    }).catch(function (error) {
      console.error('Opportunity record sync failed', error);
      toast('Opportunity changes were kept locally, but Supabase sync failed.', true);
    });
    return priorResult || syncQueue;
  };

  var loadTimer;
  function scheduleLoad(delay) {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(function () {
      loadOpportunityRecords().catch(function (error) {
        console.error('Opportunity records could not be loaded', error);
      });
    }, delay);
  }

  if (bridgeClient) {
    bridgeClient.auth.onAuthStateChange(function () {
      scheduleLoad(250);
    });
    // Let the existing dashboard_state loader finish before replacing its
    // opportunity array with the normalized opportunity_records rows.
    scheduleLoad(1200);
  }
})();

