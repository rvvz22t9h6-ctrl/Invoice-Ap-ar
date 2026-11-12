'use strict';

(() => {
  // -------------------------------------------------------------------------
  // State & utilities
  // -------------------------------------------------------------------------
  const state = {
    user: null,
    settings: { company_name: '', currency: 'USD' },
    invoices: [],
    today: '',
    list: { AR: { filter: 'outstanding', q: '', sort: 'due_date', dir: 1 }, AP: { filter: 'outstanding', q: '', sort: 'due_date', dir: 1 } },
  };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const main = $('#main');
  let refreshTimer = null;

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const canEdit = () => state.user && (state.user.role === 'admin' || state.user.role === 'editor');
  const isAdmin = () => state.user && state.user.role === 'admin';
  const LABEL = { AR: 'Receivables', AP: 'Payables' };
  const PARTY = { AR: 'Customer', AP: 'Supplier' };
  const ROLE_LABEL = { admin: 'Admin', editor: 'Editor', viewer: 'Viewer (read-only)' };

  let moneyFmt;
  function setCurrency(code) {
    try {
      moneyFmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: code || 'USD' });
    } catch {
      moneyFmt = { format: (n) => `${code} ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` };
    }
  }
  setCurrency('USD');
  const money = (n) => moneyFmt.format(n || 0);

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
    const sameYear = state.today && iso.slice(0, 4) === state.today.slice(0, 4);
    return d.toLocaleDateString(undefined, sameYear ? { day: '2-digit', month: 'short' } : { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function fmtDateTime(sqlUtc) {
    if (!sqlUtc) return '—';
    const d = new Date(`${sqlUtc.replace(' ', 'T')}Z`);
    return d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function relDue(inv) {
    if (inv.status === 'Paid' || inv.status === 'Void') return '';
    if (inv.days_overdue > 0) return `${inv.days_overdue} day${inv.days_overdue === 1 ? '' : 's'} overdue`;
    const days = Math.round((Date.parse(`${inv.due_date}T00:00:00Z`) - Date.parse(`${state.today}T00:00:00Z`)) / 86400000);
    if (days === 0) return 'Due today';
    return `Due in ${days} day${days === 1 ? '' : 's'}`;
  }
  const pill = (status) => `<span class="pill ${esc(status.split(' ')[0])}">${esc(status)}</span>`;

  async function api(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== '/api/login') {
      showLogin();
      throw new Error(data.error || 'Please sign in');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast${isError ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 5000 : 2500);
  }

  // -------------------------------------------------------------------------
  // Modal
  // -------------------------------------------------------------------------
  const modal = $('#modal');
  function openModal(title, html, wide = false) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = html;
    $('.modal-card', modal).style.maxWidth = wide ? '820px' : '';
    modal.classList.remove('hidden');
    const first = $('input:not([type=hidden]), select, textarea', $('#modal-body'));
    if (first) first.focus();
    return $('#modal-body');
  }
  function closeModal() { modal.classList.add('hidden'); $('#modal-body').innerHTML = ''; }
  modal.addEventListener('click', (e) => { if (e.target === modal || e.target.closest('[data-close]')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal(); });

  function formData(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    }
    return out;
  }

  function bindForm(form, onSubmit) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', form);
      const btn = $('button[type=submit]', form);
      if (err) err.textContent = '';
      if (btn) btn.disabled = true;
      try {
        await onSubmit(formData(form));
      } catch (ex) {
        if (err) err.textContent = ex.message; else toast(ex.message, true);
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
  function showLogin() {
    state.user = null;
    clearInterval(refreshTimer);
    closeModal();
    $('#app-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
    $('#login-form [name=username]').focus();
  }

  async function startApp() {
    const me = await api('GET', '/api/me');
    state.user = me.user;
    state.settings = me.settings;
    setCurrency(me.settings.currency);
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    $('#whoami').textContent = `${me.user.name} · ${ROLE_LABEL[me.user.role].split(' ')[0]}`;
    $('#company-name').textContent = me.settings.company_name || 'Invoice Tracker';
    document.title = me.settings.company_name ? `${me.settings.company_name} · Invoice Tracker` : 'Invoice Tracker';
    $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin()));
    clearInterval(refreshTimer);
    // Keep the page fresh for anyone who leaves it open (e.g. on a wall screen or phone).
    refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && modal.classList.contains('hidden')) render();
    }, 5 * 60 * 1000);
    render();
  }

  bindForm($('#login-form'), async (data) => {
    $('#login-error').textContent = '';
    try {
      await api('POST', '/api/login', data);
      $('#login-form').reset();
      await startApp();
    } catch (e) {
      $('#login-error').textContent = e.message;
    }
  });

  $('#logout').addEventListener('click', async () => {
    await api('POST', '/api/logout').catch(() => {});
    showLogin();
  });

  // -------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------
  const currentView = () => (location.hash || '#dashboard').slice(1);
  window.addEventListener('hashchange', () => state.user && render());

  async function render() {
    let view = currentView();
    if (view === 'users' && !isAdmin()) view = 'dashboard';
    $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
    try {
      if (view === 'AR' || view === 'AP') await renderList(view);
      else if (view === 'users') await renderUsers();
      else if (view === 'account') renderAccount();
      else await renderDashboard();
    } catch (e) {
      if (state.user) main.innerHTML = `<div class="card empty">Could not load: ${esc(e.message)}</div>`;
    }
  }

  // -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------
  function miniTable(rows, emptyText, mode) {
    if (!rows.length) return `<div class="empty">${esc(emptyText)}</div>`;
    return `<div class="table-wrap"><table><thead><tr>
      <th></th><th>Customer / Supplier</th><th class="hide-sm">Invoice</th>
      <th>${mode === 'overdue' ? 'Overdue' : 'Due'}</th><th class="num">Balance</th></tr></thead><tbody>
      ${rows.map((i) => `<tr class="clickable" data-id="${i.id}">
        <td><span class="tag ${i.type}">${i.type}</span></td>
        <td class="party">${esc(i.party)}</td>
        <td class="hide-sm">${esc(i.invoice_no)}</td>
        <td>${mode === 'overdue' ? `${i.days_overdue} d` : fmtDate(i.due_date)}</td>
        <td class="num">${money(i.balance)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  function agingCard(type, s) {
    const buckets = [
      ['Current', s.aging.current, false], ['1–30 days', s.aging.d1_30, true], ['31–60 days', s.aging.d31_60, true],
      ['61–90 days', s.aging.d61_90, true], ['90+ days', s.aging.d90_plus, true],
    ];
    const max = Math.max(...buckets.map((b) => b[1]), 1);
    return `<div class="card">
      <div class="card-head"><h3>${LABEL[type]} aging</h3><a href="#${type}" class="small-text">View all →</a></div>
      <div class="aging">${buckets.map(([label, v, late]) => `
        <div class="aging-row"><span class="muted">${label}</span>
          <div class="bar ${late && v > 0 ? 'late' : type.toLowerCase()}"><span data-w="${(v / max) * 100}"></span></div>
          <span class="num">${money(v)}</span></div>`).join('')}
      </div></div>`;
  }

  async function renderDashboard() {
    const s = await api('GET', '/api/summary');
    state.today = s.today;
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Dashboard</h1><div class="muted">Status as of ${fmtDate(s.today)}</div></div>
        <div class="actions">
          <button class="btn" id="refresh">↻ Refresh</button>
          <a class="btn" href="/api/export.csv">Export all (CSV)</a>
        </div>
      </div>
      <div class="grid kpis">
        <div class="card kpi ar"><div class="label">Receivables outstanding</div><div class="value">${money(s.AR.outstanding)}</div>
          <div class="sub">${s.AR.open_count} unpaid invoice${s.AR.open_count === 1 ? '' : 's'} · ${money(s.AR.due_7_days)} due in 7 days</div></div>
        <div class="card kpi danger"><div class="label">Receivables overdue</div><div class="value">${money(s.AR.overdue)}</div>
          <div class="sub">${s.AR.overdue_count} invoice${s.AR.overdue_count === 1 ? '' : 's'} past due</div></div>
        <div class="card kpi ap"><div class="label">Payables outstanding</div><div class="value">${money(s.AP.outstanding)}</div>
          <div class="sub">${s.AP.open_count} unpaid bill${s.AP.open_count === 1 ? '' : 's'} · ${money(s.AP.due_7_days)} due in 7 days</div></div>
        <div class="card kpi danger"><div class="label">Payables overdue</div><div class="value">${money(s.AP.overdue)}</div>
          <div class="sub">${s.AP.overdue_count} bill${s.AP.overdue_count === 1 ? '' : 's'} past due</div></div>
      </div>
      <div class="grid kpis">
        <div class="card kpi net"><div class="label">Net position (AR − AP)</div><div class="value">${money(s.net_position)}</div>
          <div class="sub">Owed to us minus what we owe</div></div>
        <div class="card kpi ar"><div class="label">Collected this month</div><div class="value">${money(s.AR.paid_this_month)}</div>
          <div class="sub">Customer payments received</div></div>
        <div class="card kpi ap"><div class="label">Paid out this month</div><div class="value">${money(s.AP.paid_this_month)}</div>
          <div class="sub">Supplier payments made</div></div>
        <div class="card kpi"><div class="label">Due in next 7 days</div><div class="value">${s.due_soon.length}</div>
          <div class="sub">${s.AR.due_7_count} to collect · ${s.AP.due_7_count} to pay</div></div>
      </div>
      <div class="grid two-col">${agingCard('AR', s.AR)}${agingCard('AP', s.AP)}</div>
      <div class="grid two-col">
        <div class="card"><div class="card-head"><h3>Most overdue</h3><span class="muted small-text">Top 10</span></div>
          ${miniTable(s.top_overdue, 'Nothing overdue 🎉', 'overdue')}</div>
        <div class="card"><div class="card-head"><h3>Due in the next 7 days</h3></div>
          ${miniTable(s.due_soon, 'Nothing due in the next 7 days', 'due')}</div>
      </div>
      <div class="card"><div class="card-head"><h3>Recent activity</h3></div>
        ${s.recent_activity.length ? `<ul class="activity">${s.recent_activity.map((a) => `
          <li>${esc(a.detail)}<div class="meta">${esc(a.user || 'Unknown')} · ${fmtDateTime(a.created_at)}</div></li>`).join('')}</ul>`
          : '<div class="empty">No activity yet</div>'}
      </div>`;
    $$('.bar > span', main).forEach((el) => { el.style.width = `${el.dataset.w}%`; });
    $('#refresh').addEventListener('click', () => render().then(() => toast('Updated')));
    $$('tr[data-id]', main).forEach((tr) => tr.addEventListener('click', () => openInvoice(Number(tr.dataset.id))));
  }

  // -------------------------------------------------------------------------
  // Invoice lists
  // -------------------------------------------------------------------------
  const FILTERS = [
    ['outstanding', 'Unpaid', (i) => i.balance > 0 && !i.voided],
    ['overdue', 'Overdue', (i) => i.status === 'Overdue'],
    ['partial', 'Partially paid', (i) => i.partially_paid],
    ['paid', 'Paid', (i) => i.status === 'Paid'],
    ['void', 'Void', (i) => i.voided],
    ['all', 'All', () => true],
  ];

  async function loadInvoices() {
    const data = await api('GET', '/api/invoices');
    state.invoices = data.invoices;
    state.today = data.today;
  }

  async function renderList(type) {
    await loadInvoices();
    const ls = state.list[type];
    main.innerHTML = `
      <div class="page-head">
        <div><h1>${LABEL[type]}</h1><div class="muted">${type === 'AR' ? 'Invoices we issued to customers — money owed to us' : 'Bills from suppliers — money we owe'}</div></div>
        <div class="actions">
          ${canEdit() ? `<button class="btn primary" id="add">+ New ${type === 'AR' ? 'invoice' : 'bill'}</button>
          <button class="btn" id="import">Import CSV</button>` : ''}
          <a class="btn" href="/api/export.csv?type=${type}">Export CSV</a>
        </div>
      </div>
      <div class="card">
        <div class="filters">
          <div class="chips" id="chips"></div>
          <input type="search" id="q" placeholder="Search ${PARTY[type].toLowerCase()}, invoice no, reference…" value="${esc(ls.q)}">
        </div>
        <div id="list-body"></div>
      </div>`;
    if (canEdit()) {
      $('#add').addEventListener('click', () => editInvoice(null, type));
      $('#import').addEventListener('click', () => importDialog(type));
    }
    $('#q').addEventListener('input', (e) => { ls.q = e.target.value; drawList(type); });
    drawList(type);
  }

  function drawList(type) {
    const ls = state.list[type];
    const ofType = state.invoices.filter((i) => i.type === type);
    $('#chips').innerHTML = FILTERS.map(([key, label, fn]) => `<button class="chip${ls.filter === key ? ' active' : ''}" data-f="${key}">
      ${label}<span class="count">${ofType.filter(fn).length}</span></button>`).join('');
    $$('#chips .chip').forEach((c) => c.addEventListener('click', () => { ls.filter = c.dataset.f; drawList(type); }));

    const fn = FILTERS.find((f) => f[0] === ls.filter)[2];
    const q = ls.q.trim().toLowerCase();
    let rows = ofType.filter(fn).filter((i) => !q || [i.party, i.invoice_no, i.reference, i.description, i.notes]
      .some((v) => String(v).toLowerCase().includes(q)));
    rows = rows.sort((a, b) => {
      const x = a[ls.sort]; const y = b[ls.sort];
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * ls.dir;
    });
    const cols = [
      ['invoice_no', 'Invoice no', 'hide-sm'], ['party', PARTY[type]], ['issue_date', 'Issued', 'hide-sm'], ['due_date', 'Due'],
      ['amount', 'Amount', 'num hide-sm'], ['paid', type === 'AR' ? 'Received' : 'Paid', 'num hide-sm'], ['balance', 'Balance', 'num'], ['status', 'Status', 'hide-sm'],
    ];
    const tot = rows.reduce((t, i) => ({ amount: t.amount + i.amount, paid: t.paid + i.paid, balance: t.balance + i.balance }), { amount: 0, paid: 0, balance: 0 });
    $('#list-body').innerHTML = rows.length ? `<div class="table-wrap"><table>
      <thead><tr>${cols.map(([k, l, cls]) => `<th class="sortable ${cls || ''}" data-k="${k}">${l}${ls.sort === k ? (ls.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((i) => `<tr class="clickable${i.voided ? ' voided' : ''}" data-id="${i.id}">
        <td class="hide-sm">${esc(i.invoice_no)}</td>
        <td class="party">${esc(i.party)}<div class="muted small-text show-sm">${esc(i.invoice_no)} · ${esc(i.status)}</div>${i.description ? `<div class="muted small-text">${esc(i.description)}</div>` : ''}</td>
        <td class="hide-sm">${fmtDate(i.issue_date)}</td>
        <td>${fmtDate(i.due_date)}<div class="muted small-text">${esc(relDue(i))}</div></td>
        <td class="num hide-sm">${money(i.amount)}</td>
        <td class="num hide-sm">${money(i.paid)}</td>
        <td class="num"><strong>${money(i.balance)}</strong></td>
        <td class="hide-sm">${pill(i.status)}${i.partially_paid && i.status === 'Overdue' ? '<div class="muted small-text">part paid</div>' : ''}</td>
      </tr>`).join('')}</tbody>
      <tfoot><tr><td class="hide-sm"></td><td>${rows.length} shown</td><td class="hide-sm"></td><td></td>
        <td class="num hide-sm">${money(tot.amount)}</td><td class="num hide-sm">${money(tot.paid)}</td><td class="num">${money(tot.balance)}</td><td class="hide-sm"></td></tr></tfoot>
      </table></div>`
      : `<div class="empty">${ofType.length ? 'No invoices match this filter.' : `No ${LABEL[type].toLowerCase()} yet.${canEdit() ? ' Click “New” or import a CSV to get started.' : ''}`}</div>`;
    $$('#list-body th[data-k]').forEach((th) => th.addEventListener('click', () => {
      if (ls.sort === th.dataset.k) ls.dir = -ls.dir; else { ls.sort = th.dataset.k; ls.dir = 1; }
      drawList(type);
    }));
    $$('#list-body tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openInvoice(Number(tr.dataset.id))));
  }

  // -------------------------------------------------------------------------
  // Invoice detail
  // -------------------------------------------------------------------------
  async function openInvoice(id) {
    const inv = await api('GET', `/api/invoices/${id}`);
    state.today = state.today || inv.due_date;
    const body = openModal(`${inv.type === 'AR' ? 'Invoice' : 'Bill'} ${inv.invoice_no}`, `
      <div class="detail-grid">
        <div><div class="k">${PARTY[inv.type]}</div><div class="v">${esc(inv.party)}</div></div>
        <div><div class="k">Status</div><div class="v">${pill(inv.status)}</div></div>
        <div><div class="k">Type</div><div class="v"><span class="tag ${inv.type}">${inv.type}</span> ${LABEL[inv.type]}</div></div>
        <div><div class="k">Issued</div><div class="v">${fmtDate(inv.issue_date)}</div></div>
        <div><div class="k">Due</div><div class="v">${fmtDate(inv.due_date)}<div class="muted small-text">${esc(relDue(inv))}</div></div></div>
        <div><div class="k">Reference / PO</div><div class="v">${esc(inv.reference) || '—'}</div></div>
        <div><div class="k">Amount</div><div class="v">${money(inv.amount)}</div></div>
        <div><div class="k">${inv.type === 'AR' ? 'Received' : 'Paid'}</div><div class="v">${money(inv.paid)}</div></div>
        <div><div class="k">Balance</div><div class="v">${money(inv.balance)}</div></div>
      </div>
      ${inv.description ? `<div class="section-title">Description</div><div class="notes">${esc(inv.description)}</div>` : ''}
      ${inv.notes ? `<div class="section-title">Notes</div><div class="notes">${esc(inv.notes)}</div>` : ''}
      <div class="section-title">Payments</div>
      ${inv.payments.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Method</th><th class="hide-sm">Reference</th><th class="num">Amount</th>${canEdit() ? '<th></th>' : ''}</tr></thead><tbody>
        ${inv.payments.map((p) => `<tr><td>${fmtDate(p.paid_date)}</td><td>${esc(p.method) || '—'}</td><td class="hide-sm">${esc(p.reference) || '—'}</td>
          <td class="num">${money(p.amount)}</td>${canEdit() ? `<td><button class="btn ghost small danger" data-del-pay="${p.id}" title="Remove payment">✕</button></td>` : ''}</tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">No payments recorded yet.</p>'}
      ${canEdit() && !inv.voided && inv.balance > 0 ? `
        <form id="pay-form" class="card card-pad">
          <h3>Record ${inv.type === 'AR' ? 'payment received' : 'payment made'}</h3><br>
          <div class="form-grid">
            <label>Date <input type="date" name="paid_date" required value="${esc(state.today)}"></label>
            <label>Amount <input name="amount" inputmode="decimal" required value="${inv.balance.toFixed(2)}"></label>
            <label>Method <select name="method"><option>Bank transfer</option><option>Cheque</option><option>Cash</option><option>Card</option><option>Online / e-wallet</option><option>Offset / contra</option><option>Other</option></select></label>
            <label>Reference <input name="reference" placeholder="Txn / cheque no."></label>
          </div>
          <p class="form-error"></p>
          <div class="form-actions"><button class="btn primary" type="submit">Save payment</button></div>
        </form>` : ''}
      <p class="muted small-text">Created by ${esc(inv.created_by || '—')} · Last updated ${fmtDateTime(inv.updated_at)} by ${esc(inv.updated_by || '—')}</p>
      ${canEdit() ? `<div class="form-actions">
        ${isAdmin() ? '<button class="btn danger" id="del-inv">Delete</button>' : ''}
        <span class="spacer"></span>
        <button class="btn" id="void-inv">${inv.voided ? 'Restore' : 'Void'}</button>
        <button class="btn primary" id="edit-inv">Edit</button></div>` : ''}
    `, true);

    const afterChange = async (msg) => { toast(msg); await render(); await openInvoice(id); };
    const payForm = $('#pay-form', body);
    if (payForm) bindForm(payForm, async (d) => { await api('POST', `/api/invoices/${id}/payments`, d); await afterChange('Payment recorded'); });
    $$('[data-del-pay]', body).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Remove this payment?')) return;
      try { await api('DELETE', `/api/payments/${b.dataset.delPay}`); await afterChange('Payment removed'); } catch (e) { toast(e.message, true); }
    }));
    if (canEdit()) {
      $('#edit-inv', body).addEventListener('click', () => editInvoice(inv, inv.type));
      $('#void-inv', body).addEventListener('click', async () => {
        if (!inv.voided && !confirm('Void this invoice? It will no longer count as outstanding.')) return;
        try { await api('PUT', `/api/invoices/${id}`, { voided: !inv.voided }); await afterChange(inv.voided ? 'Restored' : 'Voided'); } catch (e) { toast(e.message, true); }
      });
      const del = $('#del-inv', body);
      if (del) del.addEventListener('click', async () => {
        if (!confirm(`Permanently delete ${inv.invoice_no} and its payments? This cannot be undone.`)) return;
        try { await api('DELETE', `/api/invoices/${id}`); closeModal(); toast('Deleted'); render(); } catch (e) { toast(e.message, true); }
      });
    }
  }

  function editInvoice(inv, type) {
    const isNew = !inv;
    const t = inv ? inv.type : type;
    const today = state.today || new Date().toISOString().slice(0, 10);
    const in30 = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
    const v = inv || { invoice_no: '', party: '', issue_date: today, due_date: in30, amount: '', reference: '', description: '', notes: '' };
    const body = openModal(isNew ? `New ${t === 'AR' ? 'customer invoice (AR)' : 'supplier bill (AP)'}` : `Edit ${v.invoice_no}`, `
      <form id="inv-form">
        <div class="form-grid">
          <label>Invoice no <input name="invoice_no" required value="${esc(v.invoice_no)}"></label>
          <label>${PARTY[t]} <input name="party" required list="parties" value="${esc(v.party)}"></label>
          <datalist id="parties">${[...new Set(state.invoices.filter((i) => i.type === t).map((i) => i.party))].map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
          <label>Issue date <input type="date" name="issue_date" required value="${esc(v.issue_date)}"></label>
          <label>Due date <input type="date" name="due_date" required value="${esc(v.due_date)}"></label>
          <label>Amount (${esc(state.settings.currency)}) <input name="amount" inputmode="decimal" required value="${v.amount === '' ? '' : Number(v.amount).toFixed(2)}"></label>
          <label>Reference / PO <input name="reference" value="${esc(v.reference)}"></label>
          <label class="full">Description <input name="description" value="${esc(v.description)}"></label>
          <label class="full">Notes (follow-ups, contacts, remarks) <textarea name="notes">${esc(v.notes)}</textarea></label>
        </div>
        <p class="form-error"></p>
        <div class="form-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">${isNew ? 'Add' : 'Save'}</button></div>
      </form>`);
    bindForm($('#inv-form', body), async (d) => {
      if (isNew) {
        const created = await api('POST', '/api/invoices', { ...d, type: t });
        toast('Added');
        await render();
        await openInvoice(created.id);
      } else {
        await api('PUT', `/api/invoices/${inv.id}`, d);
        toast('Saved');
        await render();
        await openInvoice(inv.id);
      }
    });
  }

  // -------------------------------------------------------------------------
  // CSV import
  // -------------------------------------------------------------------------
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i += 1;
        row.push(field); field = '';
        if (row.some((f) => f.trim() !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    return rows;
  }

  const HEADER_ALIASES = {
    invoice_no: ['invoiceno', 'invoicenumber', 'invoice', 'billno', 'billnumber', 'no', 'number', 'docno'],
    party: ['party', 'customer', 'supplier', 'vendor', 'customersupplier', 'client', 'name', 'company'],
    issue_date: ['issuedate', 'invoicedate', 'date', 'billdate', 'issued'],
    due_date: ['duedate', 'due', 'paymentdue'],
    amount: ['amount', 'total', 'invoiceamount', 'totalamount', 'grandtotal'],
    paid: ['paid', 'amountpaid', 'received', 'paidamount', 'amountreceived'],
    paid_date: ['paiddate', 'paymentdate', 'lastpayment', 'datepaid'],
    reference: ['reference', 'ref', 'po', 'ponumber', 'poref'],
    description: ['description', 'desc', 'details', 'item'],
    notes: ['notes', 'note', 'remarks', 'remark', 'comment', 'comments'],
  };

  function normalizeDate(s, fmt) {
    s = String(s || '').trim();
    if (!s) return '';
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
      const [y, m, d] = s.split('-');
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
    if (!m) return s;
    let [, a, b, y] = m;
    if (y.length === 2) y = `20${y}`;
    const [day, month] = fmt === 'mdy' ? [b, a] : [a, b];
    return `${y}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  function importDialog(type) {
    const body = openModal(`Import ${LABEL[type].toLowerCase()} from CSV`, `
      <p>Upload a CSV (you can “Save as CSV” from Excel or Google Sheets). The first row must be column headers.</p>
      <p class="muted small-text">Required columns: <strong>Invoice No, ${PARTY[type]}, Issue Date, Due Date, Amount</strong>.
        Optional: Paid, Paid Date, Reference, Description, Notes. Amount already paid is recorded as one payment.</p>
      <p><button class="btn small" id="tpl">Download template</button></p>
      <form id="imp-form">
        <div class="form-grid">
          <label class="full">CSV file <input type="file" name="file" accept=".csv,text/csv" required></label>
          <label class="full">Date format in the file (if not YYYY-MM-DD)
            <select name="datefmt"><option value="dmy">DD/MM/YYYY</option><option value="mdy">MM/DD/YYYY</option></select></label>
        </div>
        <div id="imp-preview" class="muted small-text"></div>
        <p class="form-error"></p>
        <div class="form-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Import</button></div>
      </form>`);
    $('#tpl', body).addEventListener('click', () => {
      const csv = `Invoice No,${PARTY[type]},Issue Date,Due Date,Amount,Paid,Paid Date,Reference,Description,Notes\r\nINV-1001,Example Co,2026-10-01,2026-10-31,1500.00,500.00,2026-10-15,PO-77,Consulting services,\r\n`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `${type}-import-template.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    const form = $('#imp-form', body);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', form);
      err.textContent = '';
      const file = form.elements.file.files[0];
      if (!file) return;
      try {
        const rows = parseCsv(await file.text());
        if (rows.length < 2) throw new Error('The file has no data rows');
        const headers = rows[0].map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
        const idx = {};
        for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
          const i = headers.findIndex((h) => h === key.replace(/_/g, '') || aliases.includes(h));
          if (i >= 0) idx[key] = i;
        }
        const missing = ['invoice_no', 'party', 'issue_date', 'due_date', 'amount'].filter((k) => idx[k] === undefined);
        if (missing.length) throw new Error(`Missing column(s): ${missing.join(', ')}`);
        const fmt = form.elements.datefmt.value;
        const invoices = rows.slice(1).map((r) => {
          const get = (k) => (idx[k] === undefined ? '' : (r[idx[k]] || '').trim());
          return {
            type, invoice_no: get('invoice_no'), party: get('party'),
            issue_date: normalizeDate(get('issue_date'), fmt), due_date: normalizeDate(get('due_date'), fmt),
            amount: get('amount').replace(/[^0-9.\-]/g, ''), paid: get('paid').replace(/[^0-9.\-]/g, ''),
            paid_date: normalizeDate(get('paid_date'), fmt),
            reference: get('reference'), description: get('description'), notes: get('notes'),
          };
        });
        const result = await api('POST', '/api/invoices/import', { invoices });
        await render();
        if (result.errors.length) {
          $('#imp-preview', body).innerHTML = `<strong>Imported ${result.created}.</strong> ${result.errors.length} row(s) skipped:<br>${
            result.errors.slice(0, 30).map((x) => `Row ${x.row}: ${esc(x.error)}`).join('<br>')}`;
        } else {
          closeModal();
          toast(`Imported ${result.created} invoice${result.created === 1 ? '' : 's'}`);
        }
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Users (admin)
  // -------------------------------------------------------------------------
  async function renderUsers() {
    const { users } = await api('GET', '/api/users');
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Users</h1><div class="muted">Give your boss a <strong>Viewer</strong> account to see everything without being able to change it.</div></div>
        <div class="actions"><button class="btn primary" id="add-user">+ Add user</button></div>
      </div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th class="hide-sm">Last sign-in</th><th>Status</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr>
          <td class="party">${esc(u.name)}</td><td>${esc(u.username)}</td>
          <td><span class="pill role">${ROLE_LABEL[u.role]}</span></td>
          <td class="hide-sm">${fmtDateTime(u.last_login_at)}</td>
          <td>${u.active ? 'Active' : '<span class="muted">Disabled</span>'}</td>
          <td class="num"><button class="btn small" data-edit="${u.id}">Edit</button></td></tr>`).join('')}</tbody>
      </table></div></div>
      <div class="card card-pad mt">
        <h3>Roles</h3>
        <p class="small-text"><strong>Viewer</strong> – can see the dashboard, all invoices and payments, and export CSV. Cannot change anything.<br>
        <strong>Editor</strong> – can also add/edit invoices, record payments and import CSV.<br>
        <strong>Admin</strong> – can also delete invoices, manage users and company settings.</p>
      </div>`;
    $('#add-user').addEventListener('click', () => userDialog(null));
    $$('[data-edit]', main).forEach((b) => b.addEventListener('click', () => userDialog(users.find((u) => u.id === Number(b.dataset.edit)))));
  }

  function userDialog(u) {
    const isNew = !u;
    const body = openModal(isNew ? 'Add user' : `Edit ${u.name}`, `
      <form id="user-form">
        <div class="form-grid">
          <label>Full name <input name="name" required value="${esc(u ? u.name : '')}"></label>
          <label>Username <input name="username" required ${isNew ? '' : 'disabled'} value="${esc(u ? u.username : '')}" autocomplete="off"></label>
          <label>Role <select name="role">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}"${(u ? u.role : 'viewer') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>${isNew ? 'Password' : 'New password (leave blank to keep)'} <input name="password" type="text" minlength="8" ${isNew ? 'required' : ''} autocomplete="new-password"></label>
          ${isNew ? '' : `<label class="check full"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Account active (can sign in)</label>`}
        </div>
        <p class="muted small-text">Share the username and password with the person privately. They can change their password under “Account”.</p>
        <p class="form-error"></p>
        <div class="form-actions">
          ${!isNew && u.id !== state.user.id ? '<button class="btn danger" type="button" id="del-user">Delete</button>' : ''}
          <span class="spacer"></span>
          <button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">${isNew ? 'Create' : 'Save'}</button></div>
      </form>`);
    bindForm($('#user-form', body), async (d) => {
      if (isNew) await api('POST', '/api/users', d);
      else {
        if (!d.password) delete d.password;
        delete d.username;
        await api('PUT', `/api/users/${u.id}`, d);
      }
      closeModal();
      toast(isNew ? 'User created' : 'Saved');
      render();
    });
    const del = $('#del-user', body);
    if (del) del.addEventListener('click', async () => {
      if (!confirm(`Delete ${u.name}'s account?`)) return;
      try { await api('DELETE', `/api/users/${u.id}`); closeModal(); toast('Deleted'); render(); } catch (e) { toast(e.message, true); }
    });
  }

  // -------------------------------------------------------------------------
  // Account & settings
  // -------------------------------------------------------------------------
  function renderAccount() {
    main.innerHTML = `
      <div class="page-head"><div><h1>Account</h1><div class="muted">Signed in as ${esc(state.user.name)} (${esc(state.user.username)}) · ${ROLE_LABEL[state.user.role]}</div></div></div>
      <div class="grid two-col">
        <form class="card card-pad" id="pw-form">
          <h3>Change password</h3><br>
          <div class="form-grid">
            <label class="full">Current password <input type="password" name="current_password" required autocomplete="current-password"></label>
            <label>New password <input type="password" name="new_password" minlength="8" required autocomplete="new-password"></label>
            <label>Confirm new password <input type="password" name="confirm" minlength="8" required autocomplete="new-password"></label>
          </div>
          <p class="form-error"></p>
          <div class="form-actions"><button class="btn primary" type="submit">Update password</button></div>
        </form>
        ${isAdmin() ? `<form class="card card-pad" id="settings-form">
          <h3>Company settings</h3><br>
          <div class="form-grid">
            <label class="full">Company name <input name="company_name" value="${esc(state.settings.company_name)}" placeholder="Shown in the header"></label>
            <label>Currency code <input name="currency" required maxlength="10" value="${esc(state.settings.currency)}" placeholder="e.g. USD, MYR, SGD"></label>
          </div>
          <p class="form-error"></p>
          <div class="form-actions"><button class="btn primary" type="submit">Save settings</button></div>
        </form>` : ''}
      </div>`;
    bindForm($('#pw-form'), async (d) => {
      if (d.new_password !== d.confirm) throw new Error('New passwords do not match');
      await api('POST', '/api/me/password', d);
      $('#pw-form').reset();
      toast('Password updated');
    });
    if (isAdmin()) {
      bindForm($('#settings-form'), async (d) => {
        await api('PUT', '/api/settings', d);
        toast('Settings saved');
        await startApp();
      });
    }
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  startApp().catch(() => showLogin());
})();
