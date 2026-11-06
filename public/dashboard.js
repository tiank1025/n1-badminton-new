    const SLOT_LABELS = ['7:00 – 7:30', '7:30 – 8:00', '8:00 – 8:30', '8:30 – 9:00'];
    const FILTER_LABELS = { all: 'All', open: 'Open', active: 'Active', finished: 'Finished' };
    const regsByEvent = {}; // eventId -> registrations (used by "copy unpaid")

    let allEvents = [];
    let currentFilter = 'all';
    let searchTerm = '';
    let currentEventId = null;

    function money(cents) {
      return 'AUD$' + ((Number(cents) || 0) / 100).toFixed(2);
    }
    function payBadge(status) {
      const label = { paid: 'Paid', unpaid: 'Unpaid', submitted: 'Awaiting review', waived: 'Waived' }[status] || status;
      return `<span class="pay-badge pay-${status}">${label}</span>`;
    }

    async function loadMe() {
      const r = await fetch('/api/auth/me');
      const u = await r.json();
      if (!u || !u.is_admin) { window.location.href = '/login'; return; }
      document.getElementById('user-info').textContent = `${t('Logged in as ', '当前登录：')}${u.display_name}`;
    }

    // ── List view ──────────────────────────────────────────
    async function loadEvents() {
      const r = await fetch('/api/events');
      allEvents = await r.json();

      if (currentEventId) {
        const ev = allEvents.find(e => e.id === currentEventId);
        if (ev) { renderDetailHeader(ev); loadRegs(currentEventId); }
        else { backToList(); }
      }
      renderEventList();
    }

    function filteredEvents() {
      const q = searchTerm.toLowerCase();
      return allEvents.filter(ev => {
        const matchStatus = currentFilter === 'all' || ev.status === currentFilter;
        const matchText = !q
          || (ev.title || '').toLowerCase().includes(q)
          || (ev.event_date || '').includes(q);
        return matchStatus && matchText;
      });
    }

    function renderEventList() {
      const list = document.getElementById('events-list');
      const items = filteredEvents();
      const live = allEvents.filter(e => e.status === 'active').length;
      document.getElementById('list-summary').textContent =
        `${allEvents.length} event(s)${live ? ` · ${live} live now` : ''}`;

      if (!allEvents.length) {
        list.innerHTML = `<div class="card"><div class="empty-state">${t('No events yet — click “＋ New Event” to create one.', '还没有活动，点击“＋ 新建活动”创建。')}</div></div>`;
        updateFilterChips();
        return;
      }
      if (!items.length) {
        list.innerHTML = `<div class="card"><div class="empty-state">${t('No events match this filter.', '没有符合筛选条件的活动。')}</div></div>`;
        updateFilterChips();
        return;
      }

      list.innerHTML = `<div class="card event-list-card">${items.map(ev => `
        <div class="event-row" onclick="openEvent(${ev.id})">
          <div class="er-date">${ev.event_date}<span>${ev.start_time}-${ev.end_time}</span></div>
          <div class="er-main">
            <div class="er-title">${ev.title}</div>
            <div class="er-meta">${ev.reg_count || 0}/${ev.capacity || 33} registered${ev.waitlist_count ? ` · ${ev.waitlist_count} waitlisted` : ''}${ev.status === 'active' ? ' · live now' : ''}</div>
          </div>
          <div class="er-right">
            <span class="badge badge-${ev.status}">${ev.status}</span>
            <span class="er-arrow">›</span>
          </div>
        </div>`).join('')}</div>`;
      updateFilterChips();
    }

    function updateFilterChips() {
      document.querySelectorAll('.filter-chip').forEach(chip => {
        const s = chip.dataset.status;
        const n = s === 'all' ? allEvents.length : allEvents.filter(e => e.status === s).length;
        chip.textContent = `${FILTER_LABELS[s]} (${n})`;
        chip.classList.toggle('active', s === currentFilter);
      });
    }

    function setFilter(status) {
      currentFilter = status;
      renderEventList();
    }

    function onSearch(value) {
      searchTerm = value.trim();
      renderEventList();
    }

    function toggleCreate() {
      const card = document.getElementById('create-card');
      const hidden = card.classList.toggle('hidden');
      document.getElementById('toggle-create').textContent = hidden ? '＋ New Event' : '✕ Cancel';
    }

    // ── Detail view ────────────────────────────────────────
    function openEvent(id) {
      const ev = allEvents.find(e => e.id === id);
      if (!ev) return;
      currentEventId = id;
      document.getElementById('list-view').classList.add('hidden');
      document.getElementById('detail-view').classList.remove('hidden');
      // Fresh manual-add search for each event.
      addQuery = '';
      const searchEl = document.getElementById('user-search');
      if (searchEl) searchEl.value = '';
      document.getElementById('admin-add-results').innerHTML = '';
      renderDetailHeader(ev);
      loadRegs(id);
      renderMatchesSection();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function backToList() {
      currentEventId = null;
      document.getElementById('detail-view').classList.add('hidden');
      document.getElementById('list-view').classList.remove('hidden');
      document.getElementById('toggle-create').textContent = '＋ New Event';
      document.getElementById('create-card').classList.add('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ── Users view ─────────────────────────────────────────
    let allUsers = [];

    function escHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    function fmtDate(ms) {
      if (!ms) return '';
      const d = new Date(Number(ms));
      return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    async function openUsers() {
      document.getElementById('list-view').classList.add('hidden');
      document.getElementById('detail-view').classList.add('hidden');
      document.getElementById('users-view').classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      await loadUsers();
    }

    function closeUsers() {
      document.getElementById('users-view').classList.add('hidden');
      document.getElementById('list-view').classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    async function loadUsers() {
      const r = await fetch('/api/auth/users');
      if (!r.ok) { toast(t('Could not load users.', '加载用户失败。'), false); return; }
      allUsers = await r.json();
      renderUsers(document.getElementById('users-search')?.value || '');
    }

    function renderUsers(q) {
      const list = document.getElementById('users-list');
      const term = String(q || '').trim().toLowerCase();
      const items = allUsers.filter(u =>
        !term || [u.display_name, u.username, u.email]
          .some(v => (v || '').toLowerCase().includes(term))
      );
      document.getElementById('users-summary').textContent = term
        ? `${items.length} / ${allUsers.length} ${t('account(s) match', '个账号匹配')}`
        : `${allUsers.length} ${t('registered account(s)', '个注册账号')}`;

      if (!items.length) {
        list.innerHTML = `<div class="card"><div class="empty-state">${t('No users found.', '没有找到用户。')}</div></div>`;
        return;
      }

      const LEVEL_LABEL = {
        advanced: t('Advanced', '高级'),
        intermediate: t('Intermediate', '中级'),
        novice: t('Novice', '初级'),
        beginner: t('Beginner', '入门'),
      };

      list.innerHTML = `<div class="card">${items.map((u, i) => `
        <div style="display:flex; align-items:center; gap:12px; padding:11px 4px;${i ? 'border-top:1px solid var(--border);' : ''}">
          <div style="flex:1; min-width:0;">
            <div style="font-weight:800; font-size:14px;">
              ${escHtml(u.display_name)}${u.is_admin ? ` <span class="pay-badge pay-paid" style="margin-left:4px;">Admin</span>` : ''}
            </div>
            <div class="text-muted" style="font-size:12px; overflow-wrap:anywhere;">
              @${escHtml(u.username)} · ${u.email ? escHtml(u.email) : t('no email', '未填邮箱')}
            </div>
          </div>
          <div style="text-align:right; font-size:12px; color:var(--text-muted); white-space:nowrap;">
            <div>${LEVEL_LABEL[u.level] || escHtml(u.level)}</div>
            <div>${u.active_events} ${t('active', '在报')} · ${u.total_signups} ${t('total', '累计')}</div>
            <div>${fmtDate(u.created_at)}</div>
          </div>
        </div>`).join('')}</div>`;
    }

    function renderDetailHeader(ev) {
      const cap = ev.capacity || 33;
      const taken = ev.reg_count || 0;
      document.getElementById('detail-head').innerHTML = `
        <div class="detail-title">${ev.title}</div>
        <div class="detail-fees">
          <span>${ev.event_date} · ${ev.start_time}–${ev.end_time}</span>
          ${ev.location ? `<span>📍 ${ev.location}</span>` : ''}
          <span class="badge badge-${ev.status}">${({draft:t('Draft','草稿'),open:t('Open','开放报名'),closed:t('Closed','已关闭'),active:t('Active','进行中'),finished:t('Finished','已结束')})[ev.status] || ev.status}</span>
        </div>
        <div class="detail-fees" id="cap-line">
          Capacity: <strong>${taken}/${cap}</strong>${taken >= cap ? ' · <span style="color:#b91c1c;font-weight:800;">FULL</span>' : ''}
          ${ev.waitlist_count ? ` · ${ev.waitlist_count} on waitlist` : ''}
        </div>
        <div class="detail-fees">
          Fees: ${money(ev.fee_social_cents)} social · ${money(ev.fee_training_cents)} training+social
          ${ev.payment_link ? ' · <span style="color:var(--mg-700); font-weight:700;">online payment link set</span>' : ''}
        </div>`;
      renderActions(ev);
    }

    // Lifecycle buttons: draft → open → closed → active → finished.
    function renderActions(ev) {
      const id = ev.id;
      const actions = document.getElementById('detail-actions');
      let html = '';
      switch (ev.status) {
        case 'draft':
          html += `<button class="btn btn-primary" onclick="patchEvent(${id}, {status:'open'})">Open Registration</button>`;
          break;
        case 'open':
          html += `<button class="btn btn-secondary" onclick="patchEvent(${id}, {status:'closed'})">Close Registration</button>`;
          html += `<button class="btn btn-secondary" onclick="activateFromDashboard(${id})">⚡ Set Active</button>`;
          html += `<a class="btn btn-primary" href="/board?eventId=${id}&activate=1">📊 Activate &amp; Open Board</a>`;
          break;
        case 'closed':
          html += `<button class="btn btn-secondary" onclick="patchEvent(${id}, {status:'open'})">Reopen Registration</button>`;
          html += `<button class="btn btn-secondary" onclick="activateFromDashboard(${id})">⚡ Set Active</button>`;
          html += `<a class="btn btn-primary" href="/board?eventId=${id}&activate=1">📊 Activate &amp; Open Board</a>`;
          break;
        case 'active':
          html += `<button class="btn btn-danger" onclick="finishEvent(${id})">✅ Finish Event</button>`;
          html += `<a class="btn btn-primary" href="/board?eventId=${id}">📊 Open Live Board</a>`;
          break;
        case 'finished':
          html += `<button class="btn btn-secondary" onclick="activateFromDashboard(${id})">🔄 Reactivate</button>`;
          html += `<a class="btn btn-primary" href="/board?eventId=${id}&activate=1">📊 Activate &amp; Open Board</a>`;
          break;
      }
      html += `<button class="btn btn-secondary" onclick="showCheckInQr(${id})">📱 签到二维码</button>`;
      html += `<button class="btn btn-secondary" onclick="editCapacity(${id})">⚙️ Capacity</button>`;
      html += `<button class="btn btn-danger" onclick="deleteEvent(${id})">Delete Event</button>`;
      actions.innerHTML = html;
    }

    // Quick capacity edit — prompt inline, PATCH in the background.
    async function editCapacity(eventId) {
      const ev = await fetch(`/api/events/${eventId}`).then(r => r.json());
      const cur = ev.capacity || 33;
      const taken = ev.reg_count || 0;
      const raw = prompt(
        t(`Set capacity (currently ${taken}/${cur}, range 1-500):`, `设置名额（当前 ${taken}/${cur}，范围 1-500）：`),
        String(cur)
      );
      if (raw === null) return;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1 || n > 500) { alert(t('Capacity must be between 1 and 500', '名额必须在 1 到 500 之间')); return; }
      if (n < taken) {
        const ok = confirm(t(
          `${taken} people are currently registered. Reducing the capacity to ${n} will let waitlisted players move up, but will not remove anyone already registered. Continue?`,
          `当前已报名 ${taken} 人，改到 ${n} 人会让候补玩家升级，但不会自动踢掉已报名球员。确认？`
        ));
        if (!ok) return;
      }
      const r = await fetch(`/api/events/${eventId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', credentials: 'same-origin' },
        body: JSON.stringify({ capacity: n }),
      });
      if (!r.ok) { const d = await r.json(); alert('Failed: ' + (d.error || r.status)); return; }
      toast('✅ Capacity updated to ' + n);
      // Refresh the detail view so the Capacity header, stats row and list
      // all update immediately — no page reload needed.
      await openEvent(eventId);
      // Also refresh the list sidebar so the event-card counts stay accurate.
      loadEvents();
    }

    // Venue QR code: players scan it, land on /m and self check in.
    function showCheckInQr(eventId) {
      const url = `${location.origin}/m?event=${eventId}`;
      const overlay = document.createElement('div');
      overlay.id = 'qr-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.72);display:flex;align-items:center;justify-content:center;z-index:60;padding:20px;';
      overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
      overlay.innerHTML = `
        <div style="background:#fff;border-radius:20px;padding:24px;max-width:380px;text-align:center;">
          <div style="font-size:18px;font-weight:800;color:#0f172a;">📱 现场签到二维码</div>
          <div style="font-size:12px;color:#64748b;margin-top:6px;">把这个二维码打印出来贴在场地，球员扫码即可自助签到。</div>
          <img src="/api/events/${eventId}/qrcode" alt="Check-in QR" style="width:260px;height:260px;margin:16px auto 0;display:block;">
          <div style="font-size:11px;color:#94a3b8;margin-top:10px;word-break:break-all;">${url}</div>
          <button class="btn btn-primary btn-block mt-16" onclick="window.open('${url}','_blank')">打开手机签到页</button>
          <button class="btn btn-secondary btn-block mt-8" onclick="document.getElementById('qr-overlay').remove()">关闭</button>
        </div>`;
      document.body.appendChild(overlay);
    }

    async function loadRegs(eventId) {
      const r = await fetch(`/api/events/${eventId}/registrations`);
      if (!r.ok) { backToList(); loadEvents(); return; }
      const d = await r.json();
      const regs = d.registrations || [];
      const waitlist = d.waitlist || [];
      const cap = d.capacity || 33;
      regsByEvent[eventId] = regs;
      const capLine = document.getElementById('cap-line');
      if (capLine) {
        capLine.innerHTML = `Capacity: <strong>${regs.length}/${cap}</strong>${regs.length >= cap ? ' · <span style="color:#b91c1c;font-weight:800;">FULL</span>' : ''}${waitlist.length ? ` · ${waitlist.length} on waitlist` : ''}`;
      }
      const ps = d.paymentSummary || { total: regs.length, paid: 0, submitted: 0, unpaid: 0, waived: 0,
        expectedCents: 0, collectedCents: 0, waivedCents: 0, outstandingCents: 0 };

      const activityCount = regs.filter(r => r.reg_type === 'activity').length;
      const trainingCount = regs.filter(r => r.reg_type === 'training_and_activity').length;
      document.getElementById('detail-stats').innerHTML = `
        <div class="stat"><div class="num">${regs.length}<span style="font-size:12px;color:var(--n-400);"> / ${cap}</span></div><div class="lbl">Registered</div></div>
        <div class="stat"><div class="num">${activityCount}</div><div class="lbl">Social Only</div></div>
        <div class="stat"><div class="num">${trainingCount}</div><div class="lbl">Training+Social</div></div>
        <div class="stat"><div class="num">${waitlist.length}</div><div class="lbl">Waitlist</div></div>
        <div class="stat"><div class="num">${d.checkedInCount || 0}</div><div class="lbl">Checked in</div></div>
        <div class="stat"><div class="num">${ps.paid}</div><div class="lbl">Paid</div></div>
        <div class="stat"><div class="num">${ps.unpaid + ps.submitted}</div><div class="lbl">Outstanding</div></div>
      `;

      // Payment reconciliation summary (only visible inside the event detail)
      const pending = ps.unpaid + ps.submitted;
      document.getElementById('detail-pay').innerHTML = `
        <div class="pay-summary">
          <span>💰 Collected <strong>${money(ps.collectedCents)}</strong> of ${money(ps.expectedCents)} expected</span>
          <span class="pay-badge pay-paid">${ps.paid} paid</span>
          <span class="pay-badge pay-submitted">${ps.submitted} awaiting review</span>
          <span class="pay-badge pay-unpaid">${ps.unpaid} unpaid</span>
          ${ps.waived ? `<span class="pay-badge pay-waived">${ps.waived} waived (${money(ps.waivedCents)})</span>` : ''}
          ${pending ? `<span style="color:#b91c1c;font-weight:700;">Outstanding ${money(ps.outstandingCents)}</span>
            <button class="btn btn-secondary btn-sm" onclick="copyUnpaid(${eventId})">📋 Copy unpaid names</button>` : ''}
        </div>`;

      document.getElementById('detail-slots').innerHTML = [0,1,2,3].map(i => {
        const slotRegs = regs.filter(r => r.training_slot === i);
        const names = slotRegs.map(r => r.display_name).join(', ') || '—';
        return `<div class="slot">
          <div class="label">${SLOT_LABELS[i]}</div>
          <div class="count">${slotRegs.length}/4</div>
          <div class="names">${names}</div>
        </div>`;
      }).join('');

      // Waitlist — only rendered when someone is queued for a full event.
      const wlSection = document.getElementById('waitlist-section');
      if (waitlist.length) {
        wlSection.classList.remove('hidden');
        document.getElementById('detail-waitlist').innerHTML = waitlist.map((w, i) => `
          <div class="waitlist-row">
            <div>
              <span class="wl-pos">#${i + 1}</span><strong>${w.display_name}</strong>
              <span class="text-muted" style="font-size:11px;"> · ${w.level} · ${w.reg_type === 'activity' ? 'Social' : 'Training + Social'}</span>
            </div>
            <div class="reg-actions">
              <button class="btn btn-primary btn-sm" onclick="promoteWaitlist(${w.id})">↑ Promote</button>
              <button class="btn btn-secondary btn-sm" onclick="removeWaitlist(${w.id})">Remove</button>
            </div>
          </div>`).join('');
      } else {
        wlSection.classList.add('hidden');
        document.getElementById('detail-waitlist').innerHTML = '';
      }

      if (!regs.length) {
        document.getElementById('detail-regs').innerHTML =
          '<div class="empty-state" style="margin-top:12px;">No registrations yet.</div>';
        return;
      }
      document.getElementById('detail-regs').innerHTML = `
        <div class="reg-list">
          ${regs.map(r => `
            <div class="reg-row">
              <div class="reg-info">
                <div class="reg-name">${r.display_name} ${payBadge(r.payment_status || 'unpaid')}
                  ${r.checked_in_at ? '<span style="background:#e8f5ec;color:#15803d;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:800;">✅ 已签到</span>' : ''}</div>
                <div class="reg-meta">
                  ${r.level} · ${r.reg_type === 'activity' ? 'Social' : 'Training + Social'}
                  ${r.reg_type === 'training_and_activity'
                    ? `<select class="slot-select ${r.training_slot == null ? 'unset' : ''}"
                        title="Assign training time"
                        onchange="assignSlot(${r.id}, ${eventId}, this.value)">
                        <option value="" ${r.training_slot == null ? 'selected' : ''}>Assign time…</option>
                        ${SLOT_LABELS.map((l, i) => `<option value="${i}" ${r.training_slot === i ? 'selected' : ''}>${l}</option>`).join('')}
                      </select>`
                    : ''}
                  ${r.partner_name ? ' · Partner: ' + r.partner_name : ''} · ${money(r.fee_cents)}
                </div>
              </div>
              <div class="reg-actions">
                ${r.payment_proof ? `<button class="btn btn-secondary btn-sm" onclick="viewProof(${r.id})">🧾 Proof</button>` : ''}
                ${r.payment_status !== 'paid'
                  ? `<button class="btn btn-primary btn-sm" onclick="setPayment(${r.id}, ${eventId}, 'paid')">✓ Paid</button>`
                  : `<button class="btn btn-secondary btn-sm" onclick="setPayment(${r.id}, ${eventId}, 'unpaid')">Undo</button>`}
                ${r.payment_status !== 'waived'
                  ? `<button class="btn btn-secondary btn-sm" onclick="setPayment(${r.id}, ${eventId}, 'waived')">Waive</button>` : ''}
                <button class="btn btn-danger btn-sm" onclick="removeReg(${r.id}, ${eventId})">Remove</button>
              </div>
            </div>`).join('')}
        </div>`;
    }

    // ── Admin: add / remove participants + waitlist ───────
    let addTimer = null;
    let addQuery = '';

    function onUserSearch(value) {
      addQuery = value.trim();
      clearTimeout(addTimer);
      if (addQuery.length < 2) { renderAddResults([]); return; }
      const q = addQuery;
      addTimer = setTimeout(async () => {
        try {
          const r = await fetch(`/api/events/${currentEventId}/user-search?q=${encodeURIComponent(q)}`);
          const rows = r.ok ? await r.json() : [];
          if (addQuery !== q) return; // a newer keystroke superseded this result
          renderAddResults(rows);
        } catch (e) { toast('❌ Network error: ' + e.message, false); }
      }, 300);
    }

    function renderAddResults(rows) {
      const el = document.getElementById('admin-add-results');
      if (!el) return;
      if (!addQuery || addQuery.length < 2) { el.innerHTML = ''; return; }
      if (!rows.length) {
        el.innerHTML = '<div class="text-muted" style="font-size:12px;margin-top:8px;">No matching users (people already in the event are hidden).</div>';
        return;
      }
      el.innerHTML = rows.map(u => `
        <div class="add-result">
          <div><strong>${u.display_name}</strong> <span class="text-muted" style="font-size:11px;">${u.username} · ${u.level}</span></div>
          <button class="btn btn-primary btn-sm" onclick="addParticipant(${u.id})">＋ Add</button>
        </div>`).join('');
    }

    function toggleAddSlot(value) {
      document.getElementById('add-slot').classList.toggle('hidden', value !== 'training_and_activity');
    }

    async function addParticipant(userId) {
      const type = document.getElementById('add-type').value;
      const body = { user_id: userId, reg_type: type };
      if (type === 'training_and_activity') body.training_slot = Number(document.getElementById('add-slot').value);
      try {
        const r = await fetch(`/api/events/${currentEventId}/participants`, {
          method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
          body: JSON.stringify(body)
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast('❌ ' + (d.error || `Failed (${r.status})`), false); return; }
        toast('✅ Participant added (admin — no capacity limit)');
        document.getElementById('user-search').value = '';
        addQuery = '';
        renderAddResults([]);
        loadEvents();
      } catch (e) { toast('❌ Network error: ' + e.message, false); }
    }

    async function promoteWaitlist(wlId) {
      try {
        const r = await fetch(`/api/registrations/waitlist/${wlId}/promote`, { method:'POST', credentials:'same-origin' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast('❌ ' + (d.error || `Failed (${r.status})`), false); return; }
        toast(d.email_sent
          ? '✅ Promoted; email queued with the email provider'
          : '✅ Promoted, but email was not sent — check the player email and server logs', !d.email_sent);
        loadEvents();
      } catch (e) { toast('❌ Network error: ' + e.message, false); }
    }

    async function removeWaitlist(wlId) {
      if (!confirm('Remove this person from the waitlist?')) return;
      try {
        const r = await fetch(`/api/registrations/waitlist/${wlId}`, { method:'DELETE', credentials:'same-origin' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast('❌ ' + (d.error || `Failed (${r.status})`), false); return; }
        toast('✅ Removed from waitlist');
        loadEvents();
      } catch (e) { toast('❌ Network error: ' + e.message, false); }
    }

    // Admin assigns a training time; players can no longer choose one.
    async function assignSlot(regId, eventId, value) {
      try {
        const r = await fetch(`/api/registrations/${regId}/training-slot`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ training_slot: value === '' ? null : Number(value) }),
        });
        if (r.status === 401 || r.status === 403) {
          toast('❌ Session expired — please log in again', false);
          setTimeout(() => { window.location.href = '/login'; }, 1500);
          return;
        }
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast('❌ ' + (d.error || `Failed (${r.status})`), false); loadRegs(eventId); return; }
        toast(d.training_slot == null ? '✅ Training time cleared' : `✅ Training time set to ${SLOT_LABELS[d.training_slot]}`);
        loadRegs(eventId);
      } catch (e) { toast('❌ Network error: ' + e.message, false); }
    }

    async function removeReg(regId, eventId) {
      if (!confirm('Remove this participant from the event?\n\nThe registration will be cancelled.')) return;
      try {
        const r = await fetch(`/api/registrations/${regId}`, { method:'DELETE', credentials:'same-origin' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast('❌ ' + (d.error || `Failed (${r.status})`), false); return; }
        if (d.promoted) {
          toast(d.promoted.emailSent
            ? '✅ Participant removed; waitlisted player promoted and email queued with the email provider'
            : '✅ Participant removed and waitlisted player promoted, but their email was not sent', !d.promoted.emailSent);
        } else {
          toast('✅ Participant removed');
        }
        loadEvents();
      } catch (e) { toast('❌ Network error: ' + e.message, false); }
    }

    // ── Event CRUD ─────────────────────────────────────────
    async function createNewEvent() {
      const title = document.getElementById('ev-title').value;
      const date = document.getElementById('ev-date').value;
      const startH = parseInt(document.getElementById('ev-start').value, 10);
      const endH = parseInt(document.getElementById('ev-end').value, 10);
      if (!title) { alert('Please enter an event title'); return; }
      if (!date) { alert('Please pick a date'); return; }
      if (isNaN(startH) || isNaN(endH)) { alert('Please set start and end hour'); return; }
      if (startH < 6 || startH > 23 || endH < 6 || endH > 23) { alert('Hours must be between 6 and 23'); return; }
      if (endH <= startH) { alert('End hour must be after start hour'); return; }
      const startTime = String(startH).padStart(2, '0') + ':00';
      const endTime = String(endH).padStart(2, '0') + ':00';
      const feeSocial = Math.round(parseFloat(document.getElementById('ev-fee-social').value) * 100);
      const feeTraining = Math.round(parseFloat(document.getElementById('ev-fee-training').value) * 100);
      if (!Number.isFinite(feeSocial) || !Number.isFinite(feeTraining) || feeSocial < 0 || feeTraining < 0) {
        alert('Please enter valid fees'); return;
      }
      const paymentLink = document.getElementById('ev-pay-link').value.trim();
      const location = document.getElementById('ev-location').value.trim();
      const capacity = parseInt(document.getElementById('ev-capacity').value, 10);
      try {
        const r = await fetch('/api/events', {
          method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
          body: JSON.stringify({ title, event_date: date, start_time: startTime, end_time: endTime,
                                 location: location || null,
                                 capacity: Number.isFinite(capacity) ? capacity : 33,
                                 fee_social_cents: feeSocial, fee_training_cents: feeTraining,
                                 payment_link: paymentLink || null })
        });
        if (!r.ok) { const d = await r.json(); alert('Failed: ' + (d.error || r.status)); return; }
        toast('✅ Event created');
      } catch(e) { alert('Network error: ' + e.message); return; }
      document.getElementById('ev-title').value = '';
      document.getElementById('ev-date').value = '';
      document.getElementById('ev-pay-link').value = '';
      document.getElementById('ev-location').value = '';
      document.getElementById('ev-capacity').value = '33';
      document.getElementById('toggle-create').textContent = '＋ New Event';
      document.getElementById('create-card').classList.add('hidden');
      loadEvents();
    }

    async function patchEvent(id, patch) {
      await fetch(`/api/events/${id}`, {
        method:'PATCH', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
        body: JSON.stringify(patch)
      });
      loadEvents();
    }

    async function deleteEvent(id) {
      if (!confirm('Delete this event and all its registrations? This cannot be undone.')) return;
      await fetch(`/api/events/${id}`, { method: 'DELETE', credentials:'same-origin' });
      if (currentEventId === id) backToList();
      loadEvents();
    }

    // ── Payment review ─────────────────────────────────────
    async function setPayment(regId, eventId, status) {
      if (status === 'paid' && !confirm('Mark this participant as PAID?')) return;
      try {
        const r = await fetch(`/api/registrations/${regId}/payment`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ status }),
        });
        if (r.status === 401 || r.status === 403) {
          toast('❌ Session expired — please log in again', false);
          setTimeout(() => { window.location.href = '/login'; }, 1500);
          return;
        }
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast('❌ ' + (d.error || `Failed (${r.status})`), false); return; }
        toast(`✅ Payment marked ${status}`);
        loadRegs(eventId);
      } catch (e) { toast('❌ Network error: ' + e.message, false); }
    }

    async function viewProof(regId) {
      try {
        const r = await fetch(`/api/registrations/${regId}/proof`);
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast('❌ ' + (d.error || 'No proof available'), false); return; }
        document.getElementById('proof-img').src = d.proof;
        const when = d.submittedAt ? new Date(d.submittedAt).toLocaleString() : '';
        document.getElementById('proof-note').textContent =
          (d.note ? `Reference: ${d.note}` : '') + (when ? ` · Submitted ${when}` : '');
        document.getElementById('proof-modal').classList.remove('hidden');
      } catch (e) { toast('❌ Network error: ' + e.message, false); }
    }

    function closeProof() {
      document.getElementById('proof-modal').classList.add('hidden');
      document.getElementById('proof-img').src = '';
    }

    function copyUnpaid(eventId) {
      const rows = (regsByEvent[eventId] || [])
        .filter(r => ['unpaid', 'submitted'].includes(r.payment_status));
      if (!rows.length) { toast('Everyone has paid 🎉'); return; }
      const text = rows.map(r =>
        `${r.display_name} — ${money(r.fee_cents)} (${r.payment_status === 'submitted' ? 'proof awaiting review' : 'unpaid'})`
      ).join('\n');
      navigator.clipboard?.writeText(text)
        .then(() => toast(`📋 Copied ${rows.length} unpaid name(s)`))
        .catch(() => toast('❌ Copy failed — select the names manually', false));
    }

    // ── Match recording ──────────────────────────────────
    let matchPickerSlot = null; // 'ta1' | 'ta2' | 'tb1' | 'tb2'
    let matchSearchTimer = null;

    function renderMatchesSection() {
      const container = document.getElementById('detail-matches');
      if (!container) return;
      if (!currentEventId) { container.innerHTML = ''; return; }
      loadEventMatches(currentEventId);
    }

    async function loadEventMatches(eventId) {
      const container = document.getElementById('detail-matches');
      if (!container) return;
      try {
        const r = await fetch(`/api/matches?event_id=${eventId}`);
        if (!r.ok) { container.innerHTML = '<div class="text-muted" style="font-size:12px;">Cannot load matches</div>'; return; }
        const d = await r.json();
        const matches = d.matches || [];
        if (!matches.length) {
          container.innerHTML = '<div class="text-muted" style="font-size:12px;padding:12px 0;">No matches recorded yet — click "＋ Record Match" after a game finishes.</div>';
          return;
        }
        container.innerHTML = matches.map(m => {
          const winLabel = m.winner ? `Team ${m.winner} Won` : '未记录';
          const score = m.score_a != null ? `${m.score_a} – ${m.score_b}` : '';
          const ta1 = m.team_a_p1_name, ta2 = m.team_a_p2_name;
          const tb1 = m.team_b_p1_name, tb2 = m.team_b_p2_name;
          return `
            <div class="reg-row">
              <div class="reg-info" style="flex:1; min-width:0;">
                <div style="font-size:14px; font-weight:800; color:var(--n-800);">
                  ${ta1} &amp; ${ta2}
                  <span style="color:var(--n-400); font-weight:400;">vs.</span>
                  ${tb1} &amp; ${tb2}
                </div>
                <div class="reg-meta">
                  ${m.match_date}${m.match_time ? ' · ' + m.match_time : ''}
                  ${score ? ' · ' + score : ''}
                  · <span style="font-weight:700;">${winLabel}</span>
                </div>
              </div>
              <div class="reg-actions">
                <button class="btn btn-secondary btn-sm" onclick="editMatch(${m.id})">Edit</button>
                <button class="btn btn-danger btn-sm" onclick="deleteMatch(${m.id})">Delete</button>
              </div>
            </div>`;
        }).join('');
      } catch (e) {
        container.innerHTML = '<div class="text-muted" style="font-size:12px;">Error loading matches</div>';
      }
    }

    function openMatchEntry() {
      // Reset form
      document.getElementById('m-date').value = '';
      document.getElementById('m-time').value = '';
      document.getElementById('m-score-a').value = '';
      document.getElementById('m-score-b').value = '';
      document.getElementById('m-winner').value = '';
      document.getElementById('m-search').value = '';
      document.getElementById('m-search-results').innerHTML = '';
      clearMatchPlayer('ta1'); clearMatchPlayer('ta2');
      clearMatchPlayer('tb1'); clearMatchPlayer('tb2');
      matchPickerSlot = null;

      // Default match date to event date if we have it
      if (currentEventId && allEvents) {
        const ev = allEvents.find(e => e.id === currentEventId);
        if (ev) document.getElementById('m-date').value = ev.event_date;
      }
      document.getElementById('match-modal').classList.remove('hidden');
    }

    function closeMatchEntry() {
      document.getElementById('match-modal').classList.add('hidden');
    }

    function clearMatchPlayer(slot) {
      document.getElementById(`m-${slot}-id`).value = '';
      document.getElementById(`m-${slot}-name`).textContent = `Pick player ${slot[2]}…`;
      document.getElementById(`m-${slot}-name`).className = 'text-muted';
    }

    function onMatchSearch(value) {
      clearTimeout(matchSearchTimer);
      const q = value.trim();
      const resultsEl = document.getElementById('m-search-results');
      if (q.length < 2) { resultsEl.innerHTML = ''; return; }
      matchSearchTimer = setTimeout(async () => {
        try {
          const r = await fetch(`/api/matches/search-user?q=${encodeURIComponent(q)}`);
          const rows = r.ok ? await r.json() : [];
          if (!rows.length) { resultsEl.innerHTML = '<div class="text-muted" style="font-size:11px;padding:6px;">No matches</div>'; return; }
          resultsEl.innerHTML = rows.map(u => {
            const pickHtml = ['ta1','ta2','tb1','tb2'].map(slot =>
              `<button class="btn btn-secondary btn-sm" style="padding:2px 6px; margin-left:2px;" onclick="setMatchPlayer('${slot}',${u.id},'${u.display_name}')">→${slot.toUpperCase()}</button>`
            ).join('');
            return `<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--n-100); font-size:13px;">
              <span><strong>${u.display_name}</strong> <span class="text-muted" style="font-size:11px;">${u.username}</span></span>
              <span>${pickHtml}</span>
            </div>`;
          }).join('');
        } catch (e) { resultsEl.innerHTML = '<div class="text-muted" style="font-size:11px;">Error</div>'; }
      }, 250);
    }

    function setMatchPlayer(slot, id, name) {
      // Remove from other slots if selected there
      ['ta1','ta2','tb1','tb2'].forEach(s => {
        if (s !== slot && document.getElementById(`m-${s}-id`).value === String(id)) {
          clearMatchPlayer(s);
        }
      });
      document.getElementById(`m-${slot}-id`).value = id;
      document.getElementById(`m-${slot}-name`).textContent = name;
      document.getElementById(`m-${slot}-name`).className = '';
      document.getElementById('m-search').value = '';
      document.getElementById('m-search-results').innerHTML = '';
    }

    async function submitMatchEntry() {
      const date = document.getElementById('m-date').value;
      const time = document.getElementById('m-time').value;
      const a1 = Number(document.getElementById('m-ta1-id').value);
      const a2 = Number(document.getElementById('m-ta2-id').value);
      const b1 = Number(document.getElementById('m-tb1-id').value);
      const b2 = Number(document.getElementById('m-tb2-id').value);
      const scoreA = document.getElementById('m-score-a').value;
      const scoreB = document.getElementById('m-score-b').value;
      const winner = document.getElementById('m-winner').value;

      if (!currentEventId) { toast('❌ No event context', false); return; }
      if (!date) { toast('❌ Match date required', false); return; }
      if (![a1, a2, b1, b2].every(Number.isInteger)) {
        toast('❌ Please pick all 4 players', false); return;
      }
      if (new Set([a1, a2, b1, b2]).size !== 4) {
        toast('❌ All players must be distinct', false); return;
      }
      const body = {
        event_id: currentEventId,
        match_date: date,
        match_time: time || null,
        team_a_p1_id: a1, team_a_p2_id: a2,
        team_b_p1_id: b1, team_b_p2_id: b2,
        score_a: scoreA ? Number(scoreA) : null,
        score_b: scoreB ? Number(scoreB) : null,
        winner: winner || null,
      };
      try {
        const r = await fetch('/api/matches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast('❌ ' + (d.error || `Failed (${r.status})`), false); return; }
        closeMatchEntry();
        toast('✅ Match recorded');
        renderMatchesSection();
      } catch (e) { toast('❌ Network error: ' + e.message, false); }
    }

    async function editMatch(matchId) {
      // For now, prompt a simple confirmation + soft-delete flow is sufficient.
      // A full edit UI can come later — the API already supports PATCH.
      if (!confirm('Edit match? The current UI only supports delete. Delete this match instead?')) return;
      deleteMatch(matchId);
    }

    async function deleteMatch(matchId) {
      if (!confirm('Delete this match record? (Soft-delete — stats will no longer include it.)')) return;
      try {
        const r = await fetch(`/api/matches/${matchId}`, {
          method: 'DELETE', credentials: 'same-origin',
        });
        if (!r.ok) { toast('❌ Failed to delete', false); return; }
        toast('✅ Match deleted');
        renderMatchesSection();
      } catch (e) { toast('❌ Network error', false); }
    }

    // ── Socket connection for Activate / Finish ────────────
    const socket = (typeof io !== 'undefined') ? io() : null;

    let toastTimer = null;
    function toast(msg, ok = true) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'toast show ' + (ok ? 'ok' : 'err');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
    }

    if (socket) {
      socket.on('activate_success', ({ title }) => {
        toast(`✅ "${title}" is now active. Board loaded with registrants.`);
        loadEvents();
      });
      socket.on('activate_error', ({ reason }) => {
        const map = { not_found: 'Event not found', not_admin: 'Admin only' };
        toast('❌ Activate failed: ' + (map[reason] || reason), false);
      });
      socket.on('finish_success', ({ title }) => {
        toast(`✅ "${title}" finished. Board cleared.`);
        loadEvents();
      });
      socket.on('finish_error', ({ reason, current }) => {
        const map = { not_found: 'Event not found', not_active: `Event is ${current}, not active` };
        toast('❌ Finish failed: ' + (map[reason] || reason), false);
      });
    }

    function activateFromDashboard(id) {
      if (!socket) { toast('❌ Socket not connected', false); return; }
      if (!confirm('Activate this event now?\n\nAll registrants will be loaded into the live board queue, and any previously active event will be marked finished.')) return;
      socket.emit('activate_event', { eventId: id });
    }

    function finishEvent(id) {
      if (!socket) { toast('❌ Socket not connected', false); return; }
      if (!confirm('Finish this event?\n\nIt will be marked as finished and the live board will be cleared.')) return;
      socket.emit('finish_event', { eventId: id });
    }

    document.getElementById('logout').onclick = async (e) => {
      e.preventDefault();
      await fetch('/api/auth/logout', { method:'POST' });
      window.location.href = '/login';
    };

    loadMe().then(loadEvents);
