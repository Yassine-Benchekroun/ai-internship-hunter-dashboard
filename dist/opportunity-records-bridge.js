// Connect the dashboard's opportunity model to the normalized Supabase table.
// Applications, settings, and email drafts remain in dashboard_state.
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
      status: row.status || 'Needs review',
      discovered: String(row.first_discovered_at || '').slice(0, 10),
      lastChecked: String(row.last_checked_at || '').slice(0, 10),
      source: displayUrl(row.source_url),
      description: row.description || '',
      requirements: arrayValue(row.requirements),
      verifiedSkills: arrayValue(row.verified_skills),
      missingSkills: arrayValue(row.missing_skills),
      projects: arrayValue(row.projects),
      breakdown: row.score_breakdown && typeof row.score_breakdown === 'object' ? row.score_breakdown : {},
      activeSections: Array.isArray(row.active_sections) && row.active_sections.length ? row.active_sections : ['new'],
      sent: Boolean(row.sent),
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
    return {
      id: isUuid(opportunity.id) ? opportunity.id : newOpportunityId(),
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
      score_breakdown: opportunity.breakdown && typeof opportunity.breakdown === 'object' ? opportunity.breakdown : {},
      deadline: dateOnly(opportunity.deadline),
      funding: cleanText(opportunity.funding),
      work_mode: cleanText(opportunity.workMode),
      status: cleanText(opportunity.status, 'Needs review'),
      first_discovered_at: timestampOrNow(opportunity.discovered),
      last_checked_at: timestampOrNow(opportunity.lastChecked || opportunity.discovered),
      source_url: sourceUrl,
      description: cleanText(opportunity.description),
      requirements: arrayValue(opportunity.requirements),
      verified_skills: arrayValue(opportunity.verifiedSkills),
      missing_skills: arrayValue(opportunity.missingSkills),
      projects: arrayValue(opportunity.projects),
      active_sections: Array.isArray(opportunity.activeSections) && opportunity.activeSections.length
        ? opportunity.activeSections : ['new'],
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

  async function loadOpportunityRecords() {
    if (!bridgeClient) return;
    var sessionResult = await bridgeClient.auth.getSession();
    bridgeUser = sessionResult.data && sessionResult.data.session ? sessionResult.data.session.user : null;
    if (!bridgeUser) {
      bridgeReady = false;
      return;
    }
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
    bridgeReady = true;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render();
  }

  async function syncOpportunityRecords() {
    if (!bridgeClient || !bridgeUser || !bridgeReady) return;
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
        .upsert(rows, { onConflict: 'user_id,dedupe_key' }).select('*');
      if (upsertResult.error) throw upsertResult.error;
      (upsertResult.data || []).forEach(function (row) { currentIds.add(row.id); });
    }
    var removedIds = Array.from(knownOpportunityIds).filter(function (id) { return !currentIds.has(id); });
    if (removedIds.length) {
      var deleteResult = await bridgeClient.from('opportunity_records')
        .delete().eq('user_id', bridgeUser.id).in('id', removedIds);
      if (deleteResult.error) throw deleteResult.error;
    }
    knownOpportunityIds = currentIds;
  }

  window.persist = function () {
    var priorResult;
    try { priorResult = priorPersist && priorPersist(); } catch (error) { console.error('Dashboard persistence failed', error); }
    syncQueue = syncQueue.then(function () { return syncOpportunityRecords(); }).catch(function (error) {
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

