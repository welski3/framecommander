/* Frame Commander — manifest-driven RunningHub UI.
   Everything the app can do comes from api/manifest.json:
   each entry = one workflow = one capability (form fields -> nodeInfoList overrides).
   Field def types: text | textarea | number | slider | select | tabs | iconselect | checkbox | seed | media
   `local: true` = an app-side switch (Singularity V2): shown in the form, never sent as a node value. */
'use strict';

(() => {
  const DONE_STATES = ['SUCCESS', 'FAIL', 'FAILED', 'PARTIAL_SUCCESS', 'CANCEL', 'CANCELED', 'CANCELLED'];
  const isCancelState = (st) => /^CANCEL/.test(st);
  /* watchdog: a task must not sit in the run list forever */
  const POLL_MS = 10000;                 // normal status poll interval
  const POLL_ERR_LIMIT = 6;              // consecutive status errors before we give up watching
  const QUEUE_STUCK_MS = 10 * 60 * 1000; // still queued this long -> treat as stuck
  const RUN_STUCK_MS = 20 * 60 * 1000;   // no verdict this long -> stop watching
  /* outputs: page the DOM, keep more in storage; 15 per page in both views */
  const OUTPUT_PAGE = 15;
  const OUTPUT_STORE_MAX = 30;
  /* RunningHub keeps finished output files for 14 days — past that the CDN
     links die, so old cards gray out with an "expired" badge */
  const EXPIRE_DAYS = 14;
  const KEY_STORE = 'wr.settings.v1';
  const OUT_STORE = 'wr.outputs.v1';
  const FORM_STORE = 'wr.form.v1';   // last-used form values per workflow (not prompt/seed)
  const PROMPT_SOFT_MAX = 5000;      // prompt counter turns yellow past this
  /* The prompt optimizer runs HERE, in the browser, using the official H3 guide shipped
     in guides/ (js/h3-optimizer.js). The workflow's own node-side optimizer is left off
     so the prompt is only rewritten once. */

  const $ = (sel, el = document) => el.querySelector(sel);

  function h(tag, attrs = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  const randSeed = () => Math.floor(Math.random() * 2 ** 48);
  const fmtSecs = (x) => {
    const n = Number(x);
    if (!Number.isFinite(n)) return '?';
    const m = Math.floor(n / 60), s = Math.round(n % 60);
    return m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
  };

  /* ---------------- state ---------------- */
  const state = {
    current: null,        // manifest entry
    workflowJson: null,   // fetched api/*.json for the current entry
    fieldMap: {},         // key -> { def, input, random?, bucketEls? }
    mediaDef: null,
    mediaPaste: null,      // Ctrl+V routing for the live media section (set by its builder)
    uploads: { images: [], audios: [], videos: [] },  // { file, id, assetId? }
    keyframes: { first: null, last: null },           // I2V/FL2VA slot files { file, id, assetId? }
    uploadSeq: 0,
    assets: [],            // local asset library (IndexedDB), max ASSET_MAX
    assetsById: new Map(),
    runs: new Map(),        // taskId -> active run context
    pollClock: null,
    outputsEntries: [],     // persisted, latest first
    outputsShown: OUTPUT_PAGE,   // how many of them are currently in the DOM
    favFilter: false,       // Favorites button: grid shows only starred entries
    busy: false,
    settings: { apiKey: '', base: 'https://www.runninghub.ai', sound: true, optimizer: { enabled: false, provider: 'gemini', apiKey: '', readMedia: true, openaiBaseUrl: '', openaiKey: '', openaiModel: '' } },
  };

  const loadSettings = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(KEY_STORE) || '{}');
      Object.assign(state.settings, stored);
      /* deep-merge the optimizer block so a stored copy from an older version
         can't drop newer defaults (e.g. readMedia silently becoming false) */
      state.settings.optimizer = { enabled: false, provider: 'gemini', apiKey: '', readMedia: true, openaiBaseUrl: '', openaiKey: '', openaiModel: '', ...(stored.optimizer || {}) };
      delete state.settings.workflowIds;   // per-user Workflow ID overrides were removed — drop old ones on the next save
      delete state.settings.singularity;   // Singularity V2 moved from Settings to the form's Advanced section
    } catch (e) { /* ignore */ }
  };
  /* writes must never throw: iOS Safari private mode / a full quota used to kill
     output rendering (addOutputEntry persists BEFORE it renders) mid-run */
  const saveSettings = () => {
    try { localStorage.setItem(KEY_STORE, JSON.stringify(state.settings)); } catch (e) { /* session-only */ }
  };

  /* RH Coin consumption = account-balance delta around the run (best effort;
     'n/a' when RunningHub doesn't expose a balance for this key) */
  const coinNum = (d) => {
    if (d == null) return null;
    if (typeof d === 'number') return d;
    const c = d.creditInfo && (d.creditInfo.creditCount ?? d.creditInfo.credit);
    if (c != null) return parseFloat(c);
    for (const k of ['remainCoins', 'creditCount', 'credit', 'balance', 'coins', 'amount']) {
      if (d[k] != null && Number.isFinite(parseFloat(d[k]))) return parseFloat(d[k]);
    }
    return null;
  };
  const coinDelta = (before, after) => {
    const b = coinNum(before), a = coinNum(after);
    return (b == null || a == null) ? 'n/a' : String(Math.round(Math.max(0, b - a)));
  };

  /* RH Coin -> USD: RunningHub pricing is 10 USD = 36000 RH Coins
     → $0.0002778 per coin ($1 = 3600 coins). 3-decimal precision
     (tenths of a cent) so small runs don't lose their cost. */
  const COINS_PER_USD = 3600;
  const usdFromCoins = (coins) => {
    const n = parseFloat(coins);
    if (!Number.isFinite(n) || n <= 0) return null;
    const v = n / COINS_PER_USD;
    if (v < 0.0005) return '<$0.001';
    return `$${v.toFixed(3)}`;
  };

  const fieldByName = (name) => Object.values(state.fieldMap).find((e) => e.def.fieldName === name) || null;
  const isReferenceMode = () => (fieldByName('mode')?.input.value === 'reference');

  /* Steps for the output meta strip — straight from the Steps dropdown */
  function formSteps() {
    const entry = fieldByName('steps');
    return entry ? parseFloat(entry.input.value) : null;
  }
  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* @ImageN / @VideoN / @AudioN references get bold + teal in the prompt backdrop,
     but only in Reference mode — in other modes they would not bind to anything */
  function highlightPromptHtml(text, refsOn) {
    let html = escapeHtml(text);
    if (refsOn) html = html.replace(/@(?:Image|Video|Audio)\d+\b/gi, (m) => `<span class="ref-tag">${m}</span>`);
    return html + '\n';
  }

  /* ---------------- tiny DOM helpers ---------------- */
  const alertArea = () => $('#alert-area');
  function showAlert(kind, ...kids) {
    alertArea().replaceChildren(h('div', { class: `c-alert c-alert--${kind} u-window-box-small` }, ...kids));
  }
  const clearAlerts = () => alertArea().replaceChildren();
  const statusLine = (text, spin = true) => {
    const out = $('#status-line');
    if (out) out.replaceChildren(...[text, spin ? h('span', { class: 'dots' }) : null].filter(Boolean));
  };

  /* ---------------- boot ---------------- */
  async function boot() {
    loadSettings();
    /* unlock the completion chime's AudioContext on the first click anywhere —
       the browser only lets audio start from a user gesture */
    document.addEventListener('pointerdown', ensureAudio);
    /* Ctrl+Enter (⌘+Enter too) = ▶ Generate Video, from anywhere in the app —
       including straight out of the prompt textarea. Skipped while the Settings
       or Assets dialogs are open; run() itself re-checks busy/validation. */
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
      if ($('#settings-dlg').open || $('#asset-dlg').open) return;
      const btn = $('#btn-run');
      if (btn && !btn.disabled) { e.preventDefault(); run(); }
    });
    /* Ctrl+V an image/file straight into the media inputs from anywhere in the
       main window — the live media section registers itself as state.mediaPaste
       (reference mode: the dropzone; I2V mode: first frame, then last frame).
       Text-only pastes fall through to the focused input untouched. */
    document.addEventListener('paste', (e) => {
      if ($('#settings-dlg').open || $('#asset-dlg').open) return;
      const files = filesFromClipboard(e.clipboardData);
      if (!files.length || !state.mediaPaste) return;
      e.preventDefault();
      state.mediaPaste(files);
    });
    wireFavButton();
    wireBalance();
    wireSettingsDialog();
    wireAssetDialog();
    // re-wrap the auto-growing prompt box when the window (sidebar) width changes
    window.addEventListener('resize', () => { if (state.autoGrow) state.autoGrow(); });
    await loadAssets();
    let manifest;
    try {
      manifest = await (await fetch('./api/manifest.json?t=' + Date.now())).json();
    } catch (e) {
      showAlert('error', h('strong', {}, 'api/manifest.json could not be loaded. '),
        'Serve this folder over HTTP (Netlify Drop, or any static server) — browsers block fetch() on file:// pages.');
      return;
    }
    const workflows = Array.isArray(manifest.workflows) ? manifest.workflows : [];
    if (!workflows.length) { showAlert('warning', 'api/manifest.json has no workflows yet.'); }
    FCActions.init(manifest.actions || []);
    restoreStoredOutputs();   // after actions init — action buttons (Upscale) must exist per entry
    renderNav(workflows);
    window.addEventListener('hashchange', () => {
      const wf = workflows.find((w) => w.id === location.hash.slice(1));
      if (wf && wf !== state.current) selectWorkflow(wf);
    });
    const first = workflows.find((w) => w.id === location.hash.slice(1)) || workflows[0];
    if (first) selectWorkflow(first);
  }

  /* ---------------- Favorites filter (the grid itself is the only view) ---------------- */
  /* one star icon everywhere: stroked outline = not favorited, solid = favorited.
     An SVG glyph instead of the ☆/★ text characters so the shape is identical
     in every font and crisp at any zoom. */
  function starSvg(filled) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z');
    if (filled) {
      path.setAttribute('fill', 'currentColor');
    } else {
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.7');
      path.setAttribute('stroke-linejoin', 'round');
    }
    svg.append(path);
    return svg;
  }

  /* download glyph for the output cards — same 15px stroked SVG style as the star */
  function downloadSvg() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '15', height: '15', 'aria-hidden': 'true',
      fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) {
      svg.setAttribute(k, v);
    }
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M12 3.5v11.5M7 10.5l5 5 5-5M4.5 20.5h15');
    svg.append(path);
    return svg;
  }

  function updateFavButton() {
    const b = $('#btn-favs');
    if (!b) return;
    b.replaceChildren(starSvg(state.favFilter), ' Favorites');
    b.classList.toggle('fav-on', state.favFilter);
    b.title = state.favFilter ? 'back to all videos' : 'show only favorite videos';
  }

  function wireFavButton() {
    const b = $('#btn-favs');
    if (!b) return;
    b.addEventListener('click', () => {
      state.favFilter = !state.favFilter;
      renderOutputList();
      updateFavButton();
    });
    updateFavButton();
  }

  /* ---------------- nav + workflow head ---------------- */
  function renderNav(workflows) {
    const nav = $('#wf-nav');
    if (workflows.length < 2) { nav.replaceChildren(); return; }   // single workflow: no switcher
    nav.replaceChildren(...workflows.map((wf) =>
      h('button', {
        class: 'c-button c-button--ghost', type: 'button', 'data-wf': wf.id,
        onclick: () => selectWorkflow(wf),
      }, `${wf.icon || '▶'} ${wf.name}`)));
  }

  function markActiveNav() {
    for (const b of $('#wf-nav').children) {
      b.classList.toggle('c-button--active', b.dataset.wf === state.current.id);
    }
  }

  /* always the manifest's published ID — the per-user override was removed, and
     any ID saved by an older version is ignored so nobody stays stuck on it */
  function getWorkflowId(wf) {
    return wf.workflowId || '';
  }

  function workflowIdOk(wf) {
    const id = getWorkflowId(wf);
    return !!id && !/PASTE|YOUR_|REPLACE|HERE|XXXX/i.test(id);
  }

  function selectWorkflow(wf) {
    state.current = wf;
    state.workflowJson = null;
    state.uploads = { images: [], audios: [], videos: [] };
    state.keyframes = { first: null, last: null };
    location.hash = wf.id;
    markActiveNav();
    renderForm();
    renderRunBar();
    clearAlerts();   // outputs stay: they are persistent and workflow-independent
    state.templateProblems = [];
    if (wf.file) {
      fetch('./api/' + wf.file + '?t=' + Date.now())
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then((json) => {
          if (state.current !== wf) return;   // switched tabs while loading
          state.workflowJson = json;
          state.templateProblems = templateProblems(wf, json);
          if (state.templateProblems.length) showTemplateProblems(wf);
        })
        .catch(() => { state.workflowJson = null; });
    }
  }

  /* Workflow-file check: every node + input the app writes must exist in
     api/<file>. A canvas change that was never re-exported otherwise fails
     mid-run (missing node) or is silently ignored (renamed input). The
     APP_PATCHED pairs mirror the values buildNodeInfoList asserts itself. */
  const APP_PATCHED = [['229', 'strength_model'], ['207', 'shift_video'], ['207', 'shift_audio'], ['261', 'lowres_scale']];
  function templateProblems(wf, json) {
    const want = [];
    const add = (nodeId, fieldName) => want.push([String(nodeId), fieldName]);
    for (const f of wf.fields || []) {
      /* presets and override-checkboxes never send their own value */
      if (f.type !== 'media' && !f.local && !f.presets && !(f.type === 'checkbox' && f.overrides)) add(f.nodeId, f.fieldName);
      for (const sets of [f.overrides, f.optionOverrides, f.presets]) {
        for (const set of Object.values(sets || {})) {
          for (const [nodeId, fields] of Object.entries(set || {})) Object.keys(fields).forEach((fn) => add(nodeId, fn));
        }
      }
    }
    for (const [nodeId, fields] of Object.entries(wf.normalize || {})) Object.keys(fields).forEach((fn) => add(nodeId, fn));
    for (const nodeId of wf.outputNodes || []) add(nodeId, null);
    const ml = wf.mediaLoaders;
    if (ml) {
      add(ml.target, null);
      for (const kind of ['image', 'video', 'audio']) if (ml[kind]) add(ml[kind].nodeId, ml[kind].fieldName);
    }
    for (const [nodeId, fn] of APP_PATCHED) add(nodeId, fn);
    if (wf.singularity) wf.singularity.bridgeInputs.forEach((fn) => add(wf.singularity.bridgeNode, fn));
    const out = new Set();
    if (wf.singularity && json[wf.singularity.nodeId]) out.add(`node ${wf.singularity.nodeId} is taken — change "singularity.nodeId" in api/manifest.json`);
    for (const [nodeId, fn] of want) {
      const node = json[nodeId];
      if (!node) out.add(`node ${nodeId} is missing`);
      else if (fn && !(fn in (node.inputs || {}))) out.add(`node ${nodeId} (${node.class_type}) has no "${fn}" input`);
    }
    return [...out];
  }

  function showTemplateProblems(wf) {
    showAlert('warning', h('strong', {}, `api/${wf.file} is out of date. `),
      state.templateProblems.join(' · '),
      h('div', { class: 'fail-hint-note' }, 'Re-export the workflow from ComfyUI (Export (API)) into this file, then refresh. Generate is blocked until it matches.'));
  }

  const optionList = (def) => (def.options || []).map((o) =>
    (typeof o === 'string' || typeof o === 'number') ? { value: o, label: String(o) } : o);

  function fieldWrapper(def, ...control) {
    return h('div', { class: 'wf-field' },
      def.label ? h('label', { class: 'c-label' }, def.label) : null,
      ...control,
      def.help ? h('div', { class: 'c-hint' }, def.help) : null);
  }

  function buildControl(def) {
    const key = def.nodeId + '.' + def.fieldName;
    const entry = { def };

    if (def.type === 'textarea') {
      entry.input = h('textarea', { class: 'c-textarea', placeholder: def.placeholder || '' });
    } else if (def.type === 'slider') {
      entry.input = h('input', { class: 'c-range', type: 'range',
        min: def.min ?? 0, max: def.max ?? 100, step: def.step || 1, value: def.default ?? def.min ?? 0 });
      return entry;
    } else if (def.type === 'iconselect') {
      entry.value = String(def.default ?? '');
      entry.buttons = optionList(def).map((o) => {
        const visual = o.shape
          ? h('span', { class: 'shape-rect' + (o.shape === 'portrait' ? ' shape-rect--portrait' : ''), 'aria-hidden': 'true' })
          : (o.icon || o.label || o.value);
        return h('button', {
          class: 'c-button icon-btn', type: 'button', title: o.label || o.value, 'aria-label': o.label || o.value,
          onclick: () => { entry.value = o.value; entry.sync(); },
        }, visual);
      });
      entry.sync = () => optionList(def).forEach((o, i) => entry.buttons[i].classList.toggle('icon-btn--active', o.value === entry.value));
      entry.input = null;  // payload path reads entry.value
      return entry;
    } else if (def.type === 'tabs') {
      // Blaze tab buttons driving a hidden <select>, so `.input.value` and the
      // 'change' events behave exactly like a normal select everywhere else
      entry.input = h('select', { hidden: '' },
        ...optionList(def).map((o) => h('option', { value: o.value }, o.label)));
      entry.input.value = String(def.default ?? optionList(def)[0]?.value ?? '');
      const opts = optionList(def);
      const buttons = opts.map((o) => h('button', {
        class: 'c-tab-heading', type: 'button', role: 'tab',
        onclick: () => { entry.input.value = o.value; syncTabs(); entry.input.dispatchEvent(new Event('change', { bubbles: true })); },
      }, o.label || o.value));
      const syncTabs = () => opts.forEach((o, i) => {
        const on = String(o.value) === entry.input.value;
        buttons[i].classList.toggle('c-tab-heading--active', on);
        buttons[i].setAttribute('aria-selected', String(on));
      });
      entry.tabsEl = h('div', { class: 'c-tabs', role: 'tablist' },
        h('div', { class: 'c-tabs__nav' }, h('div', { class: 'c-tabs__headings' }, ...buttons)));
      entry.sync = syncTabs;   // lets a stored run restore the tabs
      syncTabs();
      return entry;
    } else if (def.type === 'select') {
      entry.input = h('select', { class: 'c-select' },
        ...optionList(def).map((o) => h('option', { value: o.value }, o.label)));
      entry.input.value = String(def.default ?? optionList(def)[0]?.value ?? '');
    } else if (def.type === 'number') {
      entry.input = h('input', { class: 'c-input', type: 'number', value: def.default ?? '',
        ...(def.min != null ? { min: def.min } : {}), ...(def.max != null ? { max: def.max } : {}),
        ...(def.step != null ? { step: def.step } : {}) });
    } else if (def.type === 'checkbox') {
      entry.input = h('input', { type: 'checkbox' });
      entry.input.checked = !!def.default;
    } else if (def.type === 'seed') {
      entry.input = h('input', { class: 'c-input', type: 'text', inputmode: 'numeric', placeholder: 'leave empty for a fresh seed each run' });
      return entry;
    } else { // text
      entry.input = h('input', { class: 'c-input', type: 'text', value: def.default ?? '', placeholder: def.placeholder || '' });
    }
    return entry;
  }

  function mediaSection() {
    const host = h('div', {});
    const build = () => {
      state.mediaPaste = null;   // the new builder re-registers it below — no stale routing
      host.replaceChildren(isReferenceMode() ? referenceDropzone() : keyframeInputs());
      if (state.keyframeRoleSync) state.keyframeRoleSync();   // the role toggle shows in I2V mode only
    };
    state.mediaRedraw = build;   // mode change swaps the whole section
    build();
    return h('div', { class: 'wf-field media-section' }, host);
  }

  /* Reference mode: dropzone with thumbnails + @ImageN-style tag chips */
  function referenceDropzone() {
    const buckets = state.mediaDef.buckets || [];
    const maxOf = (key) => (buckets.find((b) => b.key === key) || {}).max;
    const total = () => state.uploads.images.length + state.uploads.audios.length + state.uploads.videos.length;
    const gridEl = h('div', { class: 'media-grid' });
    const noteEl = h('div', { class: 'media-note' });
    const hint = h('div', { class: 'media-hint' }, 'Drop, paste (Ctrl+V) or click to add files');
    const fileInput = h('input', { type: 'file', multiple: '', accept: 'image/*,video/*,audio/*', hidden: '' });
    const drop = h('div', { class: 'media-dropzone' }, hint, gridEl, fileInput);

    const insertTag = (tag) => {
      const entry = fieldByName('prompt');
      if (!entry) return;
      const ta = entry.input;
      const len = ta.value.length;
      // never-focused box: append where the user can see it, not at caret 0
      const start = ta.dataset.touched ? (ta.selectionStart ?? len) : len;
      const end = ta.dataset.touched ? (ta.selectionEnd ?? start) : len;
      const before = ta.value.slice(0, start);
      const glue = before && !/\s$/.test(before) ? ' ' : '';
      ta.value = before + glue + tag + ta.value.slice(end);
      ta.focus();
      const pos = (before + glue + tag).length;
      ta.setSelectionRange(pos, pos);
      ta.dispatchEvent(new Event('input', { bubbles: true }));   // highlight + grow
    };

    const redraw = () => {
      const cards = [];
      for (const k of ['images', 'videos', 'audios']) {
        state.uploads[k].forEach((it, i) => {
          const tag = `@${k === 'images' ? 'Image' : k === 'videos' ? 'Video' : 'Audio'}${i + 1}`;
          let visual;
          if (k === 'images') {
            visual = h('img', { class: 'media-thumb', src: thumbUrl(it), alt: '' });
          } else if (k === 'videos') {
            const img = h('img', { class: 'media-thumb', alt: '' });
            videoThumbnail(it, img);
            visual = h('div', { class: 'media-thumb-wrap' }, img,
              h('span', { class: 'media-icon-overlay' }, '▶'));
          } else {
            visual = h('div', { class: 'media-thumb-wrap' },
              h('div', { class: 'media-audio-box' }, h('span', { class: 'media-icon-plain' }, '♪')));
          }
          cards.push(h('div', { class: 'media-card' },
            h('div', { class: 'media-card-box', title: it.file.name },
              visual,
              h('button', { class: 'c-button c-button--close media-remove', type: 'button', title: 'remove',
                onclick: (e) => { e.stopPropagation(); state.uploads[k] = state.uploads[k].filter((x) => x !== it); redraw(); scheduleValidate(); } }, '✕')),
            h('button', { class: 'c-badge c-badge--info media-tag', type: 'button', title: `${it.file.name} — click to insert into prompt`,
              onclick: () => insertTag(tag) }, tag),
          ));
        });
      }
      gridEl.replaceChildren(...cards);
      if (!cards.length) gridEl.append(h('div', { class: 'media-empty' }, 'No files yet'));
      hint.textContent = cards.length
        ? `Drop, paste or click to add more · ${total()} file${total() === 1 ? '' : 's'}`
        : 'Drop, paste (Ctrl+V) or click to add files';
    };
    // NOTE: do not touch state.mediaRedraw here — it belongs to the mode-swap builder,
    // overwriting it breaks switching back to I2V/First-Last.
    // Render once on build: without this the section came back EMPTY whenever it was rebuilt
    // (mode switch, Regenerate) even though state.uploads still held the files — so the next
    // add appeared to resurrect everything that had "disappeared".
    redraw();

    // add a batch of files to the selection, enforcing the per-type limits
    async function addFiles(files) {
      if (!files || !files.length) return;
      const rejected = [], added = [];
      for (const f of files) {
        const k = bucketOfFile(f);
        const max = maxOf(k);
        if (max != null && state.uploads[k].length >= max) { rejected.push(`${f.name} (${k} limit ${max})`); continue; }
        const it = { file: f, id: ++state.uploadSeq };
        state.uploads[k].push(it);
        added.push(it);
      }
      redraw(); scheduleValidate();
      const notes = [];
      if (rejected.length) notes.push(`Not added: ${rejected.join(' · ')}`);
      const libNote = await rememberFiles(added);
      if (libNote) notes.push(libNote);
      noteEl.textContent = notes.join('  ');
      if (added.length) redraw();   // refresh the asset-count button
    }
    state.mediaPaste = addFiles;   // Ctrl+V anywhere in the main window lands here

    // clicking an asset toggles it in/out of the reference selection
    const toggleFromLibrary = (rec, file) => {
      const k = bucketOfFile(file);
      if (state.uploads[k].some((x) => x.assetId === rec.id)) {
        state.uploads[k] = state.uploads[k].filter((x) => x.assetId !== rec.id);
        noteEl.textContent = '';
        redraw(); scheduleValidate();
        return;
      }
      const max = maxOf(k);
      if (max != null && state.uploads[k].length >= max) { noteEl.textContent = `Not added: ${rec.name} (${k} limit ${max})`; return; }
      state.uploads[k].push({ file, id: ++state.uploadSeq, assetId: rec.id });
      noteEl.textContent = '';
      redraw(); scheduleValidate();
    };
    const assetInSelection = (rec) => Object.values(state.uploads).some((arr) => arr.some((x) => x.assetId === rec.id));

    fileInput.addEventListener('change', () => {
      const files = [...fileInput.files];   // copy first...
      fileInput.value = '';                 // ...then clear, so a repeat change can't re-add them
      addFiles(files);
    });
    drop.addEventListener('click', (e) => { if (!e.target.closest('.media-card')) fileInput.click(); });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); drop.classList.remove('dragover');
      addFiles([...e.dataTransfer.files]);   // straight from the drop, no input round-trip
    });
    return h('div', {}, h('div', { class: 'media-tools' },
      assetButton({ isSelected: assetInSelection, toggle: toggleFromLibrary }, false)), drop, noteEl);
  }

  /* I2V / First-Last mode: two dedicated single-image slots (never mixed with Reference files) */
  function keyframeInputs() {
    const grid = h('div', { class: 'keyframe-grid' });
    const notes = { first: '', last: '' };   // survives redraws, which rebuild the slot DOM
    const slotSetters = {};                  // kind -> setSlot, rebuilt on every redraw
    const redraw = () => {
      const slot = (kind, label) => {
        const kf = state.keyframes[kind];
        // a last frame on its own is almost always a mis-drop into the wrong slot;
        // the first frame locks while a last frame exists, so the pair can't drift
        const locked = (kind === 'last' && !state.keyframes.first)
          || (kind === 'first' && state.keyframes.last);
        const note = h('div', { class: locked ? 'media-hint-note' : 'media-note' },
          locked
            ? (kind === 'last' ? '' : 'Remove the last frame to change the first.')
            : notes[kind]);
        const input = h('input', { type: 'file', accept: 'image/*', hidden: '' });
        const setSlot = async (file) => {
          if (locked) return;
          if (!file.type.startsWith('image/')) { notes[kind] = `${file.name} is not an image — keyframes take images only.`; redraw(); return; }
          const it = { file, id: ++state.uploadSeq };
          state.keyframes[kind] = it;
          notes[kind] = '';
          redraw(); scheduleValidate();
          const r = await addAssetFromFile(file);
          if (r.asset) it.assetId = r.asset.id;
          notes[kind] = r.duplicate ? `${file.name} is already in your asset library (not saved again).`
            : r.full ? `Asset library full (${ASSET_MAX} max) — ${file.name} not saved.` : '';
          refreshAssetButtons();
          redraw();   // re-render so the note (and list) reflect the saved state
        };
        slotSetters[kind] = setSlot;
        input.addEventListener('change', () => { if (input.files[0]) setSlot(input.files[0]); input.value = ''; });
        /* one image per slot, shown at its real aspect ratio like the Reference
           dropzone; clicking or dropping on a filled slot replaces the image */
        const clearSlot = () => {
          state.keyframes[kind] = null;
          notes[kind] = '';
          // dropping the first frame orphans the last one, so clear it too
          if (kind === 'first' && state.keyframes.last) {
            state.keyframes.last = null;
            notes.last = 'Cleared — the first frame was removed.';
          }
          redraw(); scheduleValidate();
        };
        /* an empty locked slot greys out; a filled one (first frame while a last
           frame exists) keeps its picture visible and is just not clickable */
        const dropRow = h('div', { class: 'media-dropzone kf-drop' + (locked ? (kf ? ' kf-drop--fixed' : ' kf-drop--locked') : ''),
          title: kf ? kf.file.name : null },
          kf
            ? h('div', { class: 'kf-filled' },
              h('span', { class: 'kf-caption' }, label),
              h('div', { class: 'media-card-box' },
                h('img', { class: 'media-thumb kf-thumb', src: thumbUrl(kf), alt: '' }),
                h('button', { class: 'c-button c-button--close media-remove', type: 'button', title: 'remove',
                  onclick: (e) => { e.stopPropagation(); clearSlot(); } }, '✕')))
            // empty: the slot's name + how to fill it; a locked slot is the same, greyed out
            : h('div', { class: 'kf-empty' },
              h('span', { class: 'kf-title' }, label),
              h('span', {}, 'click, drop or Ctrl+V')));
        if (!locked) {
          dropRow.addEventListener('click', () => input.click());
          dropRow.addEventListener('dragover', (e) => { e.preventDefault(); dropRow.classList.add('dragover'); });
          dropRow.addEventListener('dragleave', () => dropRow.classList.remove('dragover'));
          dropRow.addEventListener('drop', (e) => {
            e.preventDefault(); dropRow.classList.remove('dragover');
            if (e.dataTransfer.files[0]) setSlot(e.dataTransfer.files[0]);
          });
        }
        // clicking an asset toggles it in/out of this slot
        const toggleFromLibrary = (rec, file) => {
          if (locked) { notes.last = 'Add the first frame first.'; redraw(); return; }
          if (!(rec.type || '').startsWith('image/')) { notes[kind] = `${rec.name} is not an image — keyframes take images only.`; redraw(); return; }
          const cur = state.keyframes[kind];
          state.keyframes[kind] = (cur && cur.assetId === rec.id) ? null : { file, id: ++state.uploadSeq, assetId: rec.id };
          notes[kind] = '';
          redraw(); scheduleValidate();
        };
        const assetInSlot = (rec) => !!state.keyframes[kind] && state.keyframes[kind].assetId === rec.id;
        const pick = assetButton({ isSelected: assetInSlot, toggle: toggleFromLibrary, only: 'image' }, true, locked);
        pick.classList.add('asset-btn--sm');
        return h('div', { class: 'kf-slot' }, pick, dropRow, note, input);
      };
      grid.replaceChildren(slot('first', 'First Frame'), slot('last', 'Last Frame'));
      if (state.keyframeRoleSync) state.keyframeRoleSync();   // last-frame lock may have changed
    };
    redraw();
    /* Ctrl+V anywhere in the main window pastes into the slots: first frame
       first, then the last frame. setSlot's lock check enforces the pair order
       (a lone last frame is rejected), and only empty slots are filled. */
    state.mediaPaste = (files) => {
      const img = files.find((f) => f.type.startsWith('image/'));
      if (!img) {
        notes.first = 'The clipboard holds no image — files other than images belong in Reference mode.';
        redraw();
        return;
      }
      const kind = !state.keyframes.first ? 'first' : !state.keyframes.last ? 'last' : null;
      if (!kind) {
        notes.last = 'Both frames are set — remove one to paste a new image.';
        redraw();
        return;
      }
      const setter = slotSetters[kind];
      if (setter) setter(img);
    };
    return grid;
  }

  /* keyframe role toggle (the manifest's keyframe_role field, shown in
     Advanced above Cinematic Effect, I2V / First-Last mode only):
     ON = starts in the first frame (I2VA), OFF = ends in it (L2VA). With a
     last-frame image present it locks ON — first-frame priority. */
  function keyframeRoleRow(roleEntry) {
    const lastExists = () => !!state.keyframes.last;
    const box = h('input', { type: 'checkbox' });
    const text = h('span', {});
    const row = h('div', { class: 'wf-field' }, h('label', { class: 'opt-toggle' }, box, text));
    const syncRole = () => {
      if (lastExists() && roleEntry.input.value !== 'first') {
        roleEntry.input.value = 'first';
        roleEntry.input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      box.checked = roleEntry.input.value === 'first';
      box.disabled = lastExists();
      text.textContent = box.checked ? 'Starts in First Frame' : 'Ends in First Frame';
      row.hidden = isReferenceMode();
    };
    box.addEventListener('change', () => {
      roleEntry.input.value = box.checked ? 'first' : 'last';
      roleEntry.input.dispatchEvent(new Event('change', { bubbles: true }));
      syncRole();
    });
    state.keyframeRoleSync = syncRole;   // slots redraw on add/remove + mode swaps — refresh lock/visibility
    syncRole();
    return row;
  }

  /* image thumbnails: one object URL per upload item, cached — redraws used to
     mint a fresh URL each time and never revoke it (blob-URL leak) */
  const thumbUrlCache = new Map();
  const thumbUrl = (item) => {
    if (!thumbUrlCache.has(item.id)) thumbUrlCache.set(item.id, URL.createObjectURL(item.file));
    return thumbUrlCache.get(item.id);
  };

  /* first-frame thumbnail for a video file (canvas capture, cached per upload id) */
  const videoThumbCache = new Map();
  function videoThumbnail(item, imgEl) {
    const fill = (data) => { if (data) imgEl.src = data; };
    if (videoThumbCache.has(item.id)) { fill(videoThumbCache.get(item.id)); return; }
    const url = URL.createObjectURL(item.file);
    const v = document.createElement('video');
    v.muted = true; v.preload = 'metadata';
    v.onloadeddata = () => { try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch (e) { URL.revokeObjectURL(url); } };
    v.onseeked = () => {
      try {
        const c = document.createElement('canvas');
        const scale = Math.min(1, 160 / Math.max(v.videoWidth || 16, 1));
        c.width = Math.max(1, Math.round((v.videoWidth || 16) * scale));
        c.height = Math.max(1, Math.round((v.videoHeight || 9) * scale));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        const data = c.toDataURL('image/jpeg', 0.7);
        videoThumbCache.set(item.id, data);
        fill(data);
      } catch (e) { /* leave icon-only */ }
      URL.revokeObjectURL(url);
    };
    v.onerror = () => URL.revokeObjectURL(url);
    v.src = url;
  }

  /* ---------------- local asset library (IndexedDB, max 100) ----------------
     Files added to the media boxes are saved here automatically, so they can be
     re-picked without uploading from disk again. Duplicates (same content hash)
     are detected and never stored twice. RunningHub file names are cached per
     asset and reused for a day, so re-running does not re-upload the same file. */
  const ASSET_DB = 'framecommander';
  const ASSET_STORE = 'assets';
  const ASSET_MAX = 100;
  const ASSET_RH_TTL = 24 * 60 * 60 * 1000;
  let assetDb = null;
  let assetPicker = {};        // { isSelected, toggle, close } for the open dialog
  const assetUrlCache = new Map();

  const idbReq = (req) => new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

  function getAssetDb() {
    if (assetDb) return Promise.resolve(assetDb);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(ASSET_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ASSET_STORE)) db.createObjectStore(ASSET_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => { assetDb = req.result; resolve(assetDb); };
      req.onerror = () => reject(req.error);
    });
  }

  async function loadAssets() {
    try {
      const db = await getAssetDb();
      state.assets = await idbReq(db.transaction(ASSET_STORE).objectStore(ASSET_STORE).getAll());
    } catch (e) {
      state.assets = []; state.assetDbFailed = true;   // private mode etc. — in-memory only
    }
    state.assetsById = new Map(state.assets.map((a) => [a.id, a]));
  }

  async function assetSave(rec) {
    state.assetsById.set(rec.id, rec);
    try {
      if (!state.assetDbFailed) await idbReq((await getAssetDb()).transaction(ASSET_STORE, 'readwrite').objectStore(ASSET_STORE).put(rec));
    } catch (e) { /* in-memory only */ }
  }

  async function assetRemove(id) {
    state.assets = state.assets.filter((a) => a.id !== id);
    state.assetsById.delete(id);
    const u = assetUrlCache.get(id);
    if (u) { URL.revokeObjectURL(u); assetUrlCache.delete(id); }
    try {
      if (!state.assetDbFailed) await idbReq((await getAssetDb()).transaction(ASSET_STORE, 'readwrite').objectStore(ASSET_STORE).delete(id));
    } catch (e) { /* ignore */ }
  }

  async function assetClear() {
    state.assets = [];
    state.assetsById = new Map();
    for (const u of assetUrlCache.values()) URL.revokeObjectURL(u);
    assetUrlCache.clear();
    try {
      if (!state.assetDbFailed) await idbReq((await getAssetDb()).transaction(ASSET_STORE, 'readwrite').objectStore(ASSET_STORE).clear());
    } catch (e) { /* ignore */ }
  }

  const bucketOfFile = (f) => f.type.startsWith('image/') ? 'images' : f.type.startsWith('video/') ? 'videos' : 'audios';

  /* files inside a paste event: most browsers expose .files directly, but a
     "Copy image" from a web page sometimes only surfaces via dataTransfer.items */
  const filesFromClipboard = (dt) => {
    if (!dt) return [];
    if (dt.files && dt.files.length) return [...dt.files];
    const out = [];
    for (const it of (dt.items || [])) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
    return out;
  };

  async function hashFile(file) {
    try {
      const buf = await file.arrayBuffer();
      const d = await crypto.subtle.digest('SHA-256', buf);
      return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      return `${file.name}|${file.size}|${file.lastModified}`;   // no SubtleCrypto → weak key
    }
  }

  const fileOf = (rec) => (rec.blob instanceof File) ? rec.blob : new File([rec.blob], rec.name, { type: rec.type || '' });

  function assetUrl(rec) {
    if (!assetUrlCache.has(rec.id)) assetUrlCache.set(rec.id, URL.createObjectURL(rec.blob));
    return assetUrlCache.get(rec.id);
  }

  /* store a file, deduping by content hash. -> { asset, duplicate?, full? } */
  async function addAssetFromFile(file) {
    const hash = await hashFile(file);
    const dup = state.assets.find((a) => (a.hash ? a.hash === hash : (a.name === file.name && a.size === file.size)));
    if (dup) return { asset: dup, duplicate: true };
    if (state.assets.length >= ASSET_MAX) return { asset: null, full: true };
    const rec = {
      id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: file.name, type: file.type, size: file.size, lastModified: file.lastModified,
      hash, blob: file, addedAt: Date.now(),
    };
    await assetSave(rec);
    state.assets.push(rec);
    return { asset: rec };
  }

  /* auto-save newly added selection items; links each to its asset and returns a note */
  async function rememberFiles(items) {
    const dup = [], full = [];
    for (const it of items) {
      const r = await addAssetFromFile(it.file);
      if (r.asset) it.assetId = r.asset.id;
      if (r.duplicate) dup.push(it.file.name);
      else if (r.full) full.push(it.file.name);
    }
    refreshAssetButtons();
    const notes = [];
    if (dup.length) notes.push(`Already in your asset library (not saved again): ${dup.join(' · ')}`);
    if (full.length) notes.push(`Asset library full (${ASSET_MAX} max) — not saved: ${full.join(' · ')}`);
    return notes.join('  ');
  }

  function refreshAssetButtons() {
    for (const b of document.querySelectorAll('.asset-btn')) b.textContent = `📁 Assets (${state.assets.length}/${ASSET_MAX})`;
  }

  function assetVisual(rec) {
    if (rec.type.startsWith('image/')) return h('img', { class: 'media-thumb', src: assetUrl(rec), alt: '' });
    if (rec.type.startsWith('video/')) {
      const img = h('img', { class: 'media-thumb', alt: '' });
      videoThumbnail({ file: fileOf(rec), id: rec.id }, img);
      return h('div', { class: 'media-thumb-wrap' }, img, h('span', { class: 'media-icon-overlay' }, '▶'));
    }
    return h('div', { class: 'media-thumb-wrap' }, h('div', { class: 'media-audio-box' }, h('span', { class: 'media-icon-plain' }, '♪')));
  }

  /* one picker target at a time: isSelected(rec) drives the grayed-out state,
     toggle(rec, file) adds it back out of the current selection */
  const assetButton = (target, close, disabled) => h('button', {
    class: 'c-button asset-btn', type: 'button', title: 'pick from your local asset library',
    disabled: disabled ? '' : null,
    onclick: () => openAssetPicker(target, close),
  }, `📁 Assets (${state.assets.length}/${ASSET_MAX})`);

  /* target.only = 'image' (keyframe slots): the type dropdown opens on Images */
  function openAssetPicker(target, close) {
    assetPicker = { isSelected: target.isSelected, toggle: target.toggle, close: close !== false };
    $('#asset-filter').value = target.only || 'all';
    renderAssetGrid();
    const dlg = $('#asset-dlg');
    if (!dlg.open) dlg.showModal();
  }

  function toggleAsset(rec) {
    assetPicker.toggle(rec, fileOf(rec));
    renderAssetGrid();          // refresh grayed-out state
    if (assetPicker.close) $('#asset-dlg').close();
  }

  function renderAssetGrid() {
    $('#asset-count').textContent = `${state.assets.length} / ${ASSET_MAX}`;
    const grid = $('#asset-grid');
    if (!state.assets.length) {
      grid.replaceChildren(h('div', { class: 'asset-empty' }, 'No assets yet — files you add to the media box are saved here automatically.'));
      return;
    }
    const kind = $('#asset-filter').value;
    const shown = kind === 'all' ? state.assets : state.assets.filter((a) => (a.type || '').startsWith(kind + '/'));
    if (!shown.length) {
      grid.replaceChildren(h('div', { class: 'asset-empty' }, `No ${$('#asset-filter').selectedOptions[0].text.toLowerCase()} in your library yet.`));
      return;
    }
    /* newest first — the freshest uploads (and extracted frames) are the ones
       you're most likely to pick next */
    grid.replaceChildren(...shown.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).map((rec) => {
      const on = assetPicker.isSelected ? !!assetPicker.isSelected(rec) : false;
      return h('div', {
        class: 'asset-card' + (on ? ' asset-card--selected' : ''),
        title: on ? `${rec.name} — in use, click to remove` : `${rec.name} — click to add`,
        onclick: () => toggleAsset(rec),
      },
        h('div', { class: 'media-card-box' }, assetVisual(rec),
          h('button', {
            class: 'c-button c-button--close media-remove', type: 'button', title: 'remove from library',
            onclick: (e) => { e.stopPropagation(); removeAssetAndRefresh(rec.id); },
          }, '✕')),
        h('div', { class: 'asset-name' }, rec.name));
    }));
  }

  async function removeAssetAndRefresh(id) {
    await assetRemove(id);
    renderAssetGrid();
    if (state.mediaRedraw) state.mediaRedraw();
  }

  function wireAssetDialog() {
    const dlg = $('#asset-dlg');
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });   // backdrop click = close
    $('#btn-asset-close').addEventListener('click', () => dlg.close());
    $('#asset-filter').addEventListener('change', renderAssetGrid);
    $('#btn-asset-clear').addEventListener('click', async () => {
      if (!state.assets.length) return;
      if (!confirm(`Remove all ${state.assets.length} assets from the local library? This cannot be undone.`)) return;
      await assetClear();
      renderAssetGrid();
      if (state.mediaRedraw) state.mediaRedraw();
    });
    /* manual upload straight into the library — same dedupe/limits as the
       automatic saving around the form */
    const uploadInput = $('#asset-upload-input');
    $('#btn-asset-upload').addEventListener('click', () => uploadInput.click());
    uploadInput.addEventListener('change', async () => {
      const files = [...uploadInput.files];   // copy first...
      uploadInput.value = '';                 // ...then clear, so a repeat change can't re-add them
      if (!files.length) return;
      const note = $('#asset-note');
      const added = [], dup = [], full = [];
      for (const f of files) {
        const r = await addAssetFromFile(f);
        if (r.asset && !r.duplicate) added.push(f.name);
        else if (r.duplicate) dup.push(f.name);
        else if (r.full) full.push(f.name);
      }
      renderAssetGrid();
      refreshAssetButtons();
      if (state.mediaRedraw) state.mediaRedraw();
      const notes = [];
      if (added.length) notes.push(`Added ${added.length} file${added.length === 1 ? '' : 's'} to the library.`);
      if (dup.length) notes.push(`Already in the library (not saved again): ${dup.join(' · ')}`);
      if (full.length) notes.push(`Asset library full (${ASSET_MAX} max) — not saved: ${full.join(' · ')}`);
      note.textContent = notes.join('  ');
    });
  }

  function renderForm() {
    state.fieldMap = {};
    state.mediaDef = null;
    state.keyframeRoleSync = null;   // re-registered by keyframeRoleRow below
    const wf = state.current;
    const basic = [], advanced = [];
    state.mediaDef = (wf.fields || []).find((f) => f.type === 'media') || null;
    let mediaDone = false;
    const pushMedia = () => {
      if (!state.mediaDef || mediaDone) return;
      mediaDone = true;
      basic.push(mediaSection());
    };

    for (const def of wf.fields || []) {
      if (def.type === 'media') { state.mediaDef = def; continue; }
      const entry = buildControl(def);
      state.fieldMap[def.nodeId + '.' + def.fieldName] = entry;
      if (entry.input && entry.input.addEventListener) {
        entry.input.addEventListener('input', scheduleValidate);
        entry.input.addEventListener('change', scheduleValidate);
      }
      /* placement: "keyframe" renders as the Starts/Ends in First Frame toggle */
      if (def.placement === 'keyframe') { (def.advanced ? advanced : basic).push(keyframeRoleRow(entry)); continue; }
      if (def.fieldName === 'mode') {
        // @ref tag chips + prompt highlighting only exist in Reference mode
        entry.input.addEventListener('change', () => {
          if (state.mediaRedraw) state.mediaRedraw();
          if (state.highlightSync) state.highlightSync();
        });
      }

      let control;
      if (def.type === 'slider') {
        /* maxBelow sliders show "value / ceiling" so the dynamic limit is visible */
        const labelText = () => def.maxBelow
          ? entry.input.value + ' / ' + entry.input.max
          : String(entry.input.value);
        const val = h('span', { class: 'slider-value' }, labelText());
        const row = h('div', { class: 'wf-inline slider-row' }, entry.input, val);
        /* yellow from warnAt, red from dangerAt (danger wins when both apply) */
        const syncWarn = () => {
          const v = parseFloat(entry.input.value);
          const danger = def.dangerAt != null && v >= def.dangerAt;
          row.classList.toggle('slider-danger', danger);
          row.classList.toggle('slider-warn', !danger && def.warnAt != null && v >= def.warnAt);
        };
        entry.input.addEventListener('input', () => {
          val.textContent = labelText();
          syncWarn();
        });
        syncWarn();
        control = fieldWrapper(def, row);
        /* helpFrom: a slider hint that only appears past a threshold (the duration limits) */
        if (def.helpFrom != null) {
          const hintEl = control.querySelector('.c-hint');
          if (hintEl) {
            hintEl.classList.add('hint-alert');
            const syncHint = () => { hintEl.style.display = parseFloat(entry.input.value) > def.helpFrom ? '' : 'none'; };
            entry.input.addEventListener('input', syncHint);
            syncHint();
          }
        }
      } else if (def.type === 'textarea') {
        const ta = entry.input;
        const backdrop = h('div', { class: 'prompt-highlight', 'aria-hidden': 'true' });

        /* The box grows with its text up to a CSS max-height, then scrolls inside.
           The scrollbar is hidden (scrollbar-width:none) so the lines stay exactly
           as wide as the backdrop's — a visible bar would narrow them and the two
           layers (visible text / caret layer) would drift apart mid-typing. The
           backdrop mirrors the textarea's scrollTop, so the visible text scrolls too. */
        const syncScroll = () => { backdrop.scrollTop = ta.scrollTop; };
        const autoGrow = () => {
          ta.style.height = 'auto';
          ta.style.height = (ta.scrollHeight + 2) + 'px';   // +2 = 1px top/bottom border
          syncScroll();
        };
        state.autoGrow = autoGrow;

        state.highlightSync = () => {
          backdrop.innerHTML = highlightPromptHtml(ta.value, isReferenceMode());
          syncScroll();
        };
        ta.addEventListener('input', state.highlightSync);
        ta.addEventListener('input', autoGrow);
        ta.addEventListener('scroll', syncScroll);
        /* the scroll event alone misses some real scrolls (the caret-follow
           auto-scroll, programmatic jumps) — while the box is focused, mirror
           its scrollTop on a light interval (rAF would freeze in background
           tabs); wheel-scrolling an unfocused box still goes through the
           scroll listener above */
        let scrollSyncTimer = null;
        const startScrollSync = () => {
          if (scrollSyncTimer != null) return;
          scrollSyncTimer = setInterval(syncScroll, 100);
        };
        ta.addEventListener('focus', startScrollSync);
        ta.addEventListener('blur', () => {
          if (scrollSyncTimer != null) { clearInterval(scrollSyncTimer); scrollSyncTimer = null; }
          syncScroll();
        });
        if (document.activeElement === ta) startScrollSync();
        // chips clicked outside the box insert at the caret only once the user has
        // actually placed one; before that they append at the end, where they are seen
        ta.addEventListener('focus', () => { ta.dataset.touched = '1'; }, { once: true });
        autoGrow();
        /* quiet length counter — turns yellow past ~5,000 characters, where H3
           prompts start losing detail (the Singularity card's own guidance) */
        const counter = h('div', { class: 'prompt-count' });
        const syncCount = () => {
          const n = ta.value.length;
          const long = n > PROMPT_SOFT_MAX;
          counter.textContent = `${n.toLocaleString()} characters`;
          counter.classList.toggle('prompt-count--long', long);
          counter.title = long ? `Over ~${PROMPT_SOFT_MAX.toLocaleString()} characters — long prompts tend to lose detail; consider trimming.` : '';
        };
        ta.addEventListener('input', syncCount);
        syncCount();
        control = fieldWrapper(def, h('div', { class: 'prompt-editor' }, backdrop, ta), counter);
      } else if (def.type === 'iconselect') {
        control = fieldWrapper(def, h('div', { class: 'icon-row' }, entry.buttons));
        entry.sync();
      } else if (def.type === 'tabs') {
        control = fieldWrapper(def, entry.tabsEl, entry.input);
      } else if (def.type === 'checkbox') {
        // checkbox label sits beside the box (same .opt-toggle row as Settings)
        control = fieldWrapper({ ...def, label: '' }, h('label', { class: 'opt-toggle' }, entry.input, h('span', {}, def.label)));
      } else {
        control = fieldWrapper(def, entry.input);
      }
      if (def.fieldName === 'prompt') {
        if (state.highlightSync) state.highlightSync();
        pushMedia();
      }
      (def.advanced ? advanced : basic).push((def.advanced && def.group) ? { def, el: control } : control);
    }
    pushMedia();

    $('#form-area').replaceChildren(...basic);
    if (advanced.length) {
      /* fields declaring a shared `group` (e.g. Sigma Shift) collapse into a
         nested accordion inside Advanced, in manifest order */
      const els = [];
      for (let i = 0; i < advanced.length; i++) {
        const item = advanced[i];
        if (!item.def) { els.push(item); continue; }
        const groupEls = [item.el];
        while (i + 1 < advanced.length && advanced[i + 1].def && advanced[i + 1].def.group === item.def.group) {
          groupEls.push(advanced[++i].el);
        }
        els.push(h('details', { class: 'wf-subgroup' }, h('summary', {}, item.def.group), ...groupEls));
      }
      $('#form-area').append(h('details', { class: 'wf-advanced u-window-box-small' }, h('summary', {}, 'Advanced'), ...els));
    }
    /* maxBelow: a slider whose ceiling must stay under another numeric field
       (Transition Step < Steps) — its max tracks that field's value − 1, and a
       drop in the ceiling clamps the current value down with it. The self-
       listener also catches Regenerate restoring an out-of-range snapshot. */
    for (const entry of Object.values(state.fieldMap)) {
      const def = entry.def;
      if (!def.maxBelow || !entry.input) continue;
      const other = fieldByName(def.maxBelow);
      if (!other || !other.input) continue;
      const clamp = () => {
        const ceil = parseFloat(other.input.value) - 1;
        if (!Number.isFinite(ceil)) return;
        /* dispatch when the ceiling itself moved too, so the "value / max"
           label stays live; the second pass is a no-op so this can't loop */
        const changed = String(entry.input.max) !== String(ceil) || parseFloat(entry.input.value) > ceil;
        entry.input.max = ceil;
        if (parseFloat(entry.input.value) > ceil) entry.input.value = ceil;
        if (changed) entry.input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      other.input.addEventListener('input', clamp);
      entry.input.addEventListener('input', clamp);
      clamp();
    }
    /* Steps presets drive the hidden SelfLift defaults: 8→5, 12→8 (FastH3
       8-step checkpoint — 4 and the 20-step Base run are gone). Regenerate
       restores land after these (fieldMap order), so snapshots still win. */
    const stepsEntry = fieldByName('steps');
    const transDefault = fieldByName('transition_step');
    const STEP_PRESETS = { 8: 5, 12: 8 };
    if (stepsEntry && transDefault) {
      const applySteps = () => {
        /* a Regenerate of an older run (Steps 4 or 20) has no option in the
           dropdown — fall back to the default instead of an empty select */
        if (STEP_PRESETS[parseFloat(stepsEntry.input.value)] == null) {
          stepsEntry.input.value = String(stepsEntry.def.default ?? 8);
        }
        const steps = parseFloat(stepsEntry.input.value);
        const trans = STEP_PRESETS[steps];
        if (trans == null) return;
        transDefault.input.value = trans;
        transDefault.input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      stepsEntry.input.addEventListener('input', applySteps);
      stepsEntry.input.addEventListener('change', applySteps);
      applySteps();
    }
    restoreFormPrefs();   // after the Steps listener, so a remembered Transition Step wins over the preset
    scheduleValidate();
  }

  /* ---- remember the last-used settings (mode, duration, resolution, aspect,
     steps, …) across reloads. The prompt and seed are never remembered. A value
     that no longer exists as an option (manifest changed) is skipped. Saved
     from validate(), which already runs debounced after every edit. */
  const FORM_SKIP = new Set(['prompt', 'seed']);
  function saveFormPrefs() {
    if (!state.current) return;
    const out = {};
    for (const [key, v] of Object.entries(readRunFields())) {
      if (!FORM_SKIP.has(state.fieldMap[key].def.fieldName)) out[key] = v;
    }
    try {
      const all = JSON.parse(localStorage.getItem(FORM_STORE) || '{}');
      all[state.current.id] = out;
      localStorage.setItem(FORM_STORE, JSON.stringify(all));
    } catch (e) { /* storage blocked — defaults next time */ }
  }

  function restoreFormPrefs() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(FORM_STORE) || '{}')[state.current.id]; } catch (e) { return; }
    for (const [key, v] of Object.entries(saved || {})) {
      const entry = state.fieldMap[key];
      if (!entry || FORM_SKIP.has(entry.def.fieldName)) continue;
      const opts = entry.def.options ? optionList(entry.def).map((o) => String(o.value)) : null;
      if (opts && !opts.includes(String(v))) continue;
      setFieldValue(entry, v);
    }
    if (state.keyframeRoleSync) state.keyframeRoleSync();
  }

  /* ---------------- validation (media rules + live lint) ---------------- */
  let validateTimer = null;
  const scheduleValidate = () => { clearTimeout(validateTimer); validateTimer = setTimeout(validate, 350); };

  function activeMediaCounts() {
    if (isReferenceMode()) {
      return { images: state.uploads.images.length, audios: state.uploads.audios.length, videos: state.uploads.videos.length };
    }
    // I2V / First-Last: keyframe slots, never the reference dropzone files
    return { images: (state.keyframes.first ? 1 : 0) + (state.keyframes.last ? 1 : 0), audios: 0, videos: 0 };
  }

  function mediaRuleIssues() {
    const wf = state.current;
    const issues = [];
    const counts = activeMediaCounts();
    if (!isReferenceMode() && state.keyframes.last && !state.keyframes.first) {
      issues.push('a last frame needs a first frame too');
    }
    for (const rule of wf.rules || []) {
      const when = rule.when || {};
      const sel = fieldByName(when.field);
      /* iconselect keeps its value on entry.value (entry.input is null) */
      if (sel && String(sel.input ? sel.input.value : sel.value) !== String(when.equals)) continue;
      const req = rule.media || {};
      for (const [bucket, lim] of Object.entries(req)) {
        if (bucket === 'any') continue;
        const n = counts[bucket] || 0;
        if (lim.min != null && n < lim.min) issues.push(`${bucket}: needs at least ${lim.min} (has ${n})`);
        if (lim.max != null && n > lim.max) issues.push(`${bucket}: allows at most ${lim.max} (has ${n})`);
      }
      if (req.any && !(counts.images + counts.audios + counts.videos)) issues.push('at least one reference media file is required for this mode');
    }
    return issues;
  }

  /* Reference check (Reference mode only — warns, never blocks Run): every
     attached file should be named in the prompt, and every name in the prompt
     should have a file. An attached character the prompt never mentions is
     the one the model tends to drop. Accepts the chip form (@Image2) and the
     guide form (<Picture 2>, <Video 1>, <Audio 1>). */
  function referenceWarnings() {
    if (!isReferenceMode()) return [];
    const text = fieldByName('prompt')?.input.value || '';
    if (!text.trim()) return [];
    const warns = [];
    for (const [bucket, chip, guide, noun] of [
      ['images', 'Image', 'Picture', 'image'], ['videos', 'Video', 'Video', 'video'], ['audios', 'Audio', 'Audio', 'audio'],
    ]) {
      const n = state.uploads[bucket].length;
      const named = new Set();
      for (const m of text.matchAll(new RegExp(`@${chip}(\\d+)\\b|<${guide}\\s*(\\d+)>`, 'gi'))) named.add(Number(m[1] || m[2]));
      for (let i = 1; i <= n; i++) {
        if (!named.has(i)) warns.push(`@${chip}${i} is attached but never mentioned in the prompt — the model may leave it out`);
      }
      for (const i of [...named].sort((a, b) => a - b)) {
        if (i > n) warns.push(`the prompt mentions @${chip}${i}, but only ${n} ${noun}${n === 1 ? ' is' : 's are'} attached`);
      }
    }
    return warns;
  }

  function validate() {
    const out = $('#validation');
    if (!out) return;
    const mediaIssues = mediaRuleIssues();
    const promptEntry = fieldByName('prompt');
    /* required only when the workflow defines a prompt field at all */
    const issues = promptEntry && !promptEntry.input.value.trim() ? ['prompt is required'] : [];
    /* 21–30s at high resolutions does NOT block Generate Video — the red
       limits hint under the Duration slider is the warning (user's call) */
    state.canRun = mediaIssues.length === 0 && issues.length === 0;
    const warnings = referenceWarnings();

    out.replaceChildren(...[
      issues.length || mediaIssues.length
        ? h('ul', { class: 'lint-issues' }, [...issues, ...mediaIssues].map((i) => h('li', {}, i)))
        : null,
      warnings.length ? h('ul', { class: 'lint-warnings' }, warnings.map((w) => h('li', {}, w))) : null,
    ].filter(Boolean));
    const runBtn = $('#btn-run');
    if (runBtn) runBtn.disabled = state.busy || !state.canRun;
    saveFormPrefs();
  }

  /* ---------------- payload ---------------- */
  /* ---- Regenerate: replay a finished run's inputs back into the form ---- */

  /* `iconselect` has no input element — its value lives on entry.value (entry.input is null) */
  function readRunFields() {
    const out = {};
    for (const [key, entry] of Object.entries(state.fieldMap)) {
      const t = entry.def.type;
      if (t === 'checkbox') out[key] = !!entry.input.checked;
      else if (t === 'iconselect') out[key] = entry.value;
      else out[key] = entry.input.value;
    }
    return out;
  }

  function setFieldValue(entry, val) {
    const t = entry.def.type;
    if (t === 'checkbox') {
      entry.input.checked = !!val;
      entry.input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (t === 'iconselect') {
      entry.value = val == null ? '' : String(val);
      if (entry.sync) entry.sync();
      return;
    }
    entry.input.value = val == null ? '' : String(val);
    if (entry.sync) entry.sync();                       // tabs redraw themselves
    entry.input.dispatchEvent(new Event('input', { bubbles: true }));
    entry.input.dispatchEvent(new Event('change', { bubbles: true }));   // moves the media section too
  }

  function regenerate(entry) {
    const snap = entry.snapshot;
    if (!snap) return;
    let missing = 0;
    const fromAsset = (id) => {
      const rec = state.assetsById.get(id);
      if (!rec) { missing++; return null; }
      return { file: fileOf(rec), id: ++state.uploadSeq, assetId: rec.id };
    };

    // 1. every field, in the original order (the mode change re-renders the media section)
    for (const [key, val] of Object.entries(snap.fields || {})) {
      const fieldEntry = state.fieldMap[key];
      if (fieldEntry) setFieldValue(fieldEntry, val);
    }
    // 2. the prompt goes back as it was TYPED, not as it was rewritten
    const promptEntry = fieldByName('prompt');
    if (promptEntry && entry.rawPrompt != null) {
      promptEntry.input.value = entry.rawPrompt;
      promptEntry.input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // 3. the exact seed that was used, so the only change is whatever you tweak
    const seedEntry = fieldByName('seed');
    if (seedEntry && snap.seed != null) {
      seedEntry.input.value = String(snap.seed);
      seedEntry.input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // 4. the assets, straight from the local library
    if (snap.mode === 'reference') {
      state.keyframes = { first: null, last: null };
      for (const b of ['images', 'audios', 'videos']) {
        state.uploads[b] = (snap.media && snap.media[b] ? snap.media[b] : []).map(fromAsset).filter(Boolean);
      }
    } else {
      state.uploads = { images: [], audios: [], videos: [] };
      state.keyframes = {
        first: snap.keyframes && snap.keyframes.first ? fromAsset(snap.keyframes.first) : null,
        last: null,
      };
      // a last frame without a first is not allowed any more
      if (state.keyframes.first && snap.keyframes.last) state.keyframes.last = fromAsset(snap.keyframes.last);
    }
    if (state.mediaRedraw) state.mediaRedraw();
    if (state.highlightSync) state.highlightSync();
    scheduleValidate();
    $('#form-area').scrollIntoView({ block: 'start' });
    statusLine(missing
      ? `Settings restored — but ${missing} asset(s) are no longer in your asset library, so they were skipped.`
      : 'Settings restored from that run — tweak anything and press Run.', false);
  }

  function buildNodeInfoList(mediaNames, promptOverride) {
    const ni = [];
    let seed = null;
    let presetOverrides = null;   // values a `presets` select applies to OTHER nodes
    let offOverrides = null;      // checkbox OFF ("restore default") sets — applied FIRST
    for (const entry of Object.values(state.fieldMap)) {
      const def = entry.def;
      if (def.local) continue;   // app-side switch (Singularity V2) — applied in buildWorkflowJson
      if (def.presets) {
        /* preset select (Quality Setting): its own value is never sent to RunningHub —
           the chosen option's node overrides are applied below instead */
        const chosen = def.type === 'iconselect' ? entry.value : entry.input.value;
        for (const [nodeId, fields] of Object.entries(def.presets[chosen] || {})) {
          for (const [fieldName, fieldValue] of Object.entries(fields)) {
            (presetOverrides ??= []).push({ nodeId, fieldName, fieldValue });
          }
        }
        continue;
      }
      if (def.type === 'seed') {
        const raw = entry.input.value.trim();
        seed = raw === '' ? randSeed() : (Number(raw) || randSeed());
        ni.push({ nodeId: def.nodeId, fieldName: def.fieldName, fieldValue: seed });
        continue;
      }
      /* optionOverrides: the chosen option ALSO sets other nodes' values, on
         top of sending its own (the mode tabs flip the LazySwitchKJ 313 to the
         matching diffusion model). Lands after normalize, like presets. */
      if (def.optionOverrides) {
        const chosen = def.type === 'iconselect' ? entry.value : entry.input.value;
        for (const [nodeId, fields] of Object.entries(def.optionOverrides[chosen] || {})) {
          for (const [fieldName, fieldValue] of Object.entries(fields)) {
            (presetOverrides ??= []).push({ nodeId, fieldName, fieldValue });
          }
        }
      }
      if (def.type === 'checkbox') {
        if (def.overrides) {
          /* With `overrides` the checkbox drives other nodes' values instead of
             sending its own boolean. Collected into presetOverrides so it lands
             AFTER normalize, same as the Quality preset — a checkbox always
             wins over the template. OFF sets go to their own bucket: with two
             exclusive swaps the unchecked one's "restore default" must be
             applied BEFORE the checked one's on-set, or it would clobber it. */
          const on = entry.input.checked;
          const set = on ? def.overrides.on : def.overrides.off;
          const bucket = on ? (presetOverrides ??= []) : (offOverrides ??= []);
          for (const [nodeId, fields] of Object.entries(set || {})) {
            for (const [fieldName, fieldValue] of Object.entries(fields)) {
              bucket.push({ nodeId, fieldName, fieldValue });
            }
          }
        } else {
          ni.push({ nodeId: def.nodeId, fieldName: def.fieldName, fieldValue: !!entry.input.checked });
        }
        continue;
      }
      if (def.type === 'iconselect') {
        ni.push({ nodeId: def.nodeId, fieldName: def.fieldName, fieldValue: entry.value });
        continue;
      }
      let v = entry.input.value;
      if (def.type === 'number' || def.type === 'slider') {
        v = parseFloat(v);
        if (Number.isNaN(v)) { if (def.optional) continue; v = 0; }
      } else if ((def.type === 'select' || def.type === 'tabs') && def.valueType === 'number') {
        v = parseFloat(v);
      } else if (v === '' && def.optional) {
        continue;
      }
      ni.push({ nodeId: def.nodeId, fieldName: def.fieldName, fieldValue: v });
    }
    /* with `mediaLoaders` the media goes in as cloned core loader nodes
       (buildWorkflowJson), not as one JSON field on a media-loader node */
    if (state.mediaDef && !state.current.mediaLoaders) {
      ni.push({
        nodeId: state.mediaDef.nodeId,
        fieldName: state.mediaDef.fieldName,
        fieldValue: JSON.stringify(mediaNames || { images: [], audios: [], videos: [] }),
      });
    }
    // raw values the saved template stores as UI labels — always sent so RunningHub's
    // raw-enum validation (code 433) passes; skipped when the form already covers them
    const seen = new Set(ni.map((e) => e.nodeId + '.' + e.fieldName));
    const upsert = (nodeId, fieldName, fieldValue) => {
      if (seen.has(nodeId + '.' + fieldName)) {
        ni.find((e) => e.nodeId === nodeId && e.fieldName === fieldName).fieldValue = fieldValue;
      } else {
        seen.add(nodeId + '.' + fieldName);
        ni.push({ nodeId, fieldName, fieldValue });
      }
    };
    for (const [nodeId, fields] of Object.entries(state.current.normalize || {})) {
      for (const [fieldName, fieldValue] of Object.entries(fields)) {
        const key = nodeId + '.' + fieldName;   // form values win; normalize fills the rest
        if (!seen.has(key)) { seen.add(key); ni.push({ nodeId, fieldName, fieldValue }); }
      }
    }
    /* checkbox OFF sets ("back to the default stack") first, then everything a
       checked box or a preset turns ON — an explicit choice always wins */
    for (const o of offOverrides || []) upsert(o.nodeId, o.fieldName, o.fieldValue);
    /* preset overrides land after normalize so a preset always wins over the template */
    for (const o of presetOverrides || []) upsert(o.nodeId, o.fieldName, o.fieldValue);
    /* The app asserts the Official-DMAD defaults itself on every run:
       strength 1 and shifts 12/2. Only nodes that exist and are active on
       the canvas are patched — patching a missing/bypassed node draws 803. */
    upsert('229', 'strength_model', 1);
    upsert('207', 'shift_video', 12);
    upsert('207', 'shift_audio', 2);
    /* Transition Step 1 = "least SelfLift" run, automatic and invisible: the
       draft stage runs at full resolution (lowres_scale 1), so the lift is a
       1:1 pass through the canvas upscaler — the closest to plain full-res
       sampling this node allows. upscaler "none" is NOT sent: the node raises
       ValueError when upscaler=none and rho=0 (their canvas setting). Any
       other transition value sends nothing; the sampler is never patched. */
    const transEntry = fieldByName('transition_step');
    if (transEntry && parseFloat(transEntry.input.value) === 1) {
      upsert('261', 'lowres_scale', 1);
    }
    /* the submitted prompt: the browser-side rewrite when the optimizer ran, else the typed text.
       (The node's own prompt_optimizer stays false via `normalize` — no double rewrite.) */
    if (promptOverride != null) upsert('1', 'prompt', promptOverride);
    return { ni, seed };
  }

  /* The full API workflow sent with the task (sendWorkflowJson): the template
     with every nodeInfoList value written in, and one core loader per uploaded
     file. The Easy node takes its media as media_N = [loaderId, 0] plus
     media_type_N (how its virtual media links serialize), so the template's
     single LoadImage / LoadVideo / LoadAudio are cloned per file — images,
     then videos, then audios, each in upload order (Image1 = first image).
     Unused template loaders are dropped, so no empty loader ever runs. */
  function buildWorkflowJson(template, ni, mediaNames, singularity) {
    const wfJson = JSON.parse(JSON.stringify(template));
    for (const { nodeId, fieldName, fieldValue } of ni) {
      const node = wfJson[nodeId];
      if (!node) throw new Error(`node ${nodeId} (field "${fieldName}") is not in api/${state.current.file} — re-export the API workflow`);
      node.inputs[fieldName] = fieldValue;
    }
    /* Advanced → Singularity V2: the checkpoint's Load Diffusion Model node is
       muted on the canvas, so it is not in the API export — add it here and
       point both model inputs of the Easy Model Bridge at it. The LazySwitchKJ
       (FastH3 / Omni) then feeds nothing and ComfyUI never loads either model. */
    const sg = state.current.singularity;
    if (sg && singularity) {
      const bridge = wfJson[sg.bridgeNode];
      if (!bridge) throw new Error(`Singularity bridge node ${sg.bridgeNode} is not in api/${state.current.file}`);
      wfJson[sg.nodeId] = JSON.parse(JSON.stringify(sg.loader));
      for (const fn of sg.bridgeInputs) bridge.inputs[fn] = [sg.nodeId, 0];
    }
    const ml = state.current.mediaLoaders;
    if (!ml) return wfJson;
    const target = wfJson[ml.target];
    if (!target) throw new Error(`media target node ${ml.target} is not in api/${state.current.file}`);
    for (const k of Object.keys(target.inputs)) {
      if (/^media(_type)?_\d+$/.test(k)) delete target.inputs[k];
    }
    const kinds = [['image', 'images'], ['video', 'videos'], ['audio', 'audios']];
    const protos = {};
    for (const [kind] of kinds) {
      const spec = ml[kind];
      if (!spec || !wfJson[spec.nodeId]) throw new Error(`${kind} loader node ${spec && spec.nodeId} is not in api/${state.current.file}`);
      protos[kind] = wfJson[spec.nodeId];
      delete wfJson[spec.nodeId];
    }
    let nextId = Math.max(...Object.keys(wfJson).map(Number).filter(Number.isFinite), 0) + 1000;
    let slot = 0;
    for (const [kind, bucket] of kinds) {
      const names = (mediaNames && mediaNames[bucket]) || [];
      names.forEach((name, i) => {
        const id = i === 0 ? ml[kind].nodeId : String(nextId++);   // first file keeps the template id
        const node = JSON.parse(JSON.stringify(protos[kind]));
        node.inputs[ml[kind].fieldName] = name;
        wfJson[id] = node;
        slot++;
        target.inputs['media_' + slot] = [id, 0];
        target.inputs['media_type_' + slot] = kind;
      });
    }
    return wfJson;
  }

  /* the Advanced "Singularity V2" checkbox (a `local` field: read by the app, never sent as a node value) */
  const singularityOn = () => {
    const e = fieldByName('singularity');
    return !!(state.current.singularity && e && e.input.checked);
  };

  /* ---------------- run ---------------- */
  function renderRunBar() {
    $('#run-area').replaceChildren(
      h('div', { class: 'run-bar' },
        h('button', { class: 'c-button c-button--brand c-button--large', type: 'button', id: 'btn-run', title: 'Ctrl+Enter works too', onclick: run }, '▶ Generate Video'),
      ),
      h('div', { id: 'validation', class: 'u-window-box-xsmall' }),
      h('div', { class: 'status-line', id: 'status-line' }),
    );
    validate();
  }

  function setBusy(b) {
    state.busy = b;
    const btn = $('#btn-run');
    if (btn) { btn.disabled = b || !state.canRun; btn.textContent = b ? '⏳ working…' : '▶ Generate Video'; }
  }

  async function run() {
    if (state.busy) return;
    clearAlerts();
    const s = state.settings, wf = state.current;
    if (!s.apiKey) { showAlert('warning', h('strong', {}, 'No API key. '), 'Open ⚙ Settings and paste your RunningHub API key.'); return; }
    if (!workflowIdOk(wf)) { showAlert('warning', h('strong', {}, 'No Workflow ID. '), 'This workflow has no workflowId in api/manifest.json.'); return; }
    if (!state.canRun) { validate(); return; }
    if (state.templateProblems && state.templateProblems.length) { showTemplateProblems(wf); return; }

    setBusy(true);
    let stage = 'reading the form';
    try {
      const isRef = isReferenceMode();
      const pending = [];   // { file, bucket, assetId } — keyframes keep their FL2VA order
      if (isRef) {
        for (const bucket of ['images', 'audios', 'videos']) {
          for (const it of state.uploads[bucket]) pending.push({ file: it.file, bucket, assetId: it.assetId });
        }
      } else {
        if (state.keyframes.first) pending.push({ file: state.keyframes.first.file, bucket: 'images', assetId: state.keyframes.first.assetId });
        if (state.keyframes.last) pending.push({ file: state.keyframes.last.file, bucket: 'images', assetId: state.keyframes.last.assetId });
      }

      // ---- rewrite the prompt here in the browser, with the official H3 guide ----
      const promptEntry = fieldByName('prompt');
      const resEntry = fieldByName('resolution');
      const secondsEntry = fieldByName('seconds');
      const aspectEntry = fieldByName('aspect_ratio');
      const rawPrompt = promptEntry ? promptEntry.input.value : '';
      let submittedPrompt = rawPrompt;
      const opt = state.settings.optimizer || {};
      const optProvider = opt.provider === 'openai' ? 'openai' : 'gemini';
      if (opt.enabled && H3Optimizer.looksFormatted(rawPrompt)) {
        /* an already guide-formatted prompt (a Regenerate, or a paste of an old
           rewrite) goes in untouched — rewriting a rewrite drifts the structure
           and spends a full LLM call for nothing */
        statusLine('Prompt already follows the guide format — optimizer skipped. Edit or remove the section headers to re-optimize.', false);
      } else if (opt.enabled) {
        stage = 'optimizing the prompt';
        const counts = { images: 0, videos: 0, audios: 0 };
        for (const p of pending) counts[p.bucket]++;
        statusLine('Optimizing prompt with the official H3 guide…');
        try {
          submittedPrompt = await H3Optimizer.optimize({
            provider: optProvider,
            apiKey: optProvider === 'openai' ? opt.openaiKey : opt.apiKey,
            model: optProvider === 'openai' ? opt.openaiModel : opt.model,
            baseUrl: opt.openaiBaseUrl,
            prompt: rawPrompt,
            mode: isRef ? 'reference' : 'image',
            seconds: secondsEntry ? parseFloat(secondsEntry.input.value) : 5,
            aspect: aspectEntry ? aspectEntry.value : '9:16',
            resolution: resEntry ? resEntry.input.value : null,
            first: !!state.keyframes.first, last: !!state.keyframes.last,
            mediaFiles: pending.map((p) => p.file),
            counts, readMedia: !!opt.readMedia,
            singularity: singularityOn(),
            onNote: (m) => statusLine(m, false),
          });
        } catch (e) {
          /* optimizer ON = the user wants the rewrite: a failed rewrite stops the
             run (nothing uploaded, no coins spent). The raw prompt only goes
             through when the optimizer is switched off in Settings. */
          showAlert('error', h('strong', {}, 'Prompt optimization failed — nothing was generated. '), e.message,
            h('div', { class: 'fail-hint-note' }, 'Press Generate to try again, or switch the optimizer off in ⚙ Settings → LLM Provider to run your prompt as typed.'));
          statusLine('', false);
          return;
        }
      }

      // ---- upload media (reusing RunningHub file names cached on library assets) ----
      stage = 'uploading media';
      /* up to 3 uploads at once (9 images + 3 videos one by one was the slow
         part of submitting); names land by index so @Image1… keep their order */
      const mediaNames = { images: [], audios: [], videos: [] };
      const names = new Array(pending.length);
      let next = 0, done = 0;
      const uploadWorker = async () => {
        while (next < pending.length) {
          const i = next++;
          const p = pending[i];
          const asset = p.assetId ? state.assetsById.get(p.assetId) : null;
          const fresh = asset && asset.rhFileName && (Date.now() - (asset.rhUploadedAt || 0) < ASSET_RH_TTL);
          if (fresh) { names[i] = asset.rhFileName; continue; }
          statusLine(`Uploading ${++done}/${pending.length}: ${p.file.name}`);
          names[i] = await RH.uploadFile(s.apiKey, s.base, p.file);
          if (asset) { asset.rhFileName = names[i]; asset.rhUploadedAt = Date.now(); await assetSave(asset); }
        }
      };
      await Promise.all([uploadWorker(), uploadWorker(), uploadWorker()]);
      pending.forEach((p, i) => mediaNames[p.bucket].push(names[i]));
      stage = 'submitting the task';
      const { ni, seed } = buildNodeInfoList(mediaNames, submittedPrompt);
      let workflow = null;
      if (wf.sendWorkflowJson) {
        /* never fall back to the saved canvas silently — without the template
           the cloned media loaders (and every media file past the first) are lost */
        if (!state.workflowJson) throw new Error(`api/${wf.file} did not load — refresh the page and check the file`);
        workflow = JSON.stringify(buildWorkflowJson(state.workflowJson, ni, mediaNames, singularityOn()));
      }
      const coinBefore = RH.account(s.apiKey, s.base).catch(() => null);
      const taskId = await RH.createTask(
        {
          apiKey: s.apiKey, base: s.base, workflowId: getWorkflowId(wf), nodeInfoList: ni,
          workflow,
        },
        { onQueueMaxed: (n) => statusLine(`Queue maxed (421) — retrying in 30s (attempt ${n}/3). Rejected submits spend no credits.`) },
      );
      // everything needed to reproduce this run from the form (Regenerate)
      const snapshot = {
        mode: isRef ? 'reference' : 'image',
        fields: readRunFields(),
        media: {
          images: state.uploads.images.map((x) => x.assetId).filter(Boolean),
          audios: state.uploads.audios.map((x) => x.assetId).filter(Boolean),
          videos: state.uploads.videos.map((x) => x.assetId).filter(Boolean),
        },
        keyframes: {
          first: state.keyframes.first ? state.keyframes.first.assetId || null : null,
          last: state.keyframes.last ? state.keyframes.last.assetId || null : null,
        },
        seed: seed,
      };
      const usedPrompt = (ni.find((e) => e.nodeId === '1' && e.fieldName === 'prompt') || {}).fieldValue ?? '';
      const stepsVal = formSteps();
      const transVal = fieldByName('transition_step');
      const runCtx = {     // "run" is this function — don't shadow it
        taskId, seed,
        rawPrompt,
        usedPrompt: String(usedPrompt),
        steps: stepsVal ?? null,
        transition: transVal ? parseFloat(transVal.input.value) : null,
        resolution: resEntry ? resEntry.input.value : null,
        secondsWanted: secondsEntry ? parseFloat(secondsEntry.input.value) : null,
        outputNodes: (wf.outputNodes || []).map(String),   // which node's files ARE the run's output
        snapshot,
        coinBefore: await coinBefore,
        startedAt: Date.now(),   // for the elapsed display — never reset
        watchStart: Date.now(),  // watchdog baseline — reset when the user resumes watching
        queuedSince: null,
        errStreak: 0,
        finished: false,
        poll: null, badgeEl: null, elapsedEl: null, rowEl: null, msgEl: null, btnEl: null,
      };
      statusLine('', false);
      startTrackedRun(runCtx);
    } catch (err) {
      showAlert('error', h('strong', {}, `Failed while ${stage}. `), err.message || String(err));
      statusLine('', false);
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- polling + outputs (multiple concurrent runs) ---------------- */

  /* one tracked run = sidebar status row + preview placeholder + poller.
     Shared by generator runs and action runs (js/actions.js Upscale) — the
     placeholder is the same "Generating preview…" box for both. */
  function startTrackedRun(runCtx) {
    state.runs.set(runCtx.taskId, runCtx);
    renderRunRow(runCtx);
    ensureClock();
    startPoller(runCtx);
    /* "latent field": a 16×9 grid of dots (the video's own shape) that a slow
       diagonal wave brightens, each dot's delay jittered a little so the field
       looks like it is resolving out of noise rather than marching. Opacity +
       transform keyframes only; deliberately NOT gated on prefers-reduced-
       motion (Windows "animation effects" off would freeze it). */
    const dots = [];
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 16; c++) {
        const jitter = ((c * 7 + r * 13) % 10) / 10 * 0.35;   // fixed pseudo-random 0–0.35s
        dots.push(h('span', { style: `--d:${((c + r) * 0.11 + jitter).toFixed(2)}s` }));
      }
    }
    $('#output-area').prepend(h('div', { class: 'output-entry output-entry--preview', 'data-id': runCtx.taskId },
      h('div', { class: 'preview-placeholder' },
        h('div', { class: 'latent-field', 'aria-hidden': 'true' }, dots),
        h('div', { class: 'preview-caption' },
          h('span', { class: 'preview-label' }, 'Generating'),
          runCtx.elapsedEl = h('span', { class: 'preview-elapsed' }, '0s')))));
    if (FCActions.refreshButtons) FCActions.refreshButtons();
  }

  function renderRunRow(run) {
    run.rowEl = h('div', { class: 'run-bar run-row u-window-box-xsmall' },
      run.badgeEl = h('span', { class: 'c-badge c-badge--info' }, run.label || 'RUNNING'),
      h('span', { class: 'task-id' }, run.taskId),
      run.btnEl = h('button', { class: 'c-button', type: 'button', title: 'cancel this task on RunningHub', onclick: () => onRunButton(run) }, 'cancel task'),
      run.msgEl = h('div', { class: 'run-msg' }),
    );
    $('#run-area').append(run.rowEl);
  }

  function onRunButton(run) {
    if (run.finished) {                       // finished runs keep their row until dismissed
      if (run.rowEl) { run.rowEl.remove(); run.rowEl = null; }
      return;
    }
    cancelRun(run);
  }

  /* "cancel task": cancels on RunningHub first, then stops watching. If the
     cancel call fails the row stays live (the task may still be running and
     spending coins) and the alert offers to stop watching anyway. */
  async function cancelRun(run) {
    if (run.cancelling) return;
    if (!confirm(`Cancel task ${run.taskId} on RunningHub?`)) return;
    const s = state.settings;
    run.cancelling = true;
    if (run.btnEl) { run.btnEl.disabled = true; run.btnEl.textContent = 'cancelling…'; }
    try {
      await RH.cancel(s.apiKey, s.base, run.taskId);
      if (run.finished) return;   // the poller saw it finish/cancel first and already cleaned up
      stopRunPolling(run);
      statusLine(`Task ${run.taskId} cancelled on RunningHub.`, false);
      refreshBalance();
    } catch (e) {
      if (run.btnEl) { run.btnEl.disabled = false; run.btnEl.textContent = 'cancel task'; }
      if (run.finished) return;   // it finished while the cancel was in flight — the poller handled it
      showAlert('error', h('strong', {}, `Could not cancel task ${run.taskId}. `), (e && e.message) || String(e), ' ',
        h('button', { class: 'c-button', type: 'button', onclick: () => {
          clearAlerts(); stopRunPolling(run);
          statusLine('Stopped watching — the task may still be running on RunningHub.', false);
        } }, 'stop watching anyway'));
    } finally {
      run.cancelling = false;
    }
  }

  function setRunMsg(run, text) {
    if (!run.msgEl) return;
    run.msgEl.textContent = text || '';
    run.msgEl.title = text || '';
  }

  function ensureClock() {
    if (state.pollClock) return;
    state.pollClock = setInterval(() => {
      for (const run of state.runs.values()) {
        if (run.elapsedEl) run.elapsedEl.textContent = fmtSecs((Date.now() - run.startedAt) / 1000);
      }
    }, 1000);
  }

  function maybeStopClock() {
    if (!state.runs.size && state.pollClock) { clearInterval(state.pollClock); state.pollClock = null; }
    if (FCActions.refreshButtons) FCActions.refreshButtons();   // a finished upscale re-enables its button
  }

  /* self-scheduling poller so repeated failures can back off instead of hammering */
  function scheduleTick(run, ms) {
    if (run.finished) return;
    if (run.poll) clearTimeout(run.poll);
    run.poll = setTimeout(() => { run.poll = null; tickRun(run); }, ms);
  }

  const startPoller = (run) => scheduleTick(run, 0);

  function stopRunPolling(run) {
    if (run.poll) clearTimeout(run.poll);
    run.poll = null;
    run.finished = true;
    if (run.rowEl) { run.rowEl.remove(); run.rowEl = null; }
    removePreviewEntry(run.taskId);   // a manually stopped task leaves no placeholder behind
    state.runs.delete(run.taskId);
    maybeStopClock();
  }

  /* Stop watching, but keep the row + the reason on screen (unlike a user-requested stop). */
  function abortRun(run, label, message, canResume) {
    if (run.poll) clearTimeout(run.poll);
    run.poll = null;
    run.finished = true;
    state.runs.delete(run.taskId);
    maybeStopClock();
    removePreviewEntry(run.taskId);
    if (run.badgeEl) { run.badgeEl.textContent = label; run.badgeEl.className = 'c-badge c-badge--error'; }
    if (run.elapsedEl) run.elapsedEl.textContent = fmtSecs((Date.now() - run.startedAt) / 1000);
    if (run.btnEl) run.btnEl.textContent = 'dismiss';
    setRunMsg(run, `stopped watching — ${label.toLowerCase()}`);
    showAlert('error',
      h('strong', {}, `${label} — task ${run.taskId}. `),
      message,
      canResume ? ' ' : null,
      canResume ? h('button', { class: 'c-button', type: 'button', onclick: () => resumeRun(run) }, 'keep watching') : null);
  }

  /* Opt back in to watching a task we gave up on (extra window, not a re-submit). */
  function resumeRun(run) {
    run.finished = false;
    run.errStreak = 0;
    run.queuedSince = null;
    run.watchStart = Date.now();
    clearAlerts();
    if (run.badgeEl) { run.badgeEl.textContent = run.label || 'RUNNING'; run.badgeEl.className = 'c-badge c-badge--info'; }
    if (run.btnEl) run.btnEl.textContent = 'cancel task';
    setRunMsg(run, '');
    state.runs.set(run.taskId, run);
    if (!run.rowEl) return;     // row was dismissed; nothing to update
    ensureClock();
    scheduleTick(run, 0);
  }

  async function tickRun(run) {
    if (run.finished) return;
    const s = state.settings;
    const elapsed = Date.now() - run.startedAt;
    try {
      const st = await RH.status(s.apiKey, s.base, run.taskId);
      run.errStreak = 0;
      setRunMsg(run, '');
      const done = DONE_STATES.includes(st);
      const queued = !done && /queue|pend|wait|creat|hold/i.test(st);
      run.queuedSince = queued ? (run.queuedSince || Date.now()) : null;

      if (run.badgeEl) {
        /* action runs (Upscale) keep their label; colour still tracks the live status */
        run.badgeEl.textContent = run.label || st;
        run.badgeEl.className = 'c-badge ' + (st === 'SUCCESS' || st === 'PARTIAL_SUCCESS' ? 'c-badge--success'
          : done ? 'c-badge--error' : 'c-badge--info');
      }
      if (done) { stopRunPolling(run); await finishTask(run, st); return; }

      if (run.queuedSince && Date.now() - run.queuedSince > QUEUE_STUCK_MS) {
        abortRun(run, 'Stuck in queue',
          `Still "${st}" after ${fmtSecs((Date.now() - run.queuedSince) / 1000)} — it never started, so nothing was spent. ` +
          'Check it on RunningHub with the task id above, or just run again.', true);
        return;
      }
      if (Date.now() - run.watchStart > RUN_STUCK_MS) {
        abortRun(run, 'Timed out',
          `No verdict after ${fmtSecs(elapsed / 1000)} (last status "${st}"). The task may still finish on RunningHub — ` +
          'check it with the task id above.', true);
        return;
      }
      scheduleTick(run, POLL_MS);
    } catch (e) {
      run.errStreak++;
      const msg = (e && e.message) || 'Unknown error';
      if (run.badgeEl) {
        run.badgeEl.textContent = run.errStreak > 1 ? `error ×${run.errStreak}` : 'error';
        run.badgeEl.className = 'c-badge c-badge--warning';
      }
      setRunMsg(run, msg);
      if (run.errStreak >= POLL_ERR_LIMIT) {
        abortRun(run, 'Connection lost',
          `Could not read this task's status ${run.errStreak} times in a row. Last error: ${msg} ` +
          'The task itself may still be fine on RunningHub — check it with the task id above.', true);
        return;
      }
      scheduleTick(run, Math.min(POLL_MS * run.errStreak, 30 * 1000));   // gentle backoff
    }
  }

  const coinFromItems = (items) => {
    for (const it of items || []) {
      for (const [k, v] of Object.entries(it || {})) {
        if (/coin|consume|money|credit/i.test(k) && v != null && Number.isFinite(parseFloat(v))) return parseFloat(v);
      }
    }
    return null;
  };

  /* duration probe for ambiguous multi-mp4 outputs: preload each candidate's
     metadata offscreen and keep the one closest to the requested Duration */
  const probeDuration = (url) => new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    let settled = false;
    const done = (d) => { if (settled) return; settled = true; v.removeAttribute('src'); resolve(d); };
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    v.src = url;
  });

  async function pickMp4ByDuration(mp4s, wanted) {
    const durs = await Promise.all(mp4s.map((m) => probeDuration(m.fileUrl)));
    let best = null, bestDiff = Infinity;
    mp4s.forEach((m, i) => {
      if (durs[i] == null) return;
      const diff = Math.abs(durs[i] - wanted);
      if (diff < bestDiff) { bestDiff = diff; best = m; }
    });
    return best;
  }

  /* ---------------- persistent stacked outputs (latest first) ---------------- */
  /* stamp "YYYY-MM-DD - HH:MM:SS" sorts lexicographically — re-sort on load so
     the grid is ALWAYS recent task first, even for a hand-edited or old-order store */
  const loadStoredOutputs = () => {
    try {
      return JSON.parse(localStorage.getItem(OUT_STORE) || '[]')
        .sort((a, b) => String(b.stamp || '').localeCompare(String(a.stamp || '')));
    } catch (e) { return []; }
  };
  /* see saveSettings: a throwing setItem (private mode/quota) must not cost the
     user their freshly rendered output — rendering continues, persistence is skipped */
  const saveStoredOutputs = (list) => {
    try { localStorage.setItem(OUT_STORE, JSON.stringify(list.slice(0, OUTPUT_STORE_MAX))); } catch (e) { /* session-only */ }
  };

  /* when was this entry finished? new entries carry createdAt; older stored
     ones only have the display stamp "YYYY-MM-DD - HH:MM:SS", parsed here in
     LOCAL time (that's how it was written). null = unknown, never "expired" */
  function entryTime(entry) {
    if (entry.createdAt) return entry.createdAt;
    const m = /(\d{4})-(\d{2})-(\d{2}) - (\d{2}):(\d{2}):(\d{2})/.exec(entry.stamp || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
  }
  const isExpired = (entry) => {
    const t = entryTime(entry);
    return t != null && (Date.now() - t) > EXPIRE_DAYS * 86400000;
  };

  function metaStrip(entry) {
    const seg = (cls, label, value) => h('span', { class: 'meta-seg' },
      label ? h('span', { class: 'lbl' }, label + ': ') : null,
      h('span', { class: 'val ' + cls }, value));
    const usd = usdFromCoins(entry.coins);
    /* upscaled entries have no seed/steps/resolution of their own — date, runtime
       and coins are the real facts, so only those are shown */
    const parts = [];
    const add = (el) => { if (parts.length) parts.push(h('span', { class: 'meta-sep' }, '|')); parts.push(el); };
    if (!entry.upscaled) add(seg('val-seed', 'Seed', entry.seed ?? '—'));
    add(seg('val-date', '', entry.stamp));
    add(seg('val-runtime', 'Run', entry.runtime || '?'));
    /* coins + USD are ONE fact: "Coins: 28|$0.008" — in a single segment so the
       strip's flex gap doesn't wedge a wide space between them */
    add(seg('val-coins', 'Coins', (entry.coins || 'n/a') + (usd ? '|' + usd : '')));
    if (!entry.upscaled) {
      /* "Steps: 8|5" — the second number is the SelfLift transition step */
      const stepsLabel = entry.steps != null
        ? String(entry.steps) + (entry.transition != null ? '|' + entry.transition : '')
        : '—';
      add(seg('val-steps', 'Steps', stepsLabel));
      add(seg('val-resolution', 'Resolution', entry.resolution ?? '—'));
    }
    if (isExpired(entry)) add(seg('val-expired', '', 'expired — RH keeps outputs 14 days'));
    return h('div', { class: 'output-meta' }, ...parts);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      /* clipboard API blocked (permission/file://) — execCommand fallback */
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e2) { /* clipboard unavailable */ }
      ta.remove();
    }
  }

  /* ---------------- prompt panel beside the Preview player ----------------
     Two tabs — Submitted (what RunningHub got, the optimizer's rewrite when it
     ran) and As Typed — each with its own scroll and its own Copy button. */
  function promptPanel(entry) {
    const used = entry.usedPrompt && entry.usedPrompt.trim();
    const raw = entry.rawPrompt && entry.rawPrompt.trim();
    if (!used && !raw) return null;
    const same = !raw || !used || raw === used;
    const tabs = [
      { label: 'Submitted', text: used ? entry.usedPrompt : entry.rawPrompt },
      { label: 'As Typed', text: raw ? entry.rawPrompt : entry.usedPrompt,
        note: same ? 'Same as Submitted — the optimizer did not rewrite this prompt.' : null },
    ];
    const headings = [], panes = [];
    const select = (i) => {
      headings.forEach((b, j) => { b.classList.toggle('c-tab-heading--active', i === j); b.setAttribute('aria-selected', String(i === j)); });
      panes.forEach((p, j) => { p.hidden = i !== j; });
    };
    tabs.forEach((t, i) => {
      headings.push(h('button', { class: 'c-tab-heading', type: 'button', role: 'tab', onclick: () => select(i) }, t.label));
      const copyBtn = h('button', { class: 'c-button prompt-copy', type: 'button', title: `copy the ${t.label.toLowerCase()} prompt` }, '⧉ Copy');
      copyBtn.addEventListener('click', async () => {
        await copyText(t.text);
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => { copyBtn.textContent = '⧉ Copy'; }, 1500);
      });
      panes.push(h('div', { class: 'preview-prompt__pane', role: 'tabpanel' },
        t.note ? h('div', { class: 'preview-prompt__note' }, t.note) : null,
        h('div', { class: 'preview-prompt__scroll' }, h('pre', { class: 'preview-prompt__body' }, t.text)),
        h('div', { class: 'preview-prompt__foot' }, copyBtn)));
    });
    select(0);
    return h('div', { class: 'preview-prompt' },
      h('div', { class: 'c-tabs preview-prompt__tabs', role: 'tablist' },
        h('div', { class: 'c-tabs__nav' }, h('div', { class: 'c-tabs__headings' }, ...headings))),
      ...panes);
  }

  /* A long output list stays cheap by PAGING instead of by hiding the media: only the newest
     OUTPUT_PAGE entries are in the DOM, and a "load older" button appends the next page.
     Videos get "#t=0.1" so the browser renders the first frame as the preview — never a blank box. */

  /* ---------------- Preview popup (big player) ----------------
     A phone-sized look at the output: the video at up to ~40% of the screen
     with a sharp white 1px border, no radius, ✕ or click-outside to close.
     Deliberately NOT fullscreen — fullscreen upscales a 540P clip far past its
     source resolution and looks blurrier than a phone screen ever would. */
  let previewModal = null;
  let previewStep = null;   // (±1) => move the popup to the neighbouring output
  /* Esc closes; ← / → step through the outputs — but not while the video or a
     form control has focus, where the arrows already seek / move the caret */
  const previewKeys = (e) => {
    if (e.key === 'Escape') { closeVideoPreview(); return; }
    if (!previewStep || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    if (e.target.closest && e.target.closest('video, input, textarea, select')) return;
    e.preventDefault();
    previewStep(e.key === 'ArrowLeft' ? -1 : 1);
  };
  function closeVideoPreview() {
    if (!previewModal) return;
    previewModal.remove();
    previewModal = null;
    previewStep = null;
    document.removeEventListener('keydown', previewKeys);
  }

  /* Previous / Next under the popup: the same order as the grid (newest
     first, the ★ filter respected) — Next = the card after this one */
  function previewNav(entry) {
    const list = visibleOutputs().filter((e) => e.video);
    const i = list.findIndex((e) => e === entry || (e.id != null && e.id === entry.id));
    if (i < 0 || list.length < 2) return null;
    const go = (d) => { const next = list[i + d]; if (next) openVideoPreview(next); };
    previewStep = go;
    const btn = (d, label, arrow) => h('button', {
      class: 'preview-nav__btn', type: 'button', title: `${label} output (${d < 0 ? '←' : '→'})`,
      onclick: () => go(d), ...(list[i + d] ? {} : { disabled: '' }),
    }, d < 0 ? [h('span', { class: 'preview-nav__arrow' }, arrow), label] : [label, h('span', { class: 'preview-nav__arrow' }, arrow)]);
    return h('div', { class: 'preview-nav' },
      btn(-1, 'Previous', '◀'),
      h('span', { class: 'preview-nav__count' }, `${i + 1} / ${list.length}`),
      btn(1, 'Next', '▶'));
  }

  function openVideoPreview(entry) {
    const url = typeof entry === 'string' ? entry : entry.video;   // string kept for older callers
    closeVideoPreview();
    /* never two players at once — pause every other video on the page (the
       output entries' inline players) so the popup and a card can't play
       together; runs before the popup video exists, so it can't hit itself */
    for (const v of document.querySelectorAll('video')) { try { v.pause(); } catch (e) { /* not ready yet */ } }
    const video = h('video', { controls: '', autoplay: '', muted: '', playsinline: '', src: url + '#t=0.1' });
    /* The player must land on WHOLE DEVICE pixels, not just whole CSS pixels:
       at fractional device scaling (Windows 150%) an odd CSS-px width sits on a
       half device pixel and the 1px border on that edge simply doesn't paint —
       the "some videos have no right border" bug. Snap w/h to the device grid,
       and drop the CSS max-width/max-height caps once sized (the vw caps are
       fractional and would re-clip to a fractional width). With the prompt
       panel beside it, cap the video tighter so the pair fits. */
    const panel = typeof entry === 'string' ? null : promptPanel(entry);
    const sizeToAspect = () => {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return;
      const dpr = window.devicePixelRatio || 1;
      const snap = (x) => Math.round(x * dpr) / dpr;
      const maxW = Math.floor(window.innerWidth * (panel ? 0.34 : 0.4));
      const maxH = Math.floor(window.innerHeight * 0.8);
      let w = maxW, ht = Math.round(w * vh / vw);
      if (ht > maxH) { ht = maxH; w = Math.round(ht * vw / vh); }
      video.style.maxWidth = 'none';
      video.style.maxHeight = 'none';
      video.style.width = snap(w) + 'px';
      video.style.height = snap(ht) + 'px';
      video.classList.add('is-sized');
    };
    video.addEventListener('loadedmetadata', sizeToAspect);
    if (video.readyState >= 1) sizeToAspect();
    const nav = typeof entry === 'string' ? null : previewNav(entry);
    previewModal = h('div', { class: 'preview-modal', onclick: (e) => { if (e.target === previewModal) closeVideoPreview(); } },
      h('div', { class: 'preview-modal__stack' },
        h('div', { class: 'preview-modal__box' },
          h('button', { class: 'preview-modal__close', type: 'button', title: 'close', 'aria-label': 'close preview', onclick: closeVideoPreview }, '✕'),
          video,
          panel),
        nav));
    document.body.append(previewModal);
    document.addEventListener('keydown', previewKeys);
  }

  /* ---------------- ⤓ Extract Frame -> asset library ----------------
     Scrub the card's video to the moment you want, click ⤓ Extract Frame:
     the playhead frame is saved as a full-resolution JPEG in the local asset
     library — the chaining flow is extract a video's (last) frame, then pick
     it as the next run's first frame. CDN videos taint the canvas (CORS), so
     on SecurityError the video is re-fetched as a blob — a same-origin copy —
     and the frame is drawn from that instead. */
  const grabVideoFrame = (v) => new Promise((resolve, reject) => {
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the frame'))), 'image/jpeg', 0.95);
  });

  async function frameViaFetch(url, t) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching the video back for frame extraction');
    const blobUrl = URL.createObjectURL(await res.blob());
    try {
      const v = await new Promise((resolve, reject) => {
        const el = document.createElement('video');
        el.muted = true; el.preload = 'auto';
        el.onloadeddata = () => { try { el.currentTime = t; } catch (e) { resolve(el); } };
        el.onseeked = () => resolve(el);
        el.onerror = () => reject(new Error('could not decode the fetched video'));
        el.src = blobUrl;
      });
      return await grabVideoFrame(v);
    } finally { URL.revokeObjectURL(blobUrl); }
  }

  async function extractFrameToAssets(entry, videoEl) {
    if (!videoEl || !videoEl.videoWidth) {
      statusLine('The video is not loaded yet — let it finish loading, then try again.', false);
      return;
    }
    const t = videoEl.currentTime || 0;
    try {
      let blob;
      try {
        blob = await grabVideoFrame(videoEl);
      } catch (e) {
        blob = await frameViaFetch(entry.video, t);   // SecurityError: tainted canvas
      }
      const file = new File([blob],
        'frame-' + Math.round(t * 1000) + 'ms-' + String(entry.id).slice(-6) + '.jpg',
        { type: 'image/jpeg' });
      const r = await addAssetFromFile(file);
      refreshAssetButtons();
      statusLine(r.duplicate ? 'That exact frame is already in your Assets — not saved again.'
        : r.full ? 'Asset library full (' + ASSET_MAX + ' max) — frame not saved.'
        : 'Frame at ' + t.toFixed(1) + 's saved to Assets (' + state.assets.length + '/' + ASSET_MAX + ').', false);
    } catch (err) {
      showAlert('warning', h('strong', {}, 'Frame extraction failed. '), err.message || String(err));
    }
  }

  /* ⤓ download: <a download> is ignored for cross-origin URLs (the RunningHub
     CDN), so the file is fetched as a blob and saved under a readable name —
     frame-commander_<date>_<seed>.mp4. If the fetch is blocked, the video
     opens in a new tab instead, where the browser's own save works. */
  async function downloadVideo(entry, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    const date = String(entry.stamp || '').replace(/ - /, '_').replace(/:/g, '-').replace(/[^\w.-]/g, '');
    const name = `frame-commander_${date || entry.id}${entry.seed != null ? '_' + entry.seed : ''}.mp4`;
    try {
      const res = await fetch(entry.video);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const url = URL.createObjectURL(await res.blob());
      const a = h('a', { href: url, download: name, hidden: '' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      window.open(entry.video, '_blank', 'noopener');
    } finally {
      btn.disabled = false;
    }
  }

  /* sanity check on the card: if the video's real length is far off the
     requested Duration, the task's output list held something else (a stale
     file from RunningHub, or a second output branch ran on a merged canvas) —
     say so on the meta strip instead of silently showing a mismatched clip */
  function checkOutputDuration(entry, videoEl) {
    if (entry.secondsWanted == null || !Number.isFinite(videoEl.duration)) return;
    if (Math.abs(videoEl.duration - entry.secondsWanted) <= 2) return;
    const meta = document.querySelector(`.output-entry[data-id="${CSS.escape(entry.id)}"] .output-meta`);
    if (!meta || meta.querySelector('.val-warn')) return;
    meta.append(h('span', { class: 'meta-sep' }, '|'),
      h('span', { class: 'val val-warn' },
        `⚠ got ${Math.round(videoEl.duration)}s, asked for ${Math.round(entry.secondsWanted)}s — wrong output?`));
  }

  /* hover = preview the clip: play while the pointer is anywhere on the card
     (media or details popover), pause the moment it leaves. Hovering is not a
     user gesture, so unmuted play() is rejected by the autoplay policy — fall
     back to muted, the standard feed-preview behaviour. */
  function hoverVideo(entryEl, play) {
    const v = entryEl.querySelector('video');
    if (!v) return;
    if (!play) { try { v.pause(); } catch (e) { /* not started yet */ } return; }
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  }

  /* ☆ → ★: favorites persist with the entry; in the Favorites-filtered grid,
     un-starring a video takes it out of the view immediately */
  function toggleFavorite(entry) {
    entry.fav = !entry.fav;
    saveStoredOutputs(state.outputsEntries);
    const btn = document.querySelector(`.output-entry[data-id="${CSS.escape(entry.id)}"] .output-fav`);
    if (btn) {
      btn.replaceChildren(starSvg(entry.fav));
      btn.classList.toggle('is-fav', !!entry.fav);
      btn.title = entry.fav ? 'remove from favorites' : 'add to favorites';
    }
    if (state.favFilter && !entry.fav) dropCard(entry.id);
  }

  function renderOutputEntry(entry) {
    /* the media IS the card; meta/actions live in a compact popover that only
       exists on hover, attached to the media's bottom edge so the pointer slides
       from the video into it with no dead zone (overlay is a descendant, so
       hovering it keeps the card hovered — buttons stay clickable). The prompt
       is NOT here — it lives in the Preview popup's side panel. Past 14 days
       the whole card grays out — RunningHub stops serving the file. */
    const expired = isExpired(entry);
    return h('div', {
      class: 'output-entry' + (expired ? ' output-entry--expired' : ''), 'data-id': entry.id,
      onmouseenter: (e) => hoverVideo(e.currentTarget, true),
      onmouseleave: (e) => hoverVideo(e.currentTarget, false),
    },
      h('div', { class: 'output-video-wrap' },
        entry.video ? h('div', { class: 'output-video' },
          h('video', { controls: '', src: entry.video + '#t=0.1', preload: 'metadata', playsinline: '',
            onloadedmetadata: (e) => checkOutputDuration(entry, e.target) })) : null,
        ...(entry.images || []).map((u) => h('div', { class: 'output-video u-window-box-small' },
          h('img', { src: u, alt: 'output', loading: 'lazy', decoding: 'async' }))),
        expired ? h('div', { class: 'expired-badge' }, 'expired') : null,
        h('div', { class: 'output-details' },
          metaStrip(entry),
          h('div', { class: 'output-actions' },
            entry.snapshot ? h('button', {
              class: 'output-regen', type: 'button', title: 'load this run’s prompt, assets and settings back into the form',
              onclick: () => regenerate(entry),
            }, '↻ Regenerate') : null,
            entry.video ? h('button', {
              class: 'output-preview', type: 'button', title: 'open this video in a bigger player with its prompt beside it',
              onclick: () => openVideoPreview(entry),
            }, '▶ Preview') : null,
            entry.video ? h('button', {
              class: 'output-frame', type: 'button',
              title: 'save the frame at the playhead position to your asset library',
              onclick: (e) => extractFrameToAssets(entry, e.target.closest('.output-entry')?.querySelector('video')),
            }, '⤓ Extract Frame') : null,
            ...FCActions.buttonsFor(entry),
            entry.video ? h('button', {
              class: 'output-dl', type: 'button', title: 'download this video (.mp4)', 'aria-label': 'download video',
              onclick: (e) => downloadVideo(entry, e.currentTarget),
            }, downloadSvg()) : null,
            h('button', {
              class: 'output-fav' + (entry.fav ? ' is-fav' : ''), type: 'button',
              title: entry.fav ? 'remove from favorites' : 'add to favorites',
              onclick: () => toggleFavorite(entry),
            }, starSvg(entry.fav)),
            h('button', { class: 'output-remove', type: 'button', onclick: () => removeOutputEntry(entry.id) }, '✕ Remove')),
          entry.upscaled ? h('div', { class: 'upscaled-tag' }, '⬆ UPSCALED') : null)));
  }

  const loadOlderButton = () => {
    const rest = visibleOutputs().length - state.outputsShown;
    if (rest <= 0) return null;
    return h('button', { class: 'c-button load-older', type: 'button', onclick: loadOlderOutputs },
      'Load More');
  };

  function updateLoadOlder() {
    const area = $('#output-area');
    const old = area.querySelector('.load-older');
    const next = loadOlderButton();
    if (old && next) old.replaceWith(next);
    else if (old) old.remove();
    else if (next) area.append(next);
  }

  function loadOlderOutputs() {
    const area = $('#output-area');
    const btn = area.querySelector('.load-older');
    const next = visibleOutputs().slice(state.outputsShown, state.outputsShown + OUTPUT_PAGE);
    state.outputsShown += next.length;
    for (const e of next) area.insertBefore(renderOutputEntry(e), btn);
    updateLoadOlder();
  }

  /* the (possibly favorites-filtered) list — newest first */
  const visibleOutputs = () => (state.favFilter ? state.outputsEntries.filter((e) => e.fav) : state.outputsEntries);

  /* one render path for the grid: the newest page of visibleOutputs(). Rebuilds
     the DOM wholesale — the store is capped at OUTPUT_STORE_MAX, so this stays
     cheap; the "Generating preview…" placeholders are carried over, not lost. */
  function renderOutputList() {
    const area = $('#output-area');
    const placeholders = [...area.querySelectorAll('.output-entry--preview')];
    state.outputsShown = OUTPUT_PAGE;
    const list = visibleOutputs();
    area.replaceChildren(...placeholders, ...list.slice(0, state.outputsShown).map(renderOutputEntry));
    syncFavEmpty();
    updateLoadOlder();
  }

  /* finished (non-placeholder) cards currently in the grid */
  const outputCards = () => [...$('#output-area').querySelectorAll('.output-entry:not(.output-entry--preview)')];
  const cardOf = (id) => $('#output-area').querySelector(`.output-entry:not(.output-entry--preview)[data-id="${CSS.escape(id)}"]`);

  function syncFavEmpty() {
    const area = $('#output-area');
    const old = area.querySelector('.fav-empty');
    const empty = state.favFilter && !visibleOutputs().length;
    if (empty && !old) area.append(h('div', { class: 'fav-empty' }, 'No favorites yet — hover a video and click ☆ to star it.'));
    else if (!empty && old) old.remove();
  }

  /* newest first. Only the NEW card is inserted (after the running
     placeholders) — rebuilding the grid recreated every <video> and made all
     of them reload whenever a run finished. The oldest card drops off the
     page so the DOM stays at one page. */
  function addOutputEntry(entry) {
    const replacing = state.outputsEntries.some((e) => e.id === entry.id);   // never the same task twice
    state.outputsEntries = [entry, ...state.outputsEntries.filter((e) => e.id !== entry.id)].slice(0, OUTPUT_STORE_MAX);
    saveStoredOutputs(state.outputsEntries);
    if (replacing) { renderOutputList(); return; }
    if (state.favFilter && !entry.fav) return;   // stored, but not part of the filtered view
    const area = $('#output-area');
    const cards = outputCards();
    const anchor = cards[0] || area.querySelector('.load-older, .fav-empty');
    area.insertBefore(renderOutputEntry(entry), anchor || null);
    if (cards.length >= state.outputsShown) cards[cards.length - 1].remove();
    syncFavEmpty();
    updateLoadOlder();
  }

  /* drop just this card; the next older one (if any) slides in at the end */
  function removeOutputEntry(id) {
    state.outputsEntries = state.outputsEntries.filter((e) => e.id !== id);
    saveStoredOutputs(state.outputsEntries);
    dropCard(id);
  }

  function dropCard(id) {
    const card = cardOf(id);
    if (!card) return;
    card.remove();
    const nextEntry = visibleOutputs()[state.outputsShown - 1];
    if (nextEntry && !cardOf(nextEntry.id)) {
      const area = $('#output-area');
      area.insertBefore(renderOutputEntry(nextEntry), area.querySelector('.load-older'));
    }
    syncFavEmpty();
    updateLoadOlder();
  }

  function restoreStoredOutputs() {
    state.outputsEntries = loadStoredOutputs();
    renderOutputList();
  }

  function removePreviewEntry(taskId) {
    const ph = $('#output-area').querySelector(`.output-entry[data-id="${CSS.escape(taskId)}"]`);
    if (ph) ph.remove();
  }

  /* ---------------- completion chime ----------------
     Three loud bell strikes when a generation lands (three low dull thuds for
     a failure verdict) — no audio file, Web Audio oscillators only. A bell is
     synthesised the classic way: a sine fundamental plus inharmonic upper
     partials, each decaying at its own rate. Volume sits well above speech
     level so it carries to another room / over music.
     Browser autoplay policy: the AudioContext must be created/resumed by a
     user gesture first; the pointerdown listener below unlocks it on the very
     first click (pressing ▶ Generate Video qualifies). After that it can play
     while the tab is in the background. Note: heavily-backgrounded tabs get
     their timers throttled (to ~once a minute), so the chime may lag a bit —
     the task verdict simply arrives with the next poll. */
  let audioCtx = null;
  function ensureAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* no Web Audio — stay silent */ }
  }
  /* one bell strike: fundamental + inharmonic partials -> [multiplier, loudness, decay s] */
  function bellStrike(ctx, out, t0, freq, vol) {
    const partials = [
      [1.0, 1.0, 1.4],    // fundamental — rings the longest
      [2.0, 0.55, 0.8],   // octave
      [2.98, 0.4, 0.55],  // slightly flat third harmonic — the bell "shimmer"
      [4.21, 0.22, 0.32], // high inharmonic clang, gone quickly
    ];
    for (const [mult, amp, decay] of partials) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(vol * amp, t0 + 0.006);   // hard attack
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
      osc.connect(gain).connect(out);
      osc.start(t0);
      osc.stop(t0 + decay + 0.05);
    }
  }
  function chime(ok = true) {
    if (state.settings.sound === false) return;        // Settings toggle, default on
    if (!audioCtx || audioCtx.state !== 'running') return;   // never unlocked — skip
    const master = audioCtx.createGain();
    master.gain.value = 1.0;   // loud on purpose — this is the "it's done" bell
    master.connect(audioCtx.destination);
    const t0 = audioCtx.currentTime + 0.02;
    if (ok) {
      for (let i = 0; i < 3; i++) bellStrike(audioCtx, master, t0 + i * 0.3, 1046.5, 0.42);
    } else {
      for (let i = 0; i < 3; i++) bellStrike(audioCtx, master, t0 + i * 0.26, 220 - i * 22, 0.5);
    }
  }

  async function finishTask(run, st) {
    const s = state.settings;
    if (st === 'SUCCESS' || st === 'PARTIAL_SUCCESS') {
      try {
        const [items, coinAfter] = await Promise.all([
          RH.outputs(s.apiKey, s.base, run.taskId),
          RH.account(s.apiKey, s.base).catch(() => null),
        ]);
        const imgs = items.filter((i) => ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes((i.fileType || '').toLowerCase()));
        /* A merged canvas can end in SEVERAL output nodes (an upscaler branch
           left wired in runs on EVERY generation and emits its own mp4 — seen
           live: a task returned both the new video and a re-processed stale
           clip, and the app showed the stale one). Pick the mp4 from this
           workflow's real output node first; without a node match, the one
           whose duration fits the requested Duration. */
        const mp4s = items.filter((i) => (i.fileType || '').toLowerCase() === 'mp4');
        let mp4 = null;
        if (mp4s.length > 1 && run.outputNodes && run.outputNodes.length) {
          mp4 = mp4s.find((m) => run.outputNodes.includes(String(m.nodeId))) || null;
        }
        if (mp4s.length > 1 && !mp4 && run.secondsWanted != null) {
          mp4 = await pickMp4ByDuration(mp4s, run.secondsWanted);
        }
        if (!mp4) mp4 = mp4s[0];
        const pad = (n) => String(n).padStart(2, '0');
        const now = new Date();
        const itemCoins = coinFromItems(items);
        const entry = {
          id: run.taskId,
          seed: run.seed,
          createdAt: Date.now(),
          stamp: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} - ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
          runtime: mp4 && mp4.taskCostTime ? fmtSecs(mp4.taskCostTime) : '?',
          coins: itemCoins != null ? String(Math.round(itemCoins)) : coinDelta(run.coinBefore, coinAfter),
          steps: run.steps,
          transition: run.transition,
          resolution: run.resolution,
          secondsWanted: run.secondsWanted ?? null,
          usedPrompt: run.usedPrompt,
          rawPrompt: run.rawPrompt,
          snapshot: run.snapshot,
          upscaled: run.upscaled || null,
          video: mp4 ? mp4.fileUrl : null,
          images: imgs.map((i) => i.fileUrl),
        };
        removePreviewEntry(run.taskId);
        addOutputEntry(entry);
        if (coinNum(coinAfter) != null) showBalance(coinNum(coinAfter)); else refreshBalance();
        chime(true);
        return;
      } catch (e) {
        /* the run SUCCEEDED — only the download of its result failed. Re-fetching costs no credits. */
        removePreviewEntry(run.taskId);
        showAlert('warning',
          h('strong', {}, `Task ${run.taskId} finished, but fetching its output failed. `),
          (e && e.message) || '', ' ',
          h('button', {
            class: 'c-button c-button--brand', type: 'button',
            onclick: () => { clearAlerts(); finishTask(run, st); },
          }, 'fetch output again'));
        return;
      }
    }
    removePreviewEntry(run.taskId);
    refreshBalance();
    /* cancelled on RunningHub's side (their task list, another tab): the app
       just drops the run — no failure lookup, no failure chime */
    if (isCancelState(st)) {
      if (!run.cancelling) showAlert('info', h('strong', {}, `Task ${run.taskId} was cancelled on RunningHub. `), 'Removed it from the queue here too.');
      return;
    }
    chime(false);
    /* ask RunningHub why it failed (the plain status endpoint carries no
       reason) — best effort only: without it we fall back to the generic text */
    const fail = await fetchFailDetails(run);
    if (fail && fail.hint) setRunMsg(run, fail.hint);
    showAlert('error',
      h('strong', {}, `Task ${run.taskId} ended ${st}. `),
      (fail && fail.hint) || 'Check it on RunningHub with the task id above, then run again. A rejected task spends no credits.',
      fail && fail.raw ? h('details', { class: 'fail-details' },
        h('summary', {}, 'technical details (from RunningHub)'),
        h('pre', { class: 'fail-details__raw' }, fail.raw)) : null,
      run.upscaled ? h('button', {
        class: 'c-button', type: 'button',
        onclick: () => { clearAlerts(); FCActions.runActionForEntry(run.upscaled.action, run.upscaled.fromId); },
      }, '↻ Retry upscale') : null,
    );
  }

  /* Pull a FAILURE's reason via the batch task endpoint and distil it:
     -> { hint: plain-English cause or null, raw: readable technical text }
     Never throws — a missing/unexpected endpoint just yields null. */
  async function fetchFailDetails(run) {
    const s = state.settings;
    try {
      const info = await RH.taskInfo(s.apiKey, s.base, run.taskId);
      const raw = failReasonText(info);
      return { hint: friendlyFailHint(raw), raw };
    } catch (e) {
      return null;
    }
  }

  /* flatten a task record's failReason (string or nested object, possibly
     JSON-in-a-string) into readable "key: value" lines, message keys only */
  function failReasonText(info) {
    if (!info) return '';
    let node = info.failReason ?? info.failedReason ?? info.failMsg ?? info;
    if (typeof node === 'string') {
      try { node = JSON.parse(node); } catch (e) { return node.slice(0, 4000); }
    }
    const parts = [];
    const walk = (n, depth) => {
      if (!n || typeof n !== 'object' || depth > 4) return;
      for (const [k, v] of Object.entries(n)) {
        if (typeof v === 'string') {
          if (/message|reason|error|exception|traceback|node_name|node_id/i.test(k)) {
            parts.push(`${k}: ${v.length > 2000 ? v.slice(0, 2000) + ' …' : v}`);
          }
        } else if (v && typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(node, 0);
    return parts.join('\n');
  }

  /* match the signatures we've seen in the wild to an actionable sentence */
  function friendlyFailHint(text) {
    const t = (text || '').toLowerCase();
    if (!t) return null;
    if (/out of memory|cudaerrormemoryallocation/.test(t)) {
      return 'RunningHub\'s GPU ran out of memory. This happened on their server, not in the app — usually the GPU was just busy with another job (it couldn\'t even start the upscaler worker). Wait a couple of minutes and retry; longer or larger videos make it more likely.';
    }
    if (/connection reset by peer|worker exit code/.test(t)) {
      return 'The workflow\'s helper worker crashed on RunningHub\'s server mid-run. Usually transient — retry; if it repeats, the task may be too heavy for the GPU it lands on (try a smaller/shorter video).';
    }
    if (/cuda error|runtimeerror.*cuda/.test(t)) {
      return 'A CUDA (GPU) error occurred on RunningHub\'s server. Usually transient or GPU-specific — retry, or try again later when a different GPU is free.';
    }
    if (/valueerror|keyerror|attributeerror|typeerror/.test(t)) {
      return 'The workflow itself raised an error on RunningHub (a node got an input it doesn\'t accept). If this workflow ran fine before, RunningHub\'s template may have changed — check the node named in the technical details.';
    }
    return null;
  }

  /* ---------------- header: RH Coin balance of the current API key ---------------- */
  function showBalance(coins, why) {
    const el = $('#rh-balance');
    if (!el) return;
    el.classList.remove('rh-balance--loading');
    if (coins == null) { el.textContent = '🪙 —'; el.title = `Balance unavailable — ${why || 'no coin balance in the reply'} · click to retry`; return; }
    const usd = usdFromCoins(coins);
    el.textContent = `🪙 ${Math.round(coins).toLocaleString()} RH Coins`;
    el.title = `RunningHub balance for your API key${usd ? ` (≈ ${usd})` : ''} — click to refresh`;
  }

  async function refreshBalance() {
    const el = $('#rh-balance');
    if (!el) return;
    const s = state.settings;
    el.hidden = !s.apiKey;
    $('#key-banner').hidden = !!s.apiKey;   // no key yet: the sidebar says so before Generate is ever pressed
    if (!s.apiKey) return;
    el.classList.add('rh-balance--loading');
    /* the hover title carries the reason (error or the reply's fields) so a missing balance can be diagnosed */
    try {
      const data = await RH.account(s.apiKey, s.base);
      showBalance(coinNum(data), 'reply had: ' + JSON.stringify(data));
    } catch (e) {
      showBalance(null, (e && e.message) || String(e));
    }
  }

  function wireBalance() {
    $('#rh-balance').addEventListener('click', refreshBalance);
    $('#key-banner').addEventListener('click', () => $('#btn-settings').click());
    refreshBalance();
  }

  /* ---------------- settings ---------------- */
  function wireSettingsDialog() {
    const dlg = $('#settings-dlg');
    /* RH API Key / LLM Provider / Advanced tabs — Save, Clear and contact stay below all of them */
    const tabs = [...dlg.querySelectorAll('.settings-tabs [data-tab]')];
    const selectTab = (name) => {
      for (const b of tabs) {
        b.classList.toggle('c-tab-heading--active', b.dataset.tab === name);
        b.setAttribute('aria-selected', String(b.dataset.tab === name));
      }
      for (const p of dlg.querySelectorAll('.settings-pane')) p.hidden = p.dataset.pane !== name;
    };
    for (const b of tabs) b.addEventListener('click', () => selectTab(b.dataset.tab));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });   // backdrop click = close
    const persist = () => {
      state.settings.apiKey = $('#set-key').value.trim();
      state.settings.sound = $('#set-sound').checked;
      state.settings.optimizer = state.settings.optimizer || { enabled: false, apiKey: '', readMedia: true };
      state.settings.optimizer.enabled = $('#set-opt').checked;
      state.settings.optimizer.provider = document.querySelector('input[name="opt-provider"]:checked')?.value || 'gemini';
      state.settings.optimizer.apiKey = $('#set-optkey').value.trim();
      state.settings.optimizer.model = $('#set-optmodel').value.trim();
      state.settings.optimizer.openaiBaseUrl = $('#set-oaibase').value.trim();
      state.settings.optimizer.openaiKey = $('#set-oaikey').value.trim();
      state.settings.optimizer.openaiModel = $('#set-oaimodel').value.trim();
      state.settings.optimizer.readMedia = $('#set-optmedia').checked;
      saveSettings();
    };
    const syncOptFields = () => { $('#opt-fields').style.display = $('#set-opt').checked ? '' : 'none'; };
    /* only the selected provider's credentials block shows */
    const syncProviderFields = () => {
      const openai = (document.querySelector('input[name="opt-provider"]:checked')?.value || 'gemini') === 'openai';
      $('#opt-gemini-fields').hidden = openai;
      $('#opt-openai-fields').hidden = !openai;
    };
    // autosave on every keystroke — settings survive restarts even without pressing Save
    $('#set-key').addEventListener('input', persist);
    $('#set-sound').addEventListener('change', persist);
    $('#set-opt').addEventListener('change', () => { persist(); syncOptFields(); });
    for (const r of document.querySelectorAll('input[name="opt-provider"]')) {
      r.addEventListener('change', () => { persist(); syncProviderFields(); });
    }
    $('#set-optkey').addEventListener('input', persist);
    $('#set-optmodel').addEventListener('input', persist);
    $('#set-oaibase').addEventListener('input', persist);
    $('#set-oaikey').addEventListener('input', persist);
    $('#set-oaimodel').addEventListener('input', persist);
    $('#set-optmedia').addEventListener('change', persist);
    $('#btn-settings').addEventListener('click', () => {
      const opt = state.settings.optimizer || { enabled: false, apiKey: '', readMedia: true };
      $('#set-key').value = state.settings.apiKey;
      $('#set-sound').checked = state.settings.sound !== false;
      $('#set-opt').checked = !!opt.enabled;
      const provider = opt.provider === 'openai' ? 'openai' : 'gemini';
      for (const r of document.querySelectorAll('input[name="opt-provider"]')) r.checked = r.value === provider;
      $('#set-optkey').value = opt.apiKey || '';
      $('#set-optmodel').value = opt.model || H3Optimizer.DEFAULT_MODEL;
      $('#set-oaibase').value = opt.openaiBaseUrl || '';
      $('#set-oaikey').value = opt.openaiKey || '';
      $('#set-oaimodel').value = opt.openaiModel || '';
      $('#set-optmedia').checked = !!opt.readMedia;
      syncOptFields();
      syncProviderFields();
      selectTab('rh');
      dlg.showModal();
    });
    $('#btn-close-settings').addEventListener('click', () => dlg.close());
    // the API key may have changed — refresh the header balance on close
    dlg.addEventListener('close', refreshBalance);
    $('#btn-reveal').addEventListener('click', () => {
      const inp = $('#set-key');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
    $('#btn-opt-reveal').addEventListener('click', () => {
      const inp = $('#set-optkey');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
    $('#btn-oai-reveal').addEventListener('click', () => {
      const inp = $('#set-oaikey');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
    $('#btn-test-rh').addEventListener('click', async () => {
      const out = $('#test-rh-result');
      const set = (cls, text) => { out.className = 'test-result ' + cls; out.textContent = text; };
      const key = $('#set-key').value.trim();
      if (!key) { set('test-bad', '✗ Failed — no RunningHub API key entered.'); return; }
      set('', 'Testing…');
      try {
        const coins = coinNum(await RH.account(key, state.settings.base));
        set('test-ok', `✓ API key works${coins != null ? ` · balance ${Math.round(coins).toLocaleString()} RH Coins` : ''}.`);
      } catch (e) {
        set('test-bad', `✗ Failed — ${(e && e.message) || e}`);
      }
    });
    $('#btn-test-gemini').addEventListener('click', async () => {
      const out = $('#test-gemini-result');
      const set = (cls, text) => { out.className = 'test-result ' + cls; out.textContent = text; };
      const key = $('#set-optkey').value.trim();
      const model = $('#set-optmodel').value.trim() || H3Optimizer.DEFAULT_MODEL;
      if (!key) { set('test-bad', '✗ Failed — no Gemini API key entered.'); return; }
      set('', 'Testing…');
      try {
        const reply = await H3Optimizer.ping({ provider: 'gemini', apiKey: key, model });
        set('test-ok', `✓ Gemini works — ${model} replied "${reply}".`);
      } catch (e) {
        set('test-bad', `✗ Failed — ${(e && e.message) || e}`);
      }
    });
    $('#btn-test-openai').addEventListener('click', async () => {
      const out = $('#test-openai-result');
      const set = (cls, text) => { out.className = 'test-result ' + cls; out.textContent = text; };
      const baseUrl = $('#set-oaibase').value.trim();
      const model = $('#set-oaimodel').value.trim();
      const key = $('#set-oaikey').value.trim();
      if (!baseUrl) { set('test-bad', '✗ Failed — no base URL entered.'); return; }
      if (!model) { set('test-bad', '✗ Failed — no model entered.'); return; }
      set('', 'Testing…');
      try {
        const reply = await H3Optimizer.ping({ provider: 'openai', baseUrl, apiKey: key, model });
        set('test-ok', `✓ ${model} works — replied "${reply}".`);
      } catch (e) {
        set('test-bad', `✗ Failed — ${(e && e.message) || e}`);
      }
    });

    $('#btn-clear-storage').addEventListener('click', async () => {
      if (!confirm('Delete everything this app saved in this browser?\n\n' +
        '• RunningHub API key\n' +
        '• LLM API keys and optimizer settings\n' +
        '• the local asset library (up to 100 files)\n' +
        '• the saved output history\n\n' +
        'This cannot be undone. The page will reload.')) return;
      try {
        localStorage.removeItem(KEY_STORE);
        localStorage.removeItem(OUT_STORE);
        localStorage.removeItem(FORM_STORE);
        localStorage.removeItem('wr.sidebarW');
        await assetClear();          // IndexedDB asset blobs
      } catch (e) { /* clear as much as we can, then reload anyway */ }
      location.reload();             // in-memory state is rebuilt from empty storage
    });

    $('#btn-save-settings').addEventListener('click', () => {
      persist();
      dlg.close();
      statusLine('Settings saved.', false);
    });
  }

  /* ---------------- bridge for js/actions.js (Upscale & future actions) ---------------- */
  window.FC = {
    h, showAlert, clearAlerts, statusLine,
    settings: state.settings,
    addOutputEntry, startTrackedRun,
    findEntry: (id) => state.outputsEntries.find((e) => e.id === id),
    /* an upscale is in flight for this source video? (one at a time per video) */
    isSourceBusy: (id) => [...state.runs.values()].some((r) => r.upscaled && r.upscaled.fromId === id && !r.finished),
  };

  /* ---------------- go ---------------- */
  boot();
})();
