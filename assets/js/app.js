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

function loadReferenceData() {
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
  }).catch(function (err) {
    console.error('Failed to load reference data', err);
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
  tr.innerHTML =
    '<td><select class="dlv-line-sku">' + skuOptionsHtml + '</select></td>' +
    '<td><input type="text" class="dlv-line-lot" /></td>' +
    '<td><input type="number" class="dlv-line-qty" min="0" value="1" /></td>' +
    '<td><button type="button" class="line-remove">&times;</button></td>';
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

// ---------------- Build & render ----------------

function readDeliveryLines() {
  return Array.prototype.slice.call(document.querySelectorAll('#dlv-lines tr')).map(function (tr) {
    var skuIdx = tr.querySelector('.dlv-line-sku').value;
    var sku = skuIdx !== '' ? DATA.skus[Number(skuIdx)] : null;
    if (!sku) return null;
    return {
      sku: sku.SKU,
      lot: tr.querySelector('.dlv-line-lot').value.trim(),
      description: [sku.Brand, sku.Product].filter(Boolean).join(' '),
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
      description: [sku.Brand, sku.Product].filter(Boolean).join(' '),
      package: sku.PackageType,
      qty: Number(tr.querySelector('.frt-line-qty').value) || 0
    };
  }).filter(Boolean);
}

document.getElementById('form-delivery').addEventListener('submit', function (e) {
  e.preventDefault();
  var statusEl = document.getElementById('dlv-status');
  statusEl.textContent = '';
  statusEl.classList.remove('error');

  var lines = readDeliveryLines();
  if (!lines.length) {
    statusEl.textContent = 'Add at least one product line.';
    statusEl.classList.add('error');
    return;
  }
  var accIdx = document.getElementById('dlv-account').value;
  if (accIdx === '') {
    statusEl.textContent = 'Select a Ship To account.';
    statusEl.classList.add('error');
    return;
  }
  var acct = DATA.accounts[Number(accIdx)];
  var dateIso = document.getElementById('dlv-date').value || todayIso();

  var d = {
    docType: 'delivery',
    bolNumber: document.getElementById('dlv-bolnumber').value.trim() || generateDocNumber('DR'),
    invoiceNumber: document.getElementById('dlv-invoice').value.trim(),
    date: formatDateDisplay(dateIso),
    toAccount: acct,
    deliveryWindow: document.getElementById('dlv-window').value.trim() || acct.DeliveryWindowNote,
    receivingInstructions: document.getElementById('dlv-instructions').value.trim() || acct.DeliveryInstructions,
    lines: lines,
    refNote: document.getElementById('dlv-refnote').value.trim(),
    notes: document.getElementById('dlv-notes').value.trim()
  };

  openBolPrintWindow(d);
});

document.getElementById('form-freight').addEventListener('submit', function (e) {
  e.preventDefault();
  var statusEl = document.getElementById('frt-status');
  statusEl.textContent = '';
  statusEl.classList.remove('error');

  var lines = readFreightLines();
  if (!lines.length) {
    statusEl.textContent = 'Add at least one commodity line.';
    statusEl.classList.add('error');
    return;
  }

  var fromIdx = document.getElementById('frt-from-loc').value;
  var toIdx = document.getElementById('frt-to-loc').value;
  var fromLoc = fromIdx !== '' ? DATA.locations[Number(fromIdx)] : null;
  var toLoc = toIdx !== '' ? DATA.locations[Number(toIdx)] : null;
  var fromName = document.getElementById('frt-from-name').value.trim();
  var fromAddress = document.getElementById('frt-from-address').value.trim();
  var toName = document.getElementById('frt-to-name').value.trim();
  var toAddress = document.getElementById('frt-to-address').value.trim();

  if (!fromLoc && !fromName) {
    statusEl.textContent = 'Select a Ship From facility or enter a manual name.';
    statusEl.classList.add('error');
    return;
  }
  if (!toLoc && !toName) {
    statusEl.textContent = 'Select a Ship To facility or enter a manual name.';
    statusEl.classList.add('error');
    return;
  }

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

  var d = {
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
  };

  openBolPrintWindow(d);
});

// ---------------- Init ----------------

document.getElementById('dlv-date').value = todayIso();
document.getElementById('frt-date').value = todayIso();
document.getElementById('dlv-bolnumber').placeholder = generateDocNumber('DR');
document.getElementById('frt-bolnumber').placeholder = generateDocNumber('BOL');
addDeliveryLineRow();
addFreightLineRow();
loadReferenceData();
