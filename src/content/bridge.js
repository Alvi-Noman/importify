// Runs in the page's own JS world so it can read the data objects Alibaba
// embeds in the page (e.g. window.detailData). Content scripts live in an
// isolated world and cannot see these globals directly.
(() => {
  const KEYS = ['detailData', '__INIT_DATA__', '__page_data__', 'pageData', 'runParams', '__NEXT_DATA__'];

  function snapshot() {
    const out = {};
    for (const key of KEYS) {
      try {
        const value = window[key];
        if (value && typeof value === 'object') out[key] = JSON.parse(JSON.stringify(value));
      } catch (_) {
        // circular or non-serialisable – skip
      }
    }
    return out;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.__importify !== 'request') return;
    window.postMessage({ __importify: 'response', id: event.data.id, data: snapshot() }, location.origin);
  });
})();
