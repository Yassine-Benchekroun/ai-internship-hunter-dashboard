// Step 2 privacy bridge: render only the authenticated user's configured
// profile sources. Signed-out and first-account states intentionally render no
// source URLs or profile facts.
(function () {
  'use strict';

  function configuredSources() {
    if (!window.__AIH_AUTHENTICATED_SESSION || !Array.isArray(state.approvedProfileSources)) return [];
    return state.approvedProfileSources.filter(function (source) {
      return source && typeof source === 'object' && safeUrl(source.source_url);
    });
  }

  function safeUrl(value) {
    try {
      var url = new URL(String(value || ''));
      return url.protocol === 'https:' && url.hostname ? url.href : '';
    } catch (error) {
      return '';
    }
  }

  function sourceLabel(source) {
    return String(source.source_name || source.source_type || 'Approved source');
  }

  function sourceLinksHTML() {
    var sources = configuredSources();
    if (!sources.length) return '<span class="muted">No approved profile sources configured.</span>';
    return sources.map(function (source) {
      var url = safeUrl(source.source_url);
      return '<a class="source-link" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(sourceLabel(source)) + ' ' + icon('external') + '</a>';
    }).join('');
  }

  function renderConfiguredSources() {
    var sources = configuredSources();
    document.querySelectorAll('.section-space').forEach(function (section) {
      var heading = section.querySelector('.panel-head h3');
      if (!heading || heading.textContent.trim() !== 'Source registry') return;
      var count = section.querySelector('.panel-head .pill');
      if (count) count.textContent = sources.length + (sources.length === 1 ? ' source' : ' sources');
      var list = section.querySelector('.list-stack');
      if (list) list.innerHTML = sourceLinksHTML();
    });

    var banner = document.querySelector('.source-banner');
    if (banner && state.route === 'profile') {
      banner.innerHTML = '<div><h3>Approved sources</h3><div class="panel-kicker">Only configured user-owned sources may add profile facts.</div></div><div class="source-links">' + sourceLinksHTML() + '</div>';
    }
  }

  var previousRender = render;
  render = function () {
    previousRender();
    renderConfiguredSources();
  };
  window.AIH_renderConfiguredSources = renderConfiguredSources;
  renderConfiguredSources();
})();
