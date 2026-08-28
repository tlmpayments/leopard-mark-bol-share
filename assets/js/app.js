// Standalone Bill of Lading maker. Read-only against the same Apps Script
// backend as inventory.tlmbg.co (accounts/skus/locations/commodities) — this
// tool never writes an event to the ledger. It just fills in renderBolHtml()
// (from bol.js, shared verbatim with the inventory app) and opens it in a
// print-ready window. Document numbers here are self-generated (DR-/BOL-
// prefixed) and are NOT the same sequence the inventory app's real ledger
// uses, since no ledger row is ever created from this page.

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

var DATA = { accounts: [], skus: [], locations: [], commodities: [] };

function apiGet(action) {
  var url = window.BOL_CONFIG.APPS_SCRIPT_URL + '?action=' + action;
  return fetch(url).then(function (r) { return r.json(); });
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
  return [s.Brand, s.Product, s.PackageType].filter(Boolean).join(' — ');
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

function computeRowLot(tr) {
  var facilitySel = tr.querySelector('.dlv-line-facility');
  var customInput = tr.querySelector('.dlv-line-facility-custom');
  var facilityCode = facilitySel.value === '__other' ? customInput.value : facilitySel.value;
  var pkgDate = tr.querySelector('.dlv-line-pkgdate').value;
  var run = tr.querySelector('.dlv-line-run').value;
  var skuIdx = tr.querySelector('.dlv-line-sku').value;
  var sku = skuIdx !== '' ? DATA.skus[Number(skuIdx)] : null;
  return computeLotCode(facilityCode, sku ? sku.Brand : '', pkgDate, run);
}

function refreshLotPreview(tr) {
  var el = tr.querySelector('.dlv-line-lot-value');
  if (el) el.textContent = computeRowLot(tr) || '—';
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

  return Promise.all([
    apiGet('accounts'), apiGet('skus'), apiGet('locations'), apiGet('commodities')
  ]).then(function (results) {
    DATA.accounts = (results[0] && results[0].accounts) || [];
    DATA.skus = (results[1] && results[1].skus) || [];
    DATA.locations = (results[2] && results[2].locations) || [];
    DATA.commodities = (results[3] && results[3].commodities) || [];

    fillSelect(document.getElementById('dlv-account'), DATA.accounts, function (a) { return a.BusinessName; }, '— Select account —');
    fillSelect(document.getElementById('frt-from-loc'), DATA.locations, function (l) { return l.Name + (l.City ? ' (' + l.City + ', ' + l.State + ')' : ''); }, '— Select facility —');
    fillSelect(document.getElementById('frt-to-loc'), DATA.locations, function (l) { return l.Name + (l.City ? ' (' + l.City + ', ' + l.State + ')' : ''); }, '— Select facility —');
    fillSelect(document.getElementById('frt-commodity'), DATA.commodities, function (c) { return c.Name; }, '— Select commodity —');

    refDataLoaded = true;
    addDeliveryLineRow();
    addFreightLineRow();
    setFormsEnabled(true);
    renderBatchList();
    document.getElementById('dlv-status').textContent = '';
    document.getElementById('frt-status').textContent = '';
  }).catch(function (err) {
    console.error('Failed to load reference data', err);
    var msg = 'Failed to load accounts/SKUs — check your connection and reload the page.';
    document.getElementById('dlv-status').textContent = msg;
    document.getElementById('dlv-status').classList.add('error');
    document.getElementById('frt-status').textContent = msg;
    document.getElementById('frt-status').classList.add('error');
  });
}

// ---------------- Doc type toggle ----------------

document.querySelectorAll('.doc-toggle button').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.doc-toggle button').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    var type = btn.dataset.doctype;
    document.getElementById('form-delivery').style.display = type === 'delivery' ? '' : 'none';
    document.getElementById('form-freight').style.display = type === 'freight' ? '' : 'none';
  });
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

document.getElementById('dlv-account').addEventListener('change', function () {
  var idx = this.value;
  var windowEl = document.getElementById('dlv-window');
  var instrEl = document.getElementById('dlv-instructions');
  if (idx === '') {
    windowEl.value = '';
    instrEl.value = '';
    return;
  }
  var acct = DATA.accounts[Number(idx)];
  windowEl.value = buildDeliveryWindowSummary(acct);
  instrEl.value = acct.DeliveryInstructions || '';
});

// ---------------- Build & render ----------------

function readDeliveryLines() {
  return Array.prototype.slice.call(document.querySelectorAll('#dlv-lines tr')).map(function (tr) {
    var skuIdx = tr.querySelector('.dlv-line-sku').value;
    var sku = skuIdx !== '' ? DATA.skus[Number(skuIdx)] : null;
    if (!sku) return null;
    return {
      sku: sku.SKU,
      lot: computeRowLot(tr),
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

  var accIdx = document.getElementById('dlv-account').value;
  if (accIdx === '') return { error: 'Select a Ship To account.' };
  var acct = DATA.accounts[Number(accIdx)];
  var dateIso = document.getElementById('dlv-date').value || todayIso();

  return {
    d: {
      docType: 'delivery',
      bolNumber: document.getElementById('dlv-bolnumber').value.trim() || generateDocNumber('DR'),
      invoiceNumber: document.getElementById('dlv-invoice').value.trim(),
      date: formatDateDisplay(dateIso),
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
  openBolPrintWindow(result.d);
});

// ---------------- Batch ----------------

var BATCH_LIMIT = 100;
var batch = [];

function resetDeliveryForm() {
  document.getElementById('dlv-bolnumber').value = '';
  document.getElementById('dlv-bolnumber').placeholder = generateDocNumber('DR');
  document.getElementById('dlv-invoice').value = '';
  document.getElementById('dlv-account').value = '';
  document.getElementById('dlv-window').value = '';
  document.getElementById('dlv-instructions').value = '';
  document.getElementById('dlv-refnote').value = '';
  document.getElementById('dlv-notes').value = '';
  document.getElementById('dlv-lines').innerHTML = '';
  addDeliveryLineRow();
}

function resetFreightForm() {
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

// ---------------- Init ----------------

document.getElementById('dlv-date').value = todayIso();
document.getElementById('frt-date').value = todayIso();
document.getElementById('dlv-bolnumber').placeholder = generateDocNumber('DR');
document.getElementById('frt-bolnumber').placeholder = generateDocNumber('BOL');
setFormsEnabled(false);
renderBatchList();
loadReferenceData();
