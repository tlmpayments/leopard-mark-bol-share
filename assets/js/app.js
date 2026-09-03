// Standalone Bill of Lading maker, on the same Apps Script backend as
// inventory.tlmbg.co. Reads reference data (accounts/skus/locations/
// commodities) from it and fills in renderBolHtml() (from bol.js) to open a
// print-ready window. Document numbers here are self-generated (DR-/BOL-
// prefixed) and are NOT the same sequence the inventory app's real ledger
// uses, since this tool never writes an event to the ledger and no
// inventory ever moves from here. It does write one thing: every generated
// document is upserted into the backend's separate BOL Maker Log (see
// saveBolToLog() below) purely so it can be found and re-edited later —
// that log never touches the ledger either.

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

var DATA = { accounts: [], skus: [], locations: [], commodities: [] };

// Every apiGet caller can hit the same Apps Script sign-in bounce, so the
// wording lives in one place rather than being re-guessed at each call site.
function apiErrorText(err, whatFailed) {
  if (err && err.notJson) {
    return 'Google returned a sign-in page instead of data. Sign in as the account that owns this tool — or open this page in a private window — then reload.';
  }
  return whatFailed + ' (' + ((err && err.message) || 'unknown error') + '). Reload the page to try again.';
}

function apiGet(action, extraQuery) {
  var url = window.BOL_CONFIG.APPS_SCRIPT_URL + '?action=' + action + (extraQuery ? '&' + extraQuery : '');
  return fetch(url).then(function (r) {
    // The same guard apiPost has always had, which this function never got.
    // Apps Script answers with HTML rather than JSON in two situations that
    // are indistinguishable from here: an interstitial right after a fresh
    // deploy, and a bounce to the Google account chooser when the browser
    // carries cookies for more than one signed-in account. Unguarded,
    // r.json() throws a SyntaxError about an unexpected '<' -- which tells
    // whoever is looking at it precisely nothing. Flag it instead so the
    // caller can name the real cause.
    var ct = r.headers.get('content-type') || '';
    if (ct.indexOf('json') === -1) {
      var err = new Error('NOT_JSON');
      err.notJson = true;
      throw err;
    }
    return r.json();
  });
}

function apiPost(body) {
  // text/plain avoids a CORS preflight against the Apps Script web app,
  // which doesn't handle OPTIONS requests — same approach inventory.tlmbg.co
  // uses for its POST actions. Apps Script occasionally answers with an
  // HTML interstitial instead of JSON right after a fresh deploy; guard
  // against that so a failed save throws instead of choking on r.json().
  return fetch(window.BOL_CONFIG.APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  }).then(function (r) {
    var ct = r.headers.get('content-type') || '';
    if (ct.indexOf('json') === -1) throw new Error('Backend did not return JSON');
    return r.json();
  });
}

function todayIso() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function formatDateDisplay(iso) {
  if (!iso) return '';
  var p = iso.split('-');
  return p[1] + '/' + p[2] + '/' + p[0];
}

function randomDigits(n) {
  var s = '';
  for (var i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

function generateDocNumber(prefix) {
  var d = new Date();
  var yymmdd = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  return prefix + '-' + yymmdd + '-' + randomDigits(4);
}

function fillSelect(select, items, labelFn, placeholder) {
  select.innerHTML = '';
  var blank = document.createElement('option');
  blank.value = '';
  blank.textContent = placeholder || '— Select —';
  select.appendChild(blank);
  items.forEach(function (item, i) {
    var opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = labelFn(item);
    select.appendChild(opt);
  });
}

function skuLabel(s) {
  // Shows the prefixed, document-facing code (displaySku, in bol.js) so what
  // the dropdown says matches what prints, without the stored payload ever
  // carrying the prefix.
  return [s.Brand, s.Product, s.PackageType].filter(Boolean).join(' — ') +
    (s.SKU ? ' [' + displaySku(s.SKU) + ']' : '');
}

// Lot/Batch Code = Facility(2) + Brand(3) + YY + MM + DD + Run/Variation(1),
// per TLM's Inventory Lot # key (e.g. 01SGB2601301 = East Brother, SGB,
// packaged 1/30/26, run 1). Brand comes from the line's selected SKU, not a
// separate input, since it must always match.
var LOT_FACILITIES = [
  { code: '01', name: 'East Brother Beer' },
  { code: '02', name: 'Beachwood Brewing' },
  { code: '03', name: 'Prost Brewing Company' },
  { code: '04', name: 'Roundtable Brewing' },
  { code: '05', name: 'Ale Smith' },
  { code: '06', name: "Jack's Abby Brewing" },
  { code: '07', name: 'Real Ale Brewing' }
];

function computeLotCode(facilityCode, brand, pkgDateIso, run) {
  facilityCode = (facilityCode || '').trim().toUpperCase();
  if (facilityCode.length !== 2 || !brand || !pkgDateIso) return '';
  var p = pkgDateIso.split('-');
  var yy = p[0].slice(2);
  var mm = p[1];
  var dd = p[2];
  var runChar = String(run || '1').trim().slice(0, 1) || '1';
  return (facilityCode + String(brand).toUpperCase() + yy + mm + dd + runChar).toUpperCase();
}

// Tap handles (standard or premium, either brand) are merchandise, not a
// packaged/lot-tracked product — they never get a Lot #. Everything else
// (kegs, cases, glassware, ...) does. Matched on package type text so it
// applies to any tap handle variant without hardcoding SKU codes.
function skuRequiresLot(sku) {
  return !sku || !/tap handle/i.test(String(sku.PackageType || ''));
}

function selectedSku(tr) {
  var skuIdx = tr.querySelector('.dlv-line-sku').value;
  return skuIdx !== '' ? DATA.skus[Number(skuIdx)] : null;
}

function computeRowLot(tr) {
  var sku = selectedSku(tr);
  if (!skuRequiresLot(sku)) return '';
  var facilitySel = tr.querySelector('.dlv-line-facility');
  var customInput = tr.querySelector('.dlv-line-facility-custom');
  var facilityCode = facilitySel.value === '__other' ? customInput.value : facilitySel.value;
  var pkgDate = tr.querySelector('.dlv-line-pkgdate').value;
  var run = tr.querySelector('.dlv-line-run').value;
  return computeLotCode(facilityCode, sku ? sku.Brand : '', pkgDate, run);
}

function refreshLotPreview(tr) {
  var sku = selectedSku(tr);
  var needsLot = skuRequiresLot(sku);
  tr.querySelector('.lot-builder').style.display = needsLot ? '' : 'none';
  tr.querySelector('.lot-preview').style.display = needsLot ? '' : 'none';
  tr.querySelector('.lot-no-note').style.display = needsLot ? 'none' : '';
  var el = tr.querySelector('.dlv-line-lot-value');
  if (el) el.textContent = computeRowLot(tr) || '—';
}

// The live SKU Master's single "Tap Handle" entry per brand becomes two
// selectable variants here — Standard and Premium — since that split only
// matters for document generation, not real inventory tracking.
function expandTapHandleSkus(skus) {
  var expanded = [];
  skus.forEach(function (s) {
    if (String(s.PackageType || '').trim().toLowerCase() === 'tap handle') {
      ['Standard', 'Premium'].forEach(function (variant) {
        var copy = {};
        for (var k in s) copy[k] = s[k];
        copy.SKU = s.SKU + '-' + variant.toUpperCase();
        copy.PackageType = variant + ' Tap Handle';
        expanded.push(copy);
      });
    } else {
      expanded.push(s);
    }
  });
  return expanded;
}

// Accounts carry a free-text DeliveryWindowNote plus structured per-day
// windows (MondayWindow..FridayWindow) — real data has either, both, or
// neither, so combine whatever is present into one readable line rather
// than picking just one column. Consecutive days sharing the same window
// (common — e.g. Mon-Fri all "12pm - 5pm") collapse into one range instead
// of repeating five times.
var DELIVERY_DAY_DEFS = [
  ['Mon', 'MondayWindow'], ['Tue', 'TuesdayWindow'], ['Wed', 'WednesdayWindow'],
  ['Thu', 'ThursdayWindow'], ['Fri', 'FridayWindow']
];

function buildDeliveryWindowSummary(acct) {
  var parts = [];
  if (acct.DeliveryWindowNote) parts.push(acct.DeliveryWindowNote);

  var groups = [];
  DELIVERY_DAY_DEFS.forEach(function (d, i) {
    var val = acct[d[1]];
    if (!val) return;
    var last = groups[groups.length - 1];
    if (last && last.value === val && last.endIdx === i - 1) {
      last.endIdx = i;
    } else {
      groups.push({ value: val, startIdx: i, endIdx: i });
    }
  });
  var dayParts = groups.map(function (g) {
    var startLabel = DELIVERY_DAY_DEFS[g.startIdx][0];
    var endLabel = DELIVERY_DAY_DEFS[g.endIdx][0];
    var label = g.startIdx === g.endIdx ? startLabel : (startLabel + '–' + endLabel);
    return label + ' ' + g.value;
  });
  if (dayParts.length) parts.push(dayParts.join(', '));
  return parts.join(' — ');
}

var refDataLoaded = false;

function setFormsEnabled(enabled) {
  ['dlv-add-line', 'frt-add-line'].forEach(function (id) {
    document.getElementById(id).disabled = !enabled;
  });
  document.querySelectorAll('#form-delivery button[type="submit"], #form-freight button[type="submit"]').forEach(function (btn) {
    btn.disabled = !enabled;
  });
}

function loadReferenceData() {
  setFormsEnabled(false);
  document.getElementById('dlv-status').textContent = 'Loading accounts & SKUs…';
  document.getElementById('frt-status').textContent = 'Loading facilities, SKUs & commodities…';

  function apply(res) {
    DATA.accounts = res.accounts || [];
    DATA.skus = expandTapHandleSkus(res.skus || []);
    DATA.locations = res.locations || [];
    DATA.commodities = res.commodities || [];

    fillSelect(document.getElementById('dlv-account'), DATA.accounts, function (a) { return a.BusinessName; }, '— Select account —');
    fillSelect(document.getElementById('frt-from-loc'), DATA.locations, function (l) { return l.Name + (l.City ? ' (' + l.City + ', ' + l.State + ')' : ''); }, '— Select facility —');
    fillSelect(document.getElementById('frt-to-loc'), DATA.locations, function (l) { return l.Name + (l.City ? ' (' + l.City + ', ' + l.State + ')' : ''); }, '— Select facility —');
    fillSelect(document.getElementById('frt-commodity'), DATA.commodities, function (c) { return c.Name; }, '— Select commodity —');

    refDataLoaded = true;
    addDeliveryLineRow();
    addFreightLineRow();
    setFormsEnabled(true);
    renderBatchList();

    // A partial read still leaves the forms usable -- a delivery receipt can
    // be raised against a custom address with no account list -- so say
    // what's missing instead of blocking everything. But don't let an empty
    // dropdown pass for real data either.
    var partial = res.error ? res.error + ' — reload to try again.' : '';
    ['dlv-status', 'frt-status'].forEach(function (id) {
      var el = document.getElementById(id);
      el.textContent = partial;
      el.classList.toggle('error', !!partial);
    });
  }

  function fail(err) {
    console.error('Failed to load reference data', err);
    // Naming the actual cause matters. "Check your connection" sent people
    // to look at their wifi when the real problem was Google answering with
    // a sign-in page for a browser with several accounts logged in.
    var msg = apiErrorText(err, 'Could not load accounts/SKUs');
    ['dlv-status', 'frt-status'].forEach(function (id) {
      var el = document.getElementById(id);
      el.textContent = msg;
      el.classList.add('error');
    });
  }

  // One request, not four. Apps Script serializes executions per user, so
  // firing accounts/skus/locations/commodities in parallel never overlapped
  // -- they queued, and whichever lost the race routinely took ~9s.
  // Promise.all also rejects the moment any one of them fails, so a single
  // slow or bounced call used to take down the whole page.
  return apiGet('refData')
    .then(function (res) {
      if (res && res.accounts) return res;
      // Talking to a deployment that predates the refData action: fall back
      // to the four separate calls so the page still works while the backend
      // catches up.
      return Promise.all([
        apiGet('accounts'), apiGet('skus'), apiGet('locations'), apiGet('commodities')
      ]).then(function (r) {
        return {
          ok: true,
          accounts: (r[0] && r[0].accounts) || [],
          skus: (r[1] && r[1].skus) || [],
          locations: (r[2] && r[2].locations) || [],
          commodities: (r[3] && r[3].commodities) || []
        };
      });
    })
    .then(apply)
    .catch(fail);
}

// ---------------- Doc type toggle ----------------

document.querySelectorAll('.doc-toggle button').forEach(function (btn) {
  btn.addEventListener('click', function () { switchDocType(btn.dataset.doctype); });
});

// ---------------- Delivery Receipt line items ----------------

function addDeliveryLineRow() {
  var tbody = document.getElementById('dlv-lines');
  var tr = document.createElement('tr');
  var skuOptionsHtml = '<option value="">— SKU —</option>' + DATA.skus.map(function (s, i) {
    return '<option value="' + i + '">' + escapeHtml(skuLabel(s)) + '</option>';
  }).join('');
  var facilityOptionsHtml = LOT_FACILITIES.map(function (f) {
    return '<option value="' + f.code + '">' + f.code + ' ' + escapeHtml(f.name) + '</option>';
  }).join('') + '<option value="__other">Other…</option>';

  tr.innerHTML =
    '<td><select class="dlv-line-sku">' + skuOptionsHtml + '</select></td>' +
    '<td class="lot-cell">' +
    '  <div class="lot-builder">' +
    '    <select class="dlv-line-facility" title="Packaging facility">' + facilityOptionsHtml + '</select>' +
    '    <input type="text" class="dlv-line-facility-custom" placeholder="code" maxlength="2" style="display:none;" title="Custom 2-digit facility code" />' +
    '    <input type="date" class="dlv-line-pkgdate" title="Packaging date" />' +
    '    <input type="text" class="dlv-line-run" value="1" maxlength="1" title="Run # (or A/B/C for same-day variations)" />' +
    '  </div>' +
    '  <div class="lot-preview">Lot #: <span class="dlv-line-lot-value">—</span></div>' +
    '  <div class="lot-no-note hint" style="display:none;">No lot # required</div>' +
    '</td>' +
    '<td><input type="number" class="dlv-line-qty" min="0" value="1" /></td>' +
    '<td><button type="button" class="line-remove">&times;</button></td>';

  var facilitySelect = tr.querySelector('.dlv-line-facility');
  var customInput = tr.querySelector('.dlv-line-facility-custom');
  facilitySelect.addEventListener('change', function () {
    customInput.style.display = facilitySelect.value === '__other' ? '' : 'none';
    refreshLotPreview(tr);
  });
  ['.dlv-line-facility-custom', '.dlv-line-pkgdate', '.dlv-line-run', '.dlv-line-sku'].forEach(function (sel) {
    tr.querySelector(sel).addEventListener('input', function () { refreshLotPreview(tr); });
    tr.querySelector(sel).addEventListener('change', function () { refreshLotPreview(tr); });
  });
  tr.querySelector('.line-remove').addEventListener('click', function () { tr.remove(); });
  refreshLotPreview(tr);
  tbody.appendChild(tr);
}

function addFreightLineRow() {
  var tbody = document.getElementById('frt-lines');
  var tr = document.createElement('tr');
  var skuOptionsHtml = '<option value="">— SKU —</option>' + DATA.skus.map(function (s, i) {
    return '<option value="' + i + '">' + escapeHtml(skuLabel(s)) + '</option>';
  }).join('');
  tr.innerHTML =
    '<td><select class="frt-line-sku">' + skuOptionsHtml + '</select></td>' +
    '<td><input type="number" class="frt-line-qty" min="0" value="1" /></td>' +
    '<td><button type="button" class="line-remove">&times;</button></td>';
  tr.querySelector('.line-remove').addEventListener('click', function () { tr.remove(); });
  tbody.appendChild(tr);
}

document.getElementById('dlv-add-line').addEventListener('click', addDeliveryLineRow);
document.getElementById('frt-add-line').addEventListener('click', addFreightLineRow);

// ---------------- Account autofill ----------------

// Echoes the selected account's on-file details under the picker. The
// dropdown only ever showed BusinessName, and the address first appeared on
// the generated document -- so picking the wrong one of two similarly named
// accounts wasn't visible until after printing.
//
// Shows exactly the five fields the printed SHIP TO block uses (see
// partyBlock in bol.js): business name, legal name when it differs, delivery
// address, phone, license #. Anything the account is missing is called out
// rather than silently omitted, because a blank on screen and a blank on the
// document look the same until the driver is holding it.
function renderAccountPreview() {
  var el = document.getElementById('dlv-account-preview');
  var idx = document.getElementById('dlv-account').value;
  if (idx === '') {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  var a = DATA.accounts[Number(idx)] || {};
  var legal = (a.LegalName && a.LegalName !== a.BusinessName) ? a.LegalName : '';
  var meta = [];
  if (a.Phone) meta.push(escapeHtml(String(a.Phone)));
  meta.push(a.LicenseNumber
    ? 'License #' + escapeHtml(String(a.LicenseNumber))
    : '<span class="ap-missing">no license # on file</span>');

  el.innerHTML =
    '<div class="ap-name">' + escapeHtml(a.BusinessName || '—') + '</div>' +
    (legal ? '<div class="ap-legal">' + escapeHtml(legal) + '</div>' : '') +
    '<div class="ap-addr">' + (a.DeliveryAddress
      ? escapeHtml(a.DeliveryAddress)
      : '<span class="ap-missing">No delivery address on file — use + Custom Address</span>') + '</div>' +
    '<div class="ap-meta">' + meta.join(' · ') + '</div>';
  el.style.display = '';
}

document.getElementById('dlv-account').addEventListener('change', function () {
  var idx = this.value;
  var windowEl = document.getElementById('dlv-window');
  var instrEl = document.getElementById('dlv-instructions');
  renderAccountPreview();
  if (idx === '') {
    windowEl.value = '';
    instrEl.value = '';
    return;
  }
  var acct = DATA.accounts[Number(idx)];
  windowEl.value = buildDeliveryWindowSummary(acct);
  instrEl.value = acct.DeliveryInstructions || '';
});

// ---------------- Custom shipping address (one-off, not in Accounts) ----------------

function customAddressActive() {
  return document.getElementById('dlv-custom-acct-panel').style.display !== 'none';
}

function setCustomAddressMode(active) {
  document.getElementById('dlv-account-field').style.display = active ? 'none' : '';
  document.getElementById('dlv-custom-acct-panel').style.display = active ? '' : 'none';
}

document.getElementById('dlv-toggle-custom-acct').addEventListener('click', function () { setCustomAddressMode(true); });
document.getElementById('dlv-toggle-custom-acct-off').addEventListener('click', function () { setCustomAddressMode(false); });

function clearCustomAddressFields() {
  ['dlv-custom-name', 'dlv-custom-legalname', 'dlv-custom-address1', 'dlv-custom-address2',
    'dlv-custom-city', 'dlv-custom-state', 'dlv-custom-zip', 'dlv-custom-phone', 'dlv-custom-license'
  ].forEach(function (id) { document.getElementById(id).value = ''; });
}

function readCustomAddress() {
  var name = document.getElementById('dlv-custom-name').value.trim();
  if (!name) return { error: 'Enter a business name for the custom address.' };
  var line1 = document.getElementById('dlv-custom-address1').value.trim();
  var line2 = document.getElementById('dlv-custom-address2').value.trim();
  var city = document.getElementById('dlv-custom-city').value.trim();
  var state = document.getElementById('dlv-custom-state').value.trim();
  var zip = document.getElementById('dlv-custom-zip').value.trim();
  if (!line1 || !city || !state || !zip) return { error: 'Enter a complete delivery address (street, city, state, ZIP).' };
  var cityStateZip = [city, state].filter(Boolean).join(', ') + (zip ? ' ' + zip : '');
  return {
    acct: {
      BusinessName: name,
      LegalName: document.getElementById('dlv-custom-legalname').value.trim(),
      DeliveryAddress: [line1, line2, cityStateZip].filter(Boolean).join(', '),
      Phone: document.getElementById('dlv-custom-phone').value.trim(),
      LicenseNumber: document.getElementById('dlv-custom-license').value.trim()
    }
  };
}

// ---------------- Build & render ----------------

function readDeliveryLines() {
  return Array.prototype.slice.call(document.querySelectorAll('#dlv-lines tr')).map(function (tr) {
    var skuIdx = tr.querySelector('.dlv-line-sku').value;
    var sku = skuIdx !== '' ? DATA.skus[Number(skuIdx)] : null;
    if (!sku) return null;
    var facilitySel = tr.querySelector('.dlv-line-facility');
    var customInput = tr.querySelector('.dlv-line-facility-custom');
    return {
      sku: sku.SKU,
      lot: computeRowLot(tr),
      // Lot builder inputs, kept alongside the computed lot string purely so
      // re-opening this line for editing can restore them exactly rather
      // than trying to reverse-parse the concatenated lot code.
      lotFacility: facilitySel.value === '__other' ? customInput.value : facilitySel.value,
      lotPkgDate: tr.querySelector('.dlv-line-pkgdate').value,
      lotRun: tr.querySelector('.dlv-line-run').value,
      description: sku.Product,
      package: sku.PackageType,
      qty: Number(tr.querySelector('.dlv-line-qty').value) || 0,
      weightPerUnit: Number(sku.WeightPerUnit) || 0,
      isKeg: String(sku.IsKeg).toUpperCase() === 'TRUE'
    };
  }).filter(Boolean);
}

function readFreightLines() {
  return Array.prototype.slice.call(document.querySelectorAll('#frt-lines tr')).map(function (tr) {
    var skuIdx = tr.querySelector('.frt-line-sku').value;
    var sku = skuIdx !== '' ? DATA.skus[Number(skuIdx)] : null;
    if (!sku) return null;
    return {
      sku: sku.SKU,
      description: sku.Product,
      package: sku.PackageType,
      qty: Number(tr.querySelector('.frt-line-qty').value) || 0
    };
  }).filter(Boolean);
}

// Shared by the immediate "Generate & Print" submit and "Add to Batch" —
// returns { d } on success or { error } so both call sites show the same
// validation messages.
function buildDeliveryDoc() {
  var lines = readDeliveryLines();
  if (!lines.length) return { error: 'Add at least one product line.' };

  var acct;
  if (customAddressActive()) {
    var customResult = readCustomAddress();
    if (customResult.error) return { error: customResult.error };
    acct = customResult.acct;
  } else {
    var accIdx = document.getElementById('dlv-account').value;
    if (accIdx === '') return { error: 'Select a Ship To account, or use a custom address.' };
    acct = DATA.accounts[Number(accIdx)];
  }
  var dateIso = document.getElementById('dlv-date').value || todayIso();

  return {
    d: {
      docType: 'delivery',
      bolNumber: document.getElementById('dlv-bolnumber').value.trim() || generateDocNumber('DR'),
      invoiceNumber: document.getElementById('dlv-invoice').value.trim(),
      date: formatDateDisplay(dateIso),
      dateIso: dateIso,
      toAccount: acct,
      deliveryWindow: document.getElementById('dlv-window').value.trim(),
      receivingInstructions: document.getElementById('dlv-instructions').value.trim(),
      lines: lines,
      refNote: document.getElementById('dlv-refnote').value.trim(),
      notes: document.getElementById('dlv-notes').value.trim()
    }
  };
}

function buildFreightDoc() {
  var lines = readFreightLines();
  if (!lines.length) return { error: 'Add at least one commodity line.' };

  var fromIdx = document.getElementById('frt-from-loc').value;
  var toIdx = document.getElementById('frt-to-loc').value;
  var fromLoc = fromIdx !== '' ? DATA.locations[Number(fromIdx)] : null;
  var toLoc = toIdx !== '' ? DATA.locations[Number(toIdx)] : null;
  var fromName = document.getElementById('frt-from-name').value.trim();
  var fromAddress = document.getElementById('frt-from-address').value.trim();
  var toName = document.getElementById('frt-to-name').value.trim();
  var toAddress = document.getElementById('frt-to-address').value.trim();

  if (!fromLoc && !fromName) return { error: 'Select a Ship From facility or enter a manual name.' };
  if (!toLoc && !toName) return { error: 'Select a Ship To facility or enter a manual name.' };

  var commodityIdx = document.getElementById('frt-commodity').value;
  var commodity = commodityIdx !== '' ? DATA.commodities[Number(commodityIdx)] : null;

  var weight = document.getElementById('frt-weight').value;
  var huCount = document.getElementById('frt-hu-count').value;
  var dimsRaw = document.getElementById('frt-dimensions').value.trim();
  var freightClass = document.getElementById('frt-freight-class').value.trim();
  var freightClassEstimated = false;

  if (!freightClass && dimsRaw && huCount && weight) {
    var m = dimsRaw.match(/(\d+(\.\d+)?)\s*x\s*(\d+(\.\d+)?)\s*x\s*(\d+(\.\d+)?)/i);
    if (m) {
      var est = estimateFreightClass({ l: m[1], w: m[3], h: m[5] }, huCount, weight);
      if (est) { freightClass = String(est.freightClass); freightClassEstimated = true; }
    }
  }

  var dateIso = document.getElementById('frt-date').value || todayIso();

  return {
    d: {
      docType: 'freight',
      bolNumber: document.getElementById('frt-bolnumber').value.trim() || generateDocNumber('BOL'),
      date: formatDateDisplay(dateIso),
      dateIso: dateIso,
      eventType: document.getElementById('frt-eventtype').value,
      actor: document.getElementById('frt-actor').value.trim(),
      fromLoc: fromLoc,
      toLoc: toLoc,
      fromName: fromName,
      fromAddress: fromAddress,
      toName: toName,
      toAddress: toAddress,
      carrier: document.getElementById('frt-carrier').value.trim(),
      carrierPhone: document.getElementById('frt-carrier-phone').value.trim(),
      weight: weight,
      handlingUnitCount: huCount,
      handlingUnitType: document.getElementById('frt-hu-type').value.trim(),
      dimensions: dimsRaw,
      freightClass: freightClass,
      freightClassEstimated: freightClassEstimated,
      commodityName: commodity ? commodity.Name : '',
      nmfcNumber: commodity ? commodity.NMFCNumber : '',
      originAppointment: document.getElementById('frt-origin-appt').value.trim(),
      destinationAppointment: document.getElementById('frt-dest-appt').value.trim(),
      lines: lines,
      refNote: document.getElementById('frt-refnote').value.trim(),
      notes: document.getElementById('frt-notes').value.trim()
    }
  };
}

document.getElementById('form-delivery').addEventListener('submit', function (e) {
  e.preventDefault();
  var statusEl = document.getElementById('dlv-status');
  statusEl.textContent = '';
  statusEl.classList.remove('error');

  var result = buildDeliveryDoc();
  if (result.error) {
    statusEl.textContent = result.error;
    statusEl.classList.add('error');
    return;
  }
  saveBolToLog(result.d);
  openBolPrintWindow(result.d);
});

document.getElementById('form-freight').addEventListener('submit', function (e) {
  e.preventDefault();
  var statusEl = document.getElementById('frt-status');
  statusEl.textContent = '';
  statusEl.classList.remove('error');

  var result = buildFreightDoc();
  if (result.error) {
    statusEl.textContent = result.error;
    statusEl.classList.add('error');
    return;
  }
  saveBolToLog(result.d);
  openBolPrintWindow(result.d);
});

// ---------------- Batch ----------------

var BATCH_LIMIT = 100;
var batch = [];

function resetDeliveryForm() {
  setEditingState(null);
  document.getElementById('dlv-bolnumber').value = '';
  document.getElementById('dlv-bolnumber').placeholder = generateDocNumber('DR');
  document.getElementById('dlv-invoice').value = '';
  document.getElementById('dlv-account').value = '';
  renderAccountPreview();
  document.getElementById('dlv-window').value = '';
  document.getElementById('dlv-instructions').value = '';
  document.getElementById('dlv-refnote').value = '';
  document.getElementById('dlv-notes').value = '';
  document.getElementById('dlv-lines').innerHTML = '';
  clearCustomAddressFields();
  setCustomAddressMode(false);
  addDeliveryLineRow();
}

function resetFreightForm() {
  setEditingState(null);
  // "Prepared By" is kept — a batch of freight moves is usually entered by
  // the same person back-to-back, so re-typing a name each time is friction
  // with no real benefit.
  var preparedBy = document.getElementById('frt-actor').value;
  document.getElementById('frt-bolnumber').value = '';
  document.getElementById('frt-bolnumber').placeholder = generateDocNumber('BOL');
  document.getElementById('frt-actor').value = preparedBy;
  document.getElementById('frt-from-loc').value = '';
  document.getElementById('frt-from-name').value = '';
  document.getElementById('frt-from-address').value = '';
  document.getElementById('frt-to-loc').value = '';
  document.getElementById('frt-to-name').value = '';
  document.getElementById('frt-to-address').value = '';
  document.getElementById('frt-carrier').value = '';
  document.getElementById('frt-carrier-phone').value = '';
  document.getElementById('frt-weight').value = '';
  document.getElementById('frt-hu-count').value = '';
  document.getElementById('frt-hu-type').value = '';
  document.getElementById('frt-dimensions').value = '';
  document.getElementById('frt-freight-class').value = '';
  document.getElementById('frt-commodity').value = '';
  document.getElementById('frt-origin-appt').value = '';
  document.getElementById('frt-dest-appt').value = '';
  document.getElementById('frt-refnote').value = '';
  document.getElementById('frt-notes').value = '';
  document.getElementById('frt-lines').innerHTML = '';
  addFreightLineRow();
}

function summarizeBatchItem(d) {
  var lineCount = d.lines.length + ' item' + (d.lines.length === 1 ? '' : 's');
  if (d.docType === 'delivery') {
    var acctName = d.toAccount ? d.toAccount.BusinessName : '—';
    return 'Delivery Receipt — ' + d.bolNumber + ' — ' + acctName + ' (' + lineCount + ')';
  }
  var fromLabel = d.fromLoc ? d.fromLoc.Name : (d.fromName || '—');
  var toLabel = d.toLoc ? d.toLoc.Name : (d.toName || '—');
  return 'Freight BOL — ' + d.bolNumber + ' — ' + fromLabel + ' → ' + toLabel + ' (' + lineCount + ')';
}

function updateBatchButtons() {
  var atLimit = batch.length >= BATCH_LIMIT;
  var label = batch.length ? ('+ Add to Batch (' + batch.length + '/' + BATCH_LIMIT + ')') : '+ Add to Batch';
  ['dlv-add-batch', 'frt-add-batch'].forEach(function (id) {
    var btn = document.getElementById(id);
    btn.textContent = atLimit ? 'Batch full (100)' : label;
    btn.disabled = !refDataLoaded || atLimit;
  });
}

function renderBatchList() {
  var listEl = document.getElementById('batch-list');
  var emptyEl = document.getElementById('batch-empty');
  var actionsEl = document.getElementById('batch-actions');
  var countEl = document.getElementById('batch-count');

  if (!batch.length) {
    listEl.innerHTML = '';
    emptyEl.style.display = '';
    actionsEl.style.display = 'none';
    updateBatchButtons();
    return;
  }

  emptyEl.style.display = 'none';
  actionsEl.style.display = '';
  countEl.textContent = batch.length + ' / ' + BATCH_LIMIT + ' queued';

  listEl.innerHTML = batch.map(function (item, i) {
    return '<div class="batch-row"><span class="batch-row-label">' + (i + 1) + '. ' + escapeHtml(summarizeBatchItem(item)) + '</span>' +
      '<button type="button" class="line-remove" data-idx="' + i + '">&times;</button></div>';
  }).join('');

  Array.prototype.slice.call(listEl.querySelectorAll('[data-idx]')).forEach(function (btn) {
    btn.addEventListener('click', function () {
      batch.splice(Number(btn.dataset.idx), 1);
      renderBatchList();
    });
  });

  updateBatchButtons();
}

document.getElementById('dlv-add-batch').addEventListener('click', function () {
  var statusEl = document.getElementById('dlv-status');
  statusEl.textContent = '';
  statusEl.classList.remove('error');

  if (batch.length >= BATCH_LIMIT) {
    statusEl.textContent = 'Batch is full (100) — print or clear it before adding more.';
    statusEl.classList.add('error');
    return;
  }
  var result = buildDeliveryDoc();
  if (result.error) {
    statusEl.textContent = result.error;
    statusEl.classList.add('error');
    return;
  }
  batch.push(result.d);
  renderBatchList();
  resetDeliveryForm();
  statusEl.textContent = 'Added to batch (' + batch.length + '/' + BATCH_LIMIT + '). Form cleared for the next one.';
});

document.getElementById('frt-add-batch').addEventListener('click', function () {
  var statusEl = document.getElementById('frt-status');
  statusEl.textContent = '';
  statusEl.classList.remove('error');

  if (batch.length >= BATCH_LIMIT) {
    statusEl.textContent = 'Batch is full (100) — print or clear it before adding more.';
    statusEl.classList.add('error');
    return;
  }
  var result = buildFreightDoc();
  if (result.error) {
    statusEl.textContent = result.error;
    statusEl.classList.add('error');
    return;
  }
  batch.push(result.d);
  renderBatchList();
  resetFreightForm();
  statusEl.textContent = 'Added to batch (' + batch.length + '/' + BATCH_LIMIT + '). Form cleared for the next one.';
});

document.getElementById('batch-clear').addEventListener('click', function () {
  if (!batch.length) return;
  batch = [];
  renderBatchList();
});

document.getElementById('batch-print').addEventListener('click', function () {
  if (!batch.length) return;
  batch.forEach(saveBolToLog);
  openBatchPrintWindow(batch);
});

// PRINT_PAGE_STYLE / PRINT_TIP_HTML come from bol.js — reused as-is so a
// batch printout looks identical to a single one, just one doc per page.
function openBatchPrintWindow(items) {
  var pagesHtml = items.map(function (item, i) {
    var isLast = i === items.length - 1;
    var breakStyle = isLast ? '' : 'page-break-after: always; break-after: page;';
    return '<div class="print-page" style="' + breakStyle + '">' + renderBolHtml(item) + '</div>';
  }).join('');

  var html = '<!doctype html><html><head><meta charset="utf-8"><title>BOL Batch (' + items.length + ' documents)</title>' +
    '<base href="' + window.location.href + '">' +
    '<style>' + PRINT_PAGE_STYLE + '</style></head>' +
    '<body>' + PRINT_TIP_HTML + pagesHtml + '</body></html>';
  var w = window.open('', '_blank');
  w.document.open();
  w.document.write(html);
  w.document.close();
}

// ---------------- Previously Generated (log) ----------------
//
// Every document actually generated (single Generate & Print, or a batch
// Print Batch) gets upserted into the backend's BOL Maker Log, keyed by its
// own document #, via saveBolToLog(). This is fire-and-forget — a failed
// save never blocks printing, it just means that one document won't show
// up in the list later. Clicking an entry re-fetches its full saved payload
// and repopulates the matching form for editing; regenerating from there
// reuses the same document # so the log entry is updated in place rather
// than duplicated (see handleSaveBolLog on the backend).

function saveBolToLog(d) {
  apiPost({
    action: 'saveBolLog',
    entry: { docNumber: d.bolNumber, docType: d.docType, date: d.dateIso || '', summary: summarizeBatchItem(d), payload: d }
  }).catch(function (err) { console.error('Failed to save to Previously Generated log', err); });
}

var editingDocNumber = null;

function setEditingState(docNumber) {
  editingDocNumber = docNumber;
  var banner = document.getElementById('editing-banner');
  if (docNumber) {
    document.getElementById('editing-banner-docnum').textContent = docNumber;
    banner.style.display = '';
  } else {
    banner.style.display = 'none';
  }
}

document.getElementById('editing-banner-cancel').addEventListener('click', function () {
  var activeType = document.querySelector('.doc-toggle button.active').dataset.doctype;
  if (activeType === 'delivery') resetDeliveryForm(); else resetFreightForm();
});

function switchDocType(type) {
  document.querySelectorAll('.doc-toggle button').forEach(function (b) { b.classList.toggle('active', b.dataset.doctype === type); });
  document.getElementById('form-delivery').style.display = type === 'delivery' ? '' : 'none';
  document.getElementById('form-freight').style.display = type === 'freight' ? '' : 'none';
}

function findByField(list, field, value) {
  for (var i = 0; i < list.length; i++) if (list[i][field] === value) return i;
  return -1;
}

function findLocationIndex(loc) {
  if (!loc) return -1;
  for (var i = 0; i < DATA.locations.length; i++) {
    var l = DATA.locations[i];
    if (l.LocationID === loc.LocationID || (l.Name === loc.Name && l.City === loc.City)) return i;
  }
  return -1;
}

function populateDeliveryForm(d) {
  switchDocType('delivery');
  document.getElementById('dlv-bolnumber').value = d.bolNumber || '';
  document.getElementById('dlv-invoice').value = d.invoiceNumber || '';
  document.getElementById('dlv-date').value = d.dateIso || todayIso();

  var acctIdx = d.toAccount ? findByField(DATA.accounts, 'BusinessName', d.toAccount.BusinessName) : -1;
  if (acctIdx !== -1) {
    setCustomAddressMode(false);
    document.getElementById('dlv-account').value = String(acctIdx);
    // Assigning .value doesn't fire 'change', so the preview has to be
    // refreshed by hand here or a re-opened document shows a selected
    // account with no address under it.
    renderAccountPreview();
  } else {
    // Account no longer exists under that name (renamed/removed since this
    // document was made) — fall back to a custom address seeded with
    // whatever we saved, rather than silently pointing at the wrong account.
    setCustomAddressMode(true);
    clearCustomAddressFields();
    document.getElementById('dlv-custom-name').value = (d.toAccount && d.toAccount.BusinessName) || '';
    document.getElementById('dlv-custom-legalname').value = (d.toAccount && d.toAccount.LegalName) || '';
    document.getElementById('dlv-custom-address1').value = (d.toAccount && d.toAccount.DeliveryAddress) || '';
    document.getElementById('dlv-custom-phone').value = (d.toAccount && d.toAccount.Phone) || '';
    document.getElementById('dlv-custom-license').value = (d.toAccount && d.toAccount.LicenseNumber) || '';
  }
  // Set directly from the saved document rather than through the account
  // "change" autofill, which would overwrite these with the account's
  // current details instead of what was actually printed at the time.
  document.getElementById('dlv-window').value = d.deliveryWindow || '';
  document.getElementById('dlv-instructions').value = d.receivingInstructions || '';
  document.getElementById('dlv-refnote').value = d.refNote || '';
  document.getElementById('dlv-notes').value = d.notes || '';

  document.getElementById('dlv-lines').innerHTML = '';
  (d.lines || []).forEach(function (line) {
    addDeliveryLineRow();
    var tr = document.getElementById('dlv-lines').lastElementChild;
    var skuIdx = findByField(DATA.skus, 'SKU', line.sku);
    tr.querySelector('.dlv-line-sku').value = skuIdx !== -1 ? String(skuIdx) : '';
    var facilitySel = tr.querySelector('.dlv-line-facility');
    var customInput = tr.querySelector('.dlv-line-facility-custom');
    var knownFacility = Array.prototype.some.call(facilitySel.options, function (o) { return o.value === line.lotFacility; });
    if (line.lotFacility && !knownFacility) {
      facilitySel.value = '__other';
      customInput.style.display = '';
      customInput.value = line.lotFacility;
    } else if (line.lotFacility) {
      facilitySel.value = line.lotFacility;
    }
    tr.querySelector('.dlv-line-pkgdate').value = line.lotPkgDate || '';
    tr.querySelector('.dlv-line-run').value = line.lotRun || '1';
    tr.querySelector('.dlv-line-qty').value = line.qty;
    refreshLotPreview(tr);
  });
  if (!(d.lines || []).length) addDeliveryLineRow();
}

function populateFreightForm(d) {
  switchDocType('freight');
  document.getElementById('frt-bolnumber').value = d.bolNumber || '';
  document.getElementById('frt-date').value = d.dateIso || todayIso();
  document.getElementById('frt-eventtype').value = d.eventType || 'TRANSFER';
  document.getElementById('frt-actor').value = d.actor || '';

  var fromIdx = findLocationIndex(d.fromLoc);
  document.getElementById('frt-from-loc').value = fromIdx !== -1 ? String(fromIdx) : '';
  document.getElementById('frt-from-name').value = fromIdx === -1 ? (d.fromName || '') : '';
  document.getElementById('frt-from-address').value = fromIdx === -1 ? (d.fromAddress || '') : '';

  var toIdx = findLocationIndex(d.toLoc);
  document.getElementById('frt-to-loc').value = toIdx !== -1 ? String(toIdx) : '';
  document.getElementById('frt-to-name').value = toIdx === -1 ? (d.toName || '') : '';
  document.getElementById('frt-to-address').value = toIdx === -1 ? (d.toAddress || '') : '';

  document.getElementById('frt-carrier').value = d.carrier || '';
  document.getElementById('frt-carrier-phone').value = d.carrierPhone || '';
  document.getElementById('frt-weight').value = d.weight || '';
  document.getElementById('frt-hu-count').value = d.handlingUnitCount || '';
  document.getElementById('frt-hu-type').value = d.handlingUnitType || '';
  document.getElementById('frt-dimensions').value = d.dimensions || '';
  document.getElementById('frt-freight-class').value = d.freightClass || '';
  var commodityIdx = findByField(DATA.commodities, 'Name', d.commodityName);
  document.getElementById('frt-commodity').value = commodityIdx !== -1 ? String(commodityIdx) : '';
  document.getElementById('frt-origin-appt').value = d.originAppointment || '';
  document.getElementById('frt-dest-appt').value = d.destinationAppointment || '';
  document.getElementById('frt-refnote').value = d.refNote || '';
  document.getElementById('frt-notes').value = d.notes || '';

  document.getElementById('frt-lines').innerHTML = '';
  (d.lines || []).forEach(function (line) {
    addFreightLineRow();
    var tr = document.getElementById('frt-lines').lastElementChild;
    var skuIdx = findByField(DATA.skus, 'SKU', line.sku);
    tr.querySelector('.frt-line-sku').value = skuIdx !== -1 ? String(skuIdx) : '';
    tr.querySelector('.frt-line-qty').value = line.qty;
  });
  if (!(d.lines || []).length) addFreightLineRow();
}

var logEntries = [];

function formatTimestampDisplay(iso) {
  var d = iso ? new Date(iso) : null;
  return d && !isNaN(d.getTime()) ? d.toLocaleString() : (iso || '');
}

// The log's Date column started as a plain "YYYY-MM-DD" string, but Sheets
// silently auto-converts anything date-shaped into a real Date value, so it
// can come back as a full ISO timestamp instead. Slice off everything from
// "T" onward rather than re-parsing with `new Date()` — that avoids
// re-introducing a timezone shift on the calendar date itself (see the
// invoice editor's timezone bug for what re-parsing gets wrong).
function formatLogDate(v) {
  v = String(v || '');
  var isoPart = v.indexOf('T') !== -1 ? v.slice(0, v.indexOf('T')) : v;
  var p = isoPart.split('-');
  return p.length === 3 ? (p[1] + '/' + p[2] + '/' + p[0]) : v;
}

function openLogModal() {
  document.getElementById('log-modal').style.display = 'flex';
  document.getElementById('log-search').value = '';
  refreshLogList();
}

function closeLogModal() {
  document.getElementById('log-modal').style.display = 'none';
}

function refreshLogList() {
  var statusEl = document.getElementById('log-status');
  statusEl.textContent = 'Loading…';
  statusEl.classList.remove('error');
  statusEl.style.display = '';
  document.getElementById('log-list').innerHTML = '';
  apiGet('bolLog').then(function (res) {
    if (!res || !res.ok) throw new Error((res && res.error) || 'Unknown error');
    logEntries = res.entries || [];
    if (logEntries.length) {
      statusEl.style.display = 'none';
    } else {
      statusEl.textContent = 'No documents generated yet.';
    }
    renderLogList();
  }).catch(function (err) {
    console.error('Failed to load Previously Generated log', err);
    statusEl.textContent = apiErrorText(err, 'Could not load the document log');
    statusEl.classList.add('error');
  });
}

function renderLogList() {
  var listEl = document.getElementById('log-list');
  var q = document.getElementById('log-search').value.trim().toLowerCase();
  var filtered = !q ? logEntries : logEntries.filter(function (e) {
    return (String(e.Summary) + ' ' + String(e.DocNumber)).toLowerCase().indexOf(q) !== -1;
  });
  if (!logEntries.length) { listEl.innerHTML = ''; return; }
  if (!filtered.length) { listEl.innerHTML = '<div class="hint">No matching documents.</div>'; return; }

  listEl.innerHTML = filtered.map(function (e) {
    return '<div class="log-row" data-docnumber="' + escapeHtml(e.DocNumber) + '">' +
      '<div class="log-row-title">' + escapeHtml(e.Summary || e.DocNumber) + '</div>' +
      '<div class="log-row-meta">' + escapeHtml(formatLogDate(e.Date)) + ' &middot; Last updated ' + escapeHtml(formatTimestampDisplay(e.UpdatedAt)) + '</div>' +
      '</div>';
  }).join('');
  Array.prototype.slice.call(listEl.querySelectorAll('.log-row')).forEach(function (row) {
    row.addEventListener('click', function () { loadLogEntry(row.dataset.docnumber); });
  });
}

function loadLogEntry(docNumber) {
  var listEl = document.getElementById('log-list');
  listEl.style.opacity = '0.5';
  apiGet('bolLogGet', 'docNumber=' + encodeURIComponent(docNumber)).then(function (res) {
    listEl.style.opacity = '';
    if (!res || !res.ok) { alert('Could not load that document: ' + ((res && res.error) || 'unknown error')); return; }
    if (res.docType === 'freight') populateFreightForm(res.payload);
    else populateDeliveryForm(res.payload);
    setEditingState(res.docNumber);
    closeLogModal();
  }).catch(function (err) {
    listEl.style.opacity = '';
    console.error('Failed to load document', err);
    alert(apiErrorText(err, 'Could not load that document'));
  });
}

document.getElementById('open-log-btn').addEventListener('click', openLogModal);
document.getElementById('close-log-btn').addEventListener('click', closeLogModal);
document.getElementById('log-modal').addEventListener('click', function (e) {
  if (e.target.id === 'log-modal') closeLogModal();
});
document.getElementById('log-search').addEventListener('input', renderLogList);

// ---------------- Init ----------------

document.getElementById('dlv-date').value = todayIso();
document.getElementById('frt-date').value = todayIso();
document.getElementById('dlv-bolnumber').placeholder = generateDocNumber('DR');
document.getElementById('frt-bolnumber').placeholder = generateDocNumber('BOL');
setFormsEnabled(false);
renderBatchList();
loadReferenceData();
