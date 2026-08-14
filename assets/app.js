/* ==========================================================================
   Bar Daily Report — reporting portal logic

   Calculation definitions are taken from the venue forecast workbooks so the
   portal and the forecast agree exactly:
     beverage revenue = total reportable - food - door - merchandise
     beverage wage %  = beverage wages / beverage revenue
     food wage %      = food wages     / food revenue
     total wage %     = (bev + food wages) / (bev + food revenue)   <- door and
                        merchandise revenue are deliberately excluded
     FOC %            = FOCs / total reportable revenue
   ========================================================================== */

(function () {
  'use strict';

  var CFG = window.PORTAL_CONFIG;

  /* ---------------------------------------------------------------- helpers */

  var $ = function (id) { return document.getElementById(id); };

  function num(el) {
    if (!el) return null;
    var raw = String(el.value == null ? '' : el.value).replace(/[$,\s]/g, '');
    if (raw === '') return null;
    var n = parseFloat(raw);
    return isFinite(n) ? n : null;
  }

  function n0(v) { return v == null ? 0 : v; }

  var AUD = new Intl.NumberFormat('en-AU', {
    style: 'currency', currency: 'AUD', minimumFractionDigits: 2, maximumFractionDigits: 2
  });

  function money(v) { return v == null ? '—' : AUD.format(v); }
  function pct(v, dp) { return v == null ? '—' : v.toFixed(dp == null ? 2 : dp) + '%'; }
  function signedPct(v) { return (v > 0 ? '+' : '') + v.toFixed(1) + '%'; }
  function signedPts(v) { return (v > 0 ? '+' : '') + v.toFixed(2) + 'pp'; }

  function fileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  var ICON = { good: '▲', warning: '●', critical: '▼' };
  var WORD = {
    revenue: { good: 'On/above forecast', warning: 'Slightly behind', critical: 'Behind forecast' },
    wage:    { good: 'On/under forecast', warning: 'Slightly over', critical: 'Over forecast' }
  };

  /* ------------------------------------------------------------- form model */

  /* Order matches the response sheet columns B..R / T..U so the backend can
     write the row without guessing. */
  var FIELDS = [
    'venue', 'reportDate', 'manager',
    'totalRevenue', 'foodRevenue', 'doorRevenue', 'merchRevenue',
    'cash', 'eftpos', 'variance', 'focs',
    'promotions', 'staffWorking',
    'bevStaffCost', 'foodStaffCost', 'gpPct',
    'description', 'incidents', 'irequest'
  ];

  var REQUIRED = [
    ['venue', 'Your Bar Name'],
    ['reportDate', "Today's date"],
    ['manager', 'Manager of duty'],
    ['totalRevenue', 'Total Reportable Revenue'],
    ['foodRevenue', 'Food Revenue'],
    ['bevStaffCost', 'Total BEVERAGE Staff Cost'],
    ['foodStaffCost', 'Total FOOD Staff Cost'],
    ['description', 'Description of the Night']
  ];

  /* Metrics compared against forecast. Revenue compares the EX-GST figure,
     because the forecast workbooks project ex GST while the form captures inc
     GST. Wage percentages need no adjustment: the same GST factor appears in
     numerator and denominator and cancels out. */
  var COMPARED = [
    { key: 'foodRevenueExGst', label: 'Food revenue',    kind: 'revenue', fc: 'foodProjRev' },
    { key: 'bevRevenueExGst',  label: 'Beverage revenue', kind: 'revenue', fc: 'bevProjRev' },
    { key: 'foodWagePct', label: 'Food wage %',     kind: 'wage',    fc: 'foodProjWagePct' },
    { key: 'bevWagePct',  label: 'Beverage wage %', kind: 'wage',    fc: 'bevProjWagePct' },
    { key: 'totalWagePct', label: 'Total wage %',   kind: 'wage',    fc: 'totalProjWagePct' }
  ];

  /* ------------------------------------------------------------------ state */

  var state = {
    accessToken: null,    // Google OAuth token, verified server-side
    user: null,           // { email, name }
    forecast: null,       // forecast row for the selected venue+date, or null
    forecastStatus: 'idle', // idle | loading | ready | none | error | unsupported
    metrics: {},
    flags: {},            // key -> 'good' | 'warning' | 'critical'
    uploads: { hlReports: [], additionalDocs: [], cashUp: [] },
    submitting: false
  };

  /* ------------------------------------------------------------- venue list */

  function initVenues() {
    var sel = $('venue');
    CFG.venues.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v.name;
      o.textContent = v.name;
      sel.appendChild(o);
    });
  }

  function venueHasForecast(name) {
    for (var i = 0; i < CFG.venues.length; i++) {
      if (CFG.venues[i].name === name) return CFG.venues[i].forecast;
    }
    return false;
  }

  /* --------------------------------------------------------- calculated set */

  function computeMetrics() {
    var total = num($('totalRevenue'));
    var food  = num($('foodRevenue'));
    var door  = num($('doorRevenue'));
    var merch = num($('merchRevenue'));
    var bevCost  = num($('bevStaffCost'));
    var foodCost = num($('foodStaffCost'));
    var focs = num($('focs'));

    var bevRevenue = (total == null) ? null : total - n0(food) - n0(door) - n0(merch);
    var tradingRev = (bevRevenue == null && food == null)
      ? null
      : n0(bevRevenue) + n0(food);

    function ratio(numer, denom) {
      if (numer == null || denom == null || denom <= 0) return null;
      return (numer / denom) * 100;
    }

    /* Strip GST for anything compared against forecast. FOCs are already
       recorded ex GST, so they are measured against ex-GST revenue. */
    var g = CFG.gst || {};
    var strip = g.actualsIncludeGst === false ? 1 : 1 / (1 + (g.rate || 0.10));
    var ex = function (v) { return v == null ? null : v * strip; };

    /* See gst.wagePctBasis in config.js — the two bases differ by the GST factor. */
    var wageDenom = g.wagePctBasis === 'ex-gst' ? ex : function (v) { return v; };

    var m = {
      total: total,
      totalExGst: ex(total),
      foodRevenue: food,
      foodRevenueExGst: ex(food),
      bevRevenue: bevRevenue,
      bevRevenueExGst: ex(bevRevenue),
      tradingRevenue: tradingRev,
      bevWagePct: ratio(bevCost, wageDenom(bevRevenue)),
      foodWagePct: ratio(foodCost, wageDenom(food)),
      totalWagePct: (bevCost == null && foodCost == null)
        ? null
        : ratio(n0(bevCost) + n0(foodCost), wageDenom(tradingRev)),
      focPct: ratio(focs, ex(total))
    };

    state.metrics = m;
    return m;
  }

  /* -------------------------------------------------------------- flag calc */

  function evaluateFlags() {
    var flags = {};
    var f = state.forecast;
    if (!f || state.forecastStatus !== 'ready') { state.flags = flags; return flags; }

    var m = state.metrics;
    var t = CFG.tolerances;

    COMPARED.forEach(function (c) {
      var actual = m[c.key];
      var proj = f[c.fc];

      /* A zero or blank projection is an unfilled forecast cell, not a target of
         zero. Comparing against it would flag a false red — and demand a comment
         for a night nobody forecast. */
      if (actual == null || proj == null || !isFinite(proj) || proj <= 0) return;

      /* Both bands are relative to forecast, matching the dashboard. */
      var d = ((actual - proj) / proj) * 100;

      if (c.kind === 'revenue') {
        flags[c.key] = d >= t.revenueGreenPct ? 'good'
          : (d >= t.revenueAmberPct ? 'warning' : 'critical');
      } else {
        flags[c.key] = d <= t.wageGreenPct ? 'good'
          : (d <= t.wageAmberPct ? 'warning' : 'critical');
      }
      flags[c.key + ':delta'] = d;
    });

    state.flags = flags;
    return flags;
  }

  /* ------------------------------------------------------------ panel paint */

  function paintTiles() {
    var m = state.metrics;

    setTile('tile-bevWage', pct(m.bevWagePct),
      m.bevRevenue == null ? '' : 'on ' + money(m.bevRevenue));
    setTile('tile-foodWage', pct(m.foodWagePct),
      m.foodRevenue == null ? '' : 'on ' + money(m.foodRevenue));
    setTile('tile-totalWage', pct(m.totalWagePct),
      m.tradingRevenue == null ? '' : 'on ' + money(m.tradingRevenue));
    setTile('tile-focPct', pct(m.focPct), '');

    var bevOut = $('bevRevenueOut');
    bevOut.textContent = m.bevRevenue == null
      ? '—'
      : money(m.bevRevenue) + '  (' + money(m.bevRevenueExGst) + ' ex GST)';
    var neg = m.bevRevenue != null && m.bevRevenue < 0;
    bevOut.classList.toggle('is-negative', neg);
    $('bevNegativeError').hidden = !neg;
  }

  function setTile(id, value, sub) {
    var el = $(id);
    el.querySelector('.tile-value').textContent = value;
    el.querySelector('.tile-sub').textContent = sub || '';
  }

  function paintForecast() {
    var wrap = $('forecastRows');
    var stateEl = $('forecastState');
    wrap.innerHTML = '';
    stateEl.className = 'fc-state';

    var venue = $('venue').value;
    var date = $('reportDate').value;

    if (!venue || !date) {
      stateEl.textContent = 'select venue & date';
      wrap.innerHTML = '<p class="fc-empty">Choose a bar and trading date to load the forecast for that day.</p>';
      return;
    }

    if (state.forecastStatus === 'unsupported') {
      stateEl.textContent = 'not forecast';
      stateEl.classList.add('missing');
      wrap.innerHTML = '<p class="fc-empty">No forecast workbook exists for ' +
        esc(venue) + ', so no flags are raised. All other calculations still apply.</p>';
      return;
    }
    if (state.forecastStatus === 'loading') {
      stateEl.textContent = 'loading…';
      stateEl.classList.add('loading');
      wrap.innerHTML = '<p class="fc-empty">Looking up the forecast…</p>';
      return;
    }
    if (state.forecastStatus === 'none') {
      stateEl.textContent = 'no row';
      stateEl.classList.add('missing');
      wrap.innerHTML = '<p class="fc-empty">The forecast workbook has no row for this date. Check with the forecaster before submitting.</p>';
      return;
    }
    if (state.forecastStatus === 'error') {
      stateEl.textContent = 'unavailable';
      stateEl.classList.add('missing');
      wrap.innerHTML = '<p class="fc-empty">Could not reach the forecast. You can still submit — flags will be blank.</p>';
      return;
    }
    if (state.forecastStatus !== 'ready') {
      stateEl.textContent = '';
      return;
    }

    stateEl.textContent = 'loaded';
    var f = state.forecast;
    var m = state.metrics;
    var any = false;

    COMPARED.forEach(function (c) {
      var flag = state.flags[c.key];
      var proj = f[c.fc];
      var actual = m[c.key];
      if (proj == null || !(proj > 0)) return;   /* unfilled forecast cell */
      any = true;

      var row = document.createElement('div');
      row.className = 'fc-row' + (flag ? ' ' + flag : '');

      var isRev = c.kind === 'revenue';
      var delta = state.flags[c.key + ':delta'];

      var badge = flag
        ? '<span class="fc-badge ' + flag + '">' + ICON[flag] + ' ' + WORD[c.kind][flag] + '</span>'
        : '<span class="fc-badge">awaiting input</span>';

      var nums = isRev
        ? '<b>' + money(actual) + '</b> ex GST vs ' + money(proj) +
          (delta == null ? '' : ' <span>(' + signedPct(delta) + ')</span>')
        : '<b>' + pct(actual) + '</b> vs ' + pct(proj) +
          ' <span>(' + signedPts(actual - proj) +
          (delta == null ? '' : ' · ' + signedPct(delta)) + ')</span>';

      row.innerHTML =
        '<div class="fc-row-top"><span class="fc-metric">' + c.label + '</span>' + badge + '</div>' +
        '<div class="fc-nums">' + nums + '</div>';

      wrap.appendChild(row);
    });

    if (!any) {
      wrap.innerHTML = '<p class="fc-empty">Forecast row found but it has no projected figures for this date.</p>';
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ------------------------------------------- variance commentary controls */

  function paintVarianceComments() {
    var card = $('varianceCard');
    var wrap = $('varianceComments');
    var reds = COMPARED.filter(function (c) { return state.flags[c.key] === 'critical'; });

    if (!reds.length) {
      card.hidden = true;
      wrap.innerHTML = '';
      return;
    }

    /* Preserve anything already typed across repaints, and pick up comments
       recovered from a saved draft the first time the blocks are built. */
    var existing = {};
    if (state.__restoredComments) {
      Object.keys(state.__restoredComments).forEach(function (k) {
        existing[k] = state.__restoredComments[k];
      });
    }
    Array.prototype.forEach.call(wrap.querySelectorAll('textarea'), function (t) {
      if (t.value) existing[t.dataset.metric] = t.value;
    });

    card.hidden = false;
    wrap.innerHTML = '';

    var f = state.forecast, m = state.metrics;

    reds.forEach(function (c) {
      var delta = state.flags[c.key + ':delta'];
      var isRev = c.kind === 'revenue';

      var detail = isRev
        ? c.label + ' came in at ' + money(m[c.key]) + ' ex GST against a forecast of ' +
          money(f[c.fc]) + ' — ' + signedPct(delta) + ' (' +
          money(m[c.key] - f[c.fc]) + ').'
        : c.label + ' came in at ' + pct(m[c.key]) + ' against a forecast of ' +
          pct(f[c.fc]) + ' — ' + signedPts(m[c.key] - f[c.fc]) + ' (' +
          signedPct(delta) + ') over.';

      var prompt = isRev
        ? 'Why is ' + c.label.toLowerCase() + ' behind forecast?'
        : 'Why is ' + c.label.toLowerCase() + ' over forecast?';

      var block = document.createElement('div');
      block.className = 'variance-block';
      block.innerHTML =
        '<div class="variance-head">' +
          '<span class="fc-badge critical">' + ICON.critical + '</span>' +
          '<span class="variance-title">' + prompt + '</span>' +
        '</div>' +
        '<p class="variance-detail">' + detail + '</p>' +
        '<textarea rows="3" data-metric="' + c.key + '" data-label="' + esc(c.label) +
          '" placeholder="Explain the driver and the corrective action…" required></textarea>';

      wrap.appendChild(block);

      var ta = block.querySelector('textarea');
      if (existing[c.key]) ta.value = existing[c.key];
      ta.addEventListener('input', function () {
        ta.classList.remove('invalid');
        saveDraft();
      });
    });
  }

  function collectVarianceComments() {
    var out = [];
    Array.prototype.forEach.call(
      $('varianceComments').querySelectorAll('textarea'),
      function (t) {
        out.push({
          metric: t.dataset.metric,
          label: t.dataset.label,
          flag: 'critical',
          comment: t.value.trim()
        });
      }
    );
    return out;
  }

  /* ---------------------------------------------------------------- refresh */

  function refresh() {
    computeMetrics();
    evaluateFlags();
    paintTiles();
    paintForecast();
    paintVarianceComments();

    var w = state.metrics.totalWagePct;
    $('wageCostPct').value = w == null ? '' : w.toFixed(2);

    /* Chrome renders <input type=date> in the browser's own locale, so an
       Australian manager can see mm/dd/yyyy. Echo the date unambiguously. */
    var iso = $('reportDate').value;
    var parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    $('dateEcho').textContent = parts
      ? new Date(+parts[1], +parts[2] - 1, +parts[3]).toLocaleDateString('en-AU', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
        })
      : '';

    $('panelVenue').textContent = $('venue').value
      ? $('venue').value + ($('reportDate').value ? ' · ' + $('reportDate').value : '')
      : 'No venue selected';
  }

  /* --------------------------------------------------------- forecast fetch */

  var fcToken = 0;

  function loadForecast() {
    var venue = $('venue').value;
    var date = $('reportDate').value;

    state.forecast = null;

    if (!venue || !date) { state.forecastStatus = 'idle'; refresh(); return; }

    if (!venueHasForecast(venue)) {
      state.forecastStatus = 'unsupported';
      refresh();
      return;
    }

    var my = ++fcToken;
    state.forecastStatus = 'loading';
    refresh();

    /* POST, not a GET with a query string: the ID token is a credential and
       must not travel in a URL. */
    postJSON({ action: 'forecast', venue: venue, date: date })
      .then(function (res) {
        if (my !== fcToken) return;
        if (res && res.ok && res.row) {
          state.forecast = res.row;
          state.forecastStatus = 'ready';
        } else {
          state.forecastStatus = (res && res.reason === 'no-row') ? 'none' : 'error';
        }
        refresh();
      })
      .catch(function () {
        if (my !== fcToken) return;
        state.forecastStatus = 'error';
        refresh();
      });
  }

  /* ---------------------------------------------------------------- uploads */

  function initUploads() {
    $('maxMb').textContent = CFG.maxUploadMB;

    Array.prototype.forEach.call(document.querySelectorAll('.upload'), function (input) {
      input.addEventListener('change', function () {
        var slot = input.dataset.slot;
        Array.prototype.forEach.call(input.files, function (file) {
          queueUpload(slot, file);
        });
        input.value = '';
      });
    });
  }

  function queueUpload(slot, file) {
    var maxBytes = CFG.maxUploadMB * 1024 * 1024;
    var entry = {
      name: file.name, size: file.size, status: 'pending', url: null, progress: 0
    };
    state.uploads[slot].push(entry);
    renderFileList(slot);

    if (file.size > maxBytes) {
      entry.status = 'failed';
      entry.error = 'over ' + CFG.maxUploadMB + 'MB';
      renderFileList(slot);
      return;
    }

    entry.status = 'uploading';
    renderFileList(slot);

    readAsBase64(file, function (pc) {
      entry.progress = pc * 0.4;
      renderFileList(slot);
    }).then(function (b64) {
      entry.progress = 0.5;
      renderFileList(slot);
      return postJSON({
        action: 'upload',
        venue: $('venue').value,
        date: $('reportDate').value,
        slot: slot,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        data: b64
      });
    }).then(function (res) {
      if (res && res.ok && res.url) {
        entry.status = 'done';
        entry.url = res.url;
        entry.progress = 1;
      } else {
        entry.status = 'failed';
        entry.error = (res && res.error) || 'upload failed';
      }
      renderFileList(slot);
    }).catch(function (err) {
      entry.status = 'failed';
      entry.error = err && err.message ? err.message : 'upload failed';
      renderFileList(slot);
    });
  }

  function readAsBase64(file, onProgress) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onprogress = function (e) {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      fr.onload = function () {
        var s = String(fr.result);
        var comma = s.indexOf(',');
        resolve(comma >= 0 ? s.slice(comma + 1) : s);
      };
      fr.onerror = function () { reject(new Error('could not read file')); };
      fr.readAsDataURL(file);
    });
  }

  function renderFileList(slot) {
    var ul = $(slot + '-list');
    ul.innerHTML = '';
    state.uploads[slot].forEach(function (e, i) {
      var li = document.createElement('li');
      var status = e.status === 'done' ? '✓ uploaded'
        : e.status === 'uploading' ? 'uploading'
        : e.status === 'failed' ? '✕ ' + (e.error || 'failed')
        : 'queued';

      li.innerHTML =
        '<span class="fname">' + esc(e.name) + '</span>' +
        '<span class="fsize">' + fileSize(e.size) + '</span>' +
        (e.status === 'uploading'
          ? '<span class="progress"><span style="width:' + Math.round(e.progress * 100) + '%"></span></span>'
          : '') +
        '<span class="fstatus ' + e.status + '">' + esc(status) + '</span>';
      ul.appendChild(li);
    });
  }

  function uploadsPending() {
    return ['hlReports', 'additionalDocs', 'cashUp'].some(function (slot) {
      return state.uploads[slot].some(function (e) {
        return e.status === 'uploading' || e.status === 'pending';
      });
    });
  }

  function uploadUrls(slot) {
    return state.uploads[slot]
      .filter(function (e) { return e.status === 'done' && e.url; })
      .map(function (e) { return e.url; });
  }

  /* ------------------------------------------------------- Google Sign-In */

  /**
   * The gate is a convenience, not the control: the ID token is verified by
   * Apps Script on every write, so removing this overlay in devtools achieves
   * nothing. Decoding here is display-only — never trust it for authorisation.
   */
  /** The page URL with no query or fragment — must match the registered URI. */
  function redirectUri() {
    return window.location.origin + window.location.pathname;
  }

  /**
   * Primary sign-in: a top-level redirect to Google and back. No popup and no
   * postMessage, so Cross-Origin-Opener-Policy cannot interfere — which it does
   * on GitHub Pages, where response headers cannot be set to relax it.
   */
  function beginRedirectSignIn() {
    var nonce = String(Math.random()).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem('portal.authState', nonce); } catch (e) { /* noop */ }

    var p = {
      client_id: CFG.auth.clientId,
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: 'openid email profile',
      state: nonce,
      prompt: 'select_account',
      hd: CFG.auth.allowedDomain || ''
    };
    var qs = Object.keys(p).filter(function (k) { return p[k]; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(p[k]); })
      .join('&');

    window.location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + qs;
  }

  /**
   * Handles the return leg. Returns 'pending' while the token is being checked,
   * 'error' if Google refused, or null when this is an ordinary page load.
   */
  function consumeAuthRedirect() {
    var hash = window.location.hash || '';
    if (hash.length < 2) return null;

    var params = {};
    hash.slice(1).split('&').forEach(function (pair) {
      var i = pair.indexOf('=');
      if (i > 0) params[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
    });

    /* Clear the fragment immediately so the token is not left in the address
       bar or in history. Fragments are never sent to a server. */
    var clean = function () {
      try { history.replaceState(null, '', redirectUri()); } catch (e) { window.location.hash = ''; }
    };

    if (params.error) {
      clean();
      $('authGate').hidden = false;
      document.querySelector('.shell').style.visibility = 'hidden';
      gateError('Google refused the sign-in: ' + params.error +
        (params.error_description ? ' — ' + params.error_description : ''));
      return 'error';
    }

    if (!params.access_token) return null;

    var expected;
    try { expected = sessionStorage.getItem('portal.authState'); } catch (e) { expected = null; }
    try { sessionStorage.removeItem('portal.authState'); } catch (e) { /* noop */ }

    clean();

    if (expected && params.state !== expected) {
      $('authGate').hidden = false;
      document.querySelector('.shell').style.visibility = 'hidden';
      gateError('Sign-in could not be verified (state mismatch). Please try again.');
      return 'error';
    }

    state.accessToken = params.access_token;
    $('authGate').hidden = false;
    document.querySelector('.shell').style.visibility = 'hidden';
    verifyWithBackend();
    return 'pending';
  }

  function initAuth() {
    var a = CFG.auth || {};
    if (!a.enabled) { showApp(); return; }

    if (!a.clientId || a.clientId.indexOf('PASTE_') === 0) {
      gateError('Sign-in is not configured yet — no OAuth client ID. See README.');
      return;
    }

    /* Returning from Google takes priority over rendering the gate. */
    if (consumeAuthRedirect()) return;

    $('authGate').hidden = false;
    document.querySelector('.shell').style.visibility = 'hidden';

    var primary = document.createElement('button');
    primary.type = 'button';
    primary.className = 'btn-primary gate-primary';
    primary.textContent = 'Sign in with Google';
    primary.addEventListener('click', beginRedirectSignIn);
    $('gsiButton').appendChild(primary);
  }

  /** Confirms the access token with the backend, which owns the domain check. */
  function verifyWithBackend() {
    var msg = $('gateMessage');
    msg.textContent = 'Checking your account…';
    msg.classList.remove('gate-error');

    postJSON({ action: 'whoami' })
      .then(function (res) {
        if (res && res.ok && res.email) {
          state.user = { email: res.email, name: res.name || '' };
          var who = $('whoami');
          who.hidden = false;
          who.textContent = res.email;
          var mgr = $('manager');
          if (!mgr.value.trim() && res.name) mgr.value = res.name;
          showApp();
        } else {
          state.accessToken = null;
          gateError((res && res.error) || 'That account cannot file reports.');
          showTroubleshooting();
        }
      })
      .catch(function (err) {
        state.accessToken = null;
        gateError('Could not reach the server to confirm sign-in: ' + err.message);
      });
  }

  function showApp() {
    $('authGate').hidden = true;
    document.querySelector('.shell').style.visibility = '';
  }

  function gateError(msg) {
    $('authGate').hidden = false;
    document.querySelector('.shell').style.visibility = 'hidden';
    var el = $('gateMessage');
    el.textContent = msg;
    el.classList.add('gate-error');
  }

  /* ------------------------------------------------------------------- POST */

  function postJSON(payload) {
    if (state.accessToken) payload.accessToken = state.accessToken;
    return fetch(CFG.endpoint, {
      method: 'POST',
      /* text/plain keeps this a "simple" request: no CORS preflight, which
         Apps Script cannot answer. */
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    }).then(function (r) { return r.json(); });
  }

  /* ------------------------------------------------------------------ draft */

  var draftTimer = null;
  var draftsDisabled = false;

  function saveDraft() {
    if (draftsDisabled) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      try {
        var d = {};
        FIELDS.forEach(function (k) { var el = $(k); if (el) d[k] = el.value; });
        d.__comments = {};
        Array.prototype.forEach.call(
          $('varianceComments').querySelectorAll('textarea'),
          function (t) { d.__comments[t.dataset.metric] = t.value; }
        );
        localStorage.setItem(CFG.draftKey, JSON.stringify(d));
        flash('Draft saved');
      } catch (e) { /* storage unavailable — not fatal */ }
    }, 600);
  }

  function restoreDraft() {
    var raw;
    try { raw = localStorage.getItem(CFG.draftKey); } catch (e) { return; }
    if (!raw) return;
    var d;
    try { d = JSON.parse(raw); } catch (e) { return; }

    FIELDS.forEach(function (k) {
      var el = $(k);
      if (el && d[k] != null && d[k] !== '') el.value = d[k];
    });
    state.__restoredComments = d.__comments || {};
    flash('Draft restored');
  }

  /* Stop the autosave debounce as well, or a queued save fires after this and
     resurrects the submitted report as a draft. */
  function clearDraft() {
    draftsDisabled = true;
    clearTimeout(draftTimer);
    try { localStorage.removeItem(CFG.draftKey); } catch (e) { /* noop */ }
  }

  var flashTimer = null;
  function flash(msg) {
    var el = $('saveState');
    el.textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.textContent = ''; }, 2200);
  }

  /* ------------------------------------------------------------- validation */

  function validate() {
    var errors = [];
    document.querySelectorAll('.invalid').forEach(function (el) {
      el.classList.remove('invalid');
    });

    REQUIRED.forEach(function (pair) {
      var el = $(pair[0]);
      if (!el.value.trim()) {
        errors.push(pair[1] + ' is required.');
        el.classList.add('invalid');
      }
    });

    if (state.metrics.bevRevenue != null && state.metrics.bevRevenue < 0) {
      errors.push('Beverage revenue calculates to a negative number — check the revenue split.');
      $('totalRevenue').classList.add('invalid');
    }

    var missingComments = [];
    Array.prototype.forEach.call(
      $('varianceComments').querySelectorAll('textarea'),
      function (t) {
        if (!t.value.trim()) {
          missingComments.push(t.dataset.label);
          t.classList.add('invalid');
        }
      }
    );
    if (missingComments.length) {
      errors.push('A comment is required for: ' + missingComments.join(', ') + '.');
    }

    if (uploadsPending()) {
      errors.push('Files are still uploading — wait for them to finish.');
    }

    if (CFG.auth && CFG.auth.enabled && !state.accessToken) {
      errors.push('You are not signed in. Reload and sign in with your work Google account.');
    }

    return errors;
  }

  function showErrors(errors) {
    var box = $('formErrors');
    if (!errors.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<strong>Cannot submit yet</strong><ul>' +
      errors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>';
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ----------------------------------------------------------------- submit */

  function submit(ev) {
    ev.preventDefault();
    if (state.submitting) return;

    refresh();
    var errors = validate();
    if (errors.length) { showErrors(errors); return; }
    showErrors([]);

    state.submitting = true;
    var btn = $('submitBtn');
    btn.classList.add('busy');
    btn.disabled = true;
    btn.querySelector('.btn-label').textContent = 'Submitting…';

    var m = state.metrics;
    var f = state.forecast;

    var payload = {
      action: 'submit',
      fields: {},
      computed: {
        bevRevenue: m.bevRevenue,
        bevRevenueExGst: m.bevRevenueExGst,
        foodRevenueExGst: m.foodRevenueExGst,
        totalExGst: m.totalExGst,
        tradingRevenue: m.tradingRevenue,
        bevWagePct: m.bevWagePct,
        foodWagePct: m.foodWagePct,
        totalWagePct: m.totalWagePct,
        focPct: m.focPct
      },
      forecast: f ? {
        bevProjRev: f.bevProjRev,
        foodProjRev: f.foodProjRev,
        bevProjWagePct: f.bevProjWagePct,
        foodProjWagePct: f.foodProjWagePct,
        totalProjWagePct: f.totalProjWagePct
      } : null,
      forecastStatus: state.forecastStatus,
      flags: COMPARED.reduce(function (acc, c) {
        if (state.flags[c.key]) {
          acc[c.key] = { flag: state.flags[c.key], delta: state.flags[c.key + ':delta'] };
        }
        return acc;
      }, {}),
      varianceComments: collectVarianceComments(),
      uploads: {
        hlReports: uploadUrls('hlReports'),
        additionalDocs: uploadUrls('additionalDocs'),
        cashUp: uploadUrls('cashUp')
      },
      clientSubmittedAt: new Date().toISOString()
    };

    FIELDS.forEach(function (k) { var el = $(k); if (el) payload.fields[k] = el.value; });

    postJSON(payload)
      .then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || 'The server rejected the submission.');
        clearDraft();
        $('reportForm').hidden = true;
        $('successPane').hidden = false;
        $('successDetail').textContent =
          payload.fields.venue + ' · ' + payload.fields.reportDate +
          ' was written to the response sheet' +
          (res.row ? ' (row ' + res.row + ')' : '') + '.';
        window.scrollTo({ top: 0, behavior: 'smooth' });
      })
      .catch(function (err) {
        showErrors([err.message || 'Submission failed. Check your connection and try again — your draft is saved.']);
      })
      .finally(function () {
        state.submitting = false;
        btn.classList.remove('busy');
        btn.disabled = false;
        btn.querySelector('.btn-label').textContent = 'Submit daily report';
      });
  }

  /* ------------------------------------------------------------------- init */

  function initTheme() {
    var saved;
    try { saved = localStorage.getItem('barDailyReport.theme'); } catch (e) { /* noop */ }
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    else document.documentElement.removeAttribute('data-theme');

    $('themeToggle').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('barDailyReport.theme', next); } catch (e) { /* noop */ }
    });
  }

  function init() {
    if (!CFG || !CFG.endpoint || CFG.endpoint.indexOf('PASTE_') === 0) {
      console.warn('[portal] endpoint not configured — see assets/config.js');
    }

    initTheme();
    initAuth();
    initVenues();
    initUploads();

    /* default the trading date to yesterday: the report is written up after
       the night has closed. */
    var d = new Date();
    d.setDate(d.getDate() - 1);
    $('reportDate').value = d.toISOString().slice(0, 10);

    restoreDraft();

    document.querySelectorAll('input, select, textarea').forEach(function (el) {
      var ev = (el.tagName === 'SELECT' || el.type === 'date') ? 'change' : 'input';
      el.addEventListener(ev, function () {
        if (el.classList.contains('calc') || el.id === 'focs') refresh();
        el.classList.remove('invalid');
        saveDraft();
      });
    });

    $('venue').addEventListener('change', loadForecast);
    $('reportDate').addEventListener('change', loadForecast);

    $('description').addEventListener('input', function () {
      $('descCount').textContent = $('description').value.length;
    });
    $('descCount').textContent = $('description').value.length;

    /* Raise the incident-register reminder once something has been logged. */
    function syncIncidentNotice() {
      $('incidentNotice').classList.toggle('is-live', $('incidents').value.trim().length > 0);
    }
    $('incidents').addEventListener('input', syncIncidentNotice);
    syncIncidentNotice();

    $('reportForm').addEventListener('submit', submit);

    $('newReportBtn').addEventListener('click', function () {
      window.location.reload();
    });

    refresh();
    loadForecast();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
