// Derived-table rebuild console - client.
// Polls /api/state and renders. Every duration, percentage and verification
// result on screen comes from the server's real partition scan checkpoints.

const $ = (id) => document.getElementById(id);

const money0 = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 0 });
const money2 = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num0 = new Intl.NumberFormat('zh-CN');

const compact = (value) => {
  const abs = Math.abs(value || 0);
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(1)} 万`;
  return num0.format(Math.round(value || 0));
};

// Axis ticks: one consistent unit per axis, compact enough for the gutter.
const axisCompact = (value) => {
  const abs = Math.abs(value || 0);
  if (abs >= 1e8) return `${(value / 1e8).toFixed(1)}亿`;
  if (abs >= 1e4) return `${Math.round(value / 1e4)}万`;
  return num0.format(Math.round(value));
};

const fmtMoney = (cents) => (Math.abs(cents || 0) >= 1e9 ? money0.format((cents || 0) / 100) : money2.format((cents || 0) / 100));
const fmtTime = (at) => (at ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) : '—');
const fmtDateTime = (at) => (at ? new Date(at).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const pct = (value) => `${Math.round((value || 0) * 100)}%`;

const STAGE_SHORT = { build: '构建', verify: '复核', built: '待复核', '': '排队' };
const STATE_SHORT = {
  pending: '待构建',
  building: '构建中',
  built: '待复核',
  verifying: '复核中',
  verified: '已核对',
  failed: '失败',
  paused: '已暂停',
  reclaimed: '已回收',
};

let state = null;
let faultRows = [];
let lastComparingKey = '';
let pollTimer = null;
let pollBusy = false;
let tableOpen = false;
let lastErrorShown = '';
let metaRendered = false;
let launching = false;

// ---------------- network ----------------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `请求失败（${res.status}）`);
    error.status = res.status;
    error.readers = data.readers;
    throw error;
  }
  return data;
}

function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), isError ? 5200 : 3000);
}

async function refresh() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    state = await api('/api/state');
    render();
    lastErrorShown = '';
  } catch (error) {
    if (lastErrorShown !== error.message) {
      lastErrorShown = error.message;
      toast(`刷新失败：${error.message}`, true);
    }
  } finally {
    pollBusy = false;
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = state?.builds?.some((b) => b.status === 'running' || b.status === 'queued');
  const delay = busy ? 450 : 1600;
  pollTimer = setTimeout(async () => {
    await refresh();
    schedulePoll();
  }, delay);
}

// ---------------- render root ----------------

function render() {
  if (!state) return;
  renderVisible();
  renderLaunchMeta();
  renderLeaseGenerationOptions();
  renderBuilds();
  renderCompare();
  renderHistory();
  renderLeases();
  renderEvents();
}

// ---------------- visible / hero ----------------

function renderVisible() {
  const v = state.visible;
  $('visible-generation').textContent = v.generation ? `代次 ${v.generation}` : '无可见代次';
  const build = state.builds.find((b) => b.id === v.buildId);
  $('visible-status').textContent = v.generation
    ? `读入口在线 · ${build?.status === 'complete' ? '所有必要分区已核对' : '结果已核对并启用'}`
    : '尚未建立可读代次';
  $('visible-bind').textContent = `源数据 v${v.sourceVersion ?? '—'} · 规则 v${v.ruleVersion ?? '—'}`;
  $('visible-note').textContent = v.note ? `备注：${v.note}` : '';

  const summary = v.summary || {};
  $('visible-amounts').innerHTML = '';
  const cells = [
    ['订单毛额', summary.grossCents],
    ['退款额', summary.refundCents],
    ['手续费', summary.feeCents],
    ['净额', summary.netCents],
    ['订单数', summary.orderCount ? num0.format(summary.orderCount) : null],
  ];
  for (const [label, value] of cells) {
    const cell = document.createElement('div');
    cell.className = 'amount-cell';
    const l = document.createElement('div');
    l.className = 'a-label';
    l.textContent = label;
    const val = document.createElement('div');
    val.className = 'a-value';
    val.textContent =
      value === null || value === undefined ? '—' : typeof value === 'number' ? fmtMoney(value) : value;
    cell.append(l, val);
    $('visible-amounts').append(cell);
  }

  $('latest-generation').textContent = state.latestGeneration ? `代次 ${state.latestGeneration}` : '—';
  $('visible-leases').textContent = `${v.liveLeases ?? 0} 个`;
  $('switched-at').textContent = fmtDateTime(v.switchedAt);
}

// ---------------- launch form ----------------

function renderLaunchMeta() {
  if (!metaRendered) {
    const sourceSelect = $('source-version');
    sourceSelect.innerHTML = '';
    for (const v of state.sourceVersions) {
      const option = document.createElement('option');
      option.value = v.version;
      option.textContent = v.label;
      sourceSelect.append(option);
    }
    sourceSelect.value = String(state.settings.defaultSourceVersion ?? state.sourceVersions[0]?.version ?? 1);

    const ruleSelect = $('rule-version');
    ruleSelect.innerHTML = '';
    for (const r of state.rules) {
      const option = document.createElement('option');
      option.value = r.version;
      option.textContent = `v${r.version} · ${r.label}`;
      ruleSelect.append(option);
    }
    ruleSelect.value = String(state.rules[0]?.version ?? 1);

    const faultSelect = $('fault-partition');
    faultSelect.innerHTML = '';
    for (const p of state.structure.partitions) {
      const option = document.createElement('option');
      option.value = String(p.no);
      option.textContent = `分区 ${p.no}（第 ${p.startDay + 1}–${p.endDay + 1} 天）`;
      faultSelect.append(option);
    }

    const defaults = state.settings;
    $('opt-partition-ms').value = defaults.partitionMs;
    $('opt-verify-ms').value = defaults.verifyMs;
    $('opt-concurrency').value = defaults.concurrency;
    metaRendered = true;
  }
  updateHints();
  $('next-generation-tag').textContent = `下一个代次 ${state.latestGeneration + 1}`;
  $('launch-hint').textContent = `将创建代次 ${state.latestGeneration + 1}，共 12 个分区`;
}

// Hints are a pure function of the current form values, so they stay correct
// even when the value never changed (no `change` event fires in that case).
function updateHints() {
  if (!state) return;
  const source = state.sourceVersions.find((v) => String(v.version) === $('source-version').value);
  $('source-hint').textContent = source?.detail ?? '';
  const rule = state.rules.find((r) => String(r.version) === $('rule-version').value);
  $('rule-hint').textContent = rule
    ? `窗口 ${rule.windowDays} 天 · 费率 ${(rule.feeBps / 100).toFixed(2)}% · ${rule.includeContested ? '计入争议退款' : '排除争议退款'}`
    : '';
}

function renderFaultRows() {
  const host = $('fault-rows');
  host.innerHTML = '';
  if (!faultRows.length) {
    const empty = document.createElement('div');
    empty.className = 'fault-empty';
    empty.textContent = '未注入故障：所有分区会完整构建并独立复核。';
    host.append(empty);
    return;
  }
  faultRows.forEach((fault, index) => {
    const row = document.createElement('div');
    row.className = 'fault-row';
    const desc = document.createElement('span');
    desc.className = 'fault-desc';
    if (fault.mode === 'corrupt') {
      desc.textContent = `分区 ${fault.partition} · 篡改构建产物（首次尝试）`;
    } else if (fault.mode === 'slow') {
      desc.textContent = `分区 ${fault.partition} · 放慢构建至 ${fault.slowMs}ms`;
    } else {
      const stageName = fault.stage === 'verify' ? '复核' : '构建';
      desc.textContent = `分区 ${fault.partition} · ${stageName}阶段${fault.mode === 'always' ? '持续' : '单次'}故障 @ ${fault.at}%`;
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn tiny ghost';
    remove.textContent = '移除';
    remove.addEventListener('click', () => {
      faultRows.splice(index, 1);
      renderFaultRows();
    });
    row.append(desc, remove);
    host.append(row);
  });
}

function addFault() {
  const partition = Number($('fault-partition').value);
  const mode = $('fault-mode').value;
  const stage = $('fault-stage').value;
  const at = Math.min(98, Math.max(5, Number($('fault-at').value) || 50));
  if (faultRows.length >= 8) {
    toast('最多注入 8 条故障', true);
    return;
  }
  if (mode === 'slow') {
    faultRows.push({ partition, mode: 'slow', stage, slowMs: 9000 });
  } else if (mode === 'corrupt') {
    faultRows.push({ partition, mode: 'corrupt', stage });
  } else {
    faultRows.push({ partition, mode, stage, at });
  }
  renderFaultRows();
  $('advanced').open = true;
}

function numberInRange(id, min, max) {
  const raw = Number($(id).value);
  if (!Number.isFinite(raw)) return undefined;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

function optionsFromForm() {
  const failures = [];
  const slow = [];
  const corrupt = [];
  for (const fault of faultRows) {
    if (fault.mode === 'slow') slow.push({ partition: fault.partition, buildMs: fault.slowMs });
    else if (fault.mode === 'corrupt') corrupt.push(fault.partition);
    else failures.push({ partition: fault.partition, stage: fault.stage, mode: fault.mode, at: fault.at / 100 });
  }
  return {
    partitionMs: numberInRange('opt-partition-ms', 400, 120000),
    verifyMs: numberInRange('opt-verify-ms', 200, 120000),
    concurrency: numberInRange('opt-concurrency', 1, 12),
    failures,
    slow,
    corrupt,
  };
}

async function launchBuild(event) {
  event.preventDefault();
  if (launching) return;
  const btn = $('launch-btn');
  const errorBox = $('launch-error');
  errorBox.hidden = true;

  // Read the form synchronously: a poll re-render must never change what a
  // click submits, and a second click must not be dropped by disabled timing.
  const body = {
    sourceVersion: Number($('source-version').value),
    ruleVersion: Number($('rule-version').value),
    note: $('build-note').value.trim(),
    options: optionsFromForm(),
  };
  if (!state?.sourceVersions?.length) {
    errorBox.textContent = '页面尚未加载完成，请稍后再试';
    errorBox.hidden = false;
    return;
  }

  launching = true;
  btn.disabled = true;
  try {
    const { build } = await api('/api/builds', { method: 'POST', body });
    $('build-note').value = '';
    faultRows = [];
    renderFaultRows();
    toast(`已发起代次 ${build.generation}（源 v${build.sourceVersion} / 规则 v${build.ruleVersion}）`);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    launching = false;
    btn.disabled = false;
  }
  await refresh();
  schedulePoll();
}

// ---------------- leases ----------------

function renderLeaseGenerationOptions() {
  const select = $('lease-generation');
  const previous = select.value;
  select.innerHTML = '';
  const options = [];
  if (state.visible.generation) options.push({ generation: state.visible.generation, label: `代次 ${state.visible.generation}（当前可见）` });
  for (const h of state.history) {
    if (h.generation === state.visible.generation) continue;
    if (!h.completedAt || h.reclaimedAt) continue;
    options.push({ generation: h.generation, label: `代次 ${h.generation}（${h.statusLabel}）` });
  }
  for (const option of options) {
    const el = document.createElement('option');
    el.value = String(option.generation);
    el.textContent = option.label;
    select.append(el);
  }
  if (options.some((o) => String(o.generation) === previous)) select.value = previous;
}

async function openLease(event) {
  event.preventDefault();
  try {
    const readerId = $('lease-reader').value.trim();
    const generation = Number($('lease-generation').value);
    const ttlMs = Number($('lease-ttl').value);
    const lease = await api('/api/leases', {
      method: 'POST',
      body: { readerId, generation, ttlMs, purpose: '对照旧代次 / 只读查询' },
    });
    toast(`读者 ${lease.readerId} 已打开代次 ${lease.generation}，租约 ${Math.round(ttlMs / 1000)}s`);
    await refresh();
  } catch (error) {
    toast(error.message, true);
  }
}

async function closeLease(leaseId) {
  try {
    await api(`/api/leases/${leaseId}`, { method: 'DELETE' });
    await refresh();
  } catch (error) {
    toast(error.message, true);
  }
}

function renderLeases() {
  const host = $('lease-list');
  host.innerHTML = '';
  if (!state.leases.length) {
    const empty = document.createElement('div');
    empty.className = 'lease-empty';
    empty.textContent = '还没有读者持有租约。回收旧代次时，活跃租约会让回收被拒绝。';
    host.append(empty);
    return;
  }
  for (const lease of state.leases) {
    const item = document.createElement('div');
    item.className = `lease-item${lease.active ? '' : ' expired'}`;
    const reader = document.createElement('span');
    reader.className = 'reader';
    reader.textContent = lease.readerId;
    const meta = document.createElement('span');
    meta.className = 'lease-meta';
    meta.textContent = lease.active
      ? `代次 ${lease.generation} · 剩余 ${Math.ceil(lease.msLeft / 1000)}s`
      : lease.releasedAt
        ? `代次 ${lease.generation} · 已释放`
        : `代次 ${lease.generation} · 已过期`;
    item.append(reader, meta);
    if (lease.active) {
      const bar = document.createElement('span');
      bar.className = 'bar';
      const fill = document.createElement('i');
      const total = Math.max(1, lease.expiresAt - lease.acquiredAt);
      fill.style.width = `${Math.max(2, Math.min(100, (lease.msLeft / total) * 100))}%`;
      bar.append(fill);
      item.append(bar);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'btn tiny ghost';
      close.textContent = '关闭';
      close.addEventListener('click', () => closeLease(lease.id));
      item.append(close);
    }
    host.append(item);
  }
}

// ---------------- builds ----------------

function renderBuilds() {
  const host = $('builds');
  host.innerHTML = '';
  $('builds-empty').hidden = state.builds.length > 0;
  const ordered = [...state.builds].sort((a, b) => b.generation - a.generation);
  for (const build of ordered) host.append(buildCard(build));
}

function buildCard(build) {
  const card = document.createElement('article');
  card.className = `build-card${build.isVisible ? ' is-visible' : ''}${build.status === 'superseded' ? ' is-superseded' : ''}${build.status === 'reclaimed' ? ' is-reclaimed' : ''}`;

  const head = document.createElement('div');
  head.className = 'build-head';

  const badge = document.createElement('div');
  badge.className = 'gen-badge';
  badge.textContent = build.generation;
  badge.title = `代次 ${build.generation}`;

  const title = document.createElement('div');
  title.className = 'build-title';
  const line1 = document.createElement('div');
  line1.className = 'line1';
  const gtitle = document.createElement('span');
  gtitle.className = 'gtitle';
  gtitle.textContent = `代次 ${build.generation}${build.isVisible ? ' · 当前读入口' : ''}`;
  const chip = document.createElement('span');
  chip.className = `status-chip ${build.status}`;
  chip.textContent = build.statusLabel;
  line1.append(gtitle, chip);
  if (build.supersededByGeneration) {
    const rel = document.createElement('span');
    rel.className = 'status-chip superseded';
    rel.textContent = `被代次 ${build.supersededByGeneration} 替代`;
    line1.append(rel);
  }
  const bind = document.createElement('div');
  bind.className = 'bind';
  bind.textContent = `源 v${build.sourceVersion} · 规则 v${build.ruleVersion} · 并发 ${build.options.concurrency} · 构建 ${build.options.partitionMs}ms / 复核 ${build.options.verifyMs}ms`;
  title.append(line1, bind);

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  const progress = document.createElement('div');
  progress.className = 'progress-wrap';
  const plabel = document.createElement('div');
  plabel.className = 'progress-label';
  plabel.innerHTML = build.status === 'reclaimed'
    ? '<span>分区产物已回收</span><span>汇总保留</span>'
    : `<span>已核对</span><span>${build.partitionsVerified} / ${build.partitionsTotal}</span>`;
  const track = document.createElement('div');
  track.className = 'progress-track';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = `${(build.partitionsVerified / Math.max(1, build.partitionsTotal)) * 100}%`;
  track.append(fill);
  progress.append(plabel, track);

  const actions = document.createElement('div');
  actions.className = 'build-actions';
  if (build.canPause) {
    actions.append(actionButton('暂停任务', () => buildAction(build.id, 'pause'), false));
  }
  if (build.canResume) {
    actions.append(actionButton('恢复当前任务', () => buildAction(build.id, 'resume'), true));
  }
  if (!build.isLatest && build.canResume === false && state.latestGeneration === build.generation) {
    // noop
  }
  head.append(badge, title, spacer, progress, actions);
  card.append(head);

  const grid = document.createElement('div');
  grid.className = 'part-grid';
  for (const part of build.partitions) grid.append(partitionCell(build, part));
  card.append(grid);

  if (build.note) {
    const note = document.createElement('div');
    note.className = 'build-note';
    note.textContent = `备注：${build.note}`;
    card.append(note);
  }
  const failedParts = build.partitions.filter((p) => p.status === 'failed');
  if (failedParts.length) {
    const err = document.createElement('div');
    err.className = 'build-error';
    err.textContent = `失败分区：${failedParts.map((p) => `${p.no}（${p.error || '未知原因'}）`).join('；')}`;
    card.append(err);
  }
  return card;
}

function actionButton(label, handler, primary) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn small${primary ? ' primary' : ''}`;
  button.textContent = label;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await handler();
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function partitionCell(build, part) {
  const cell = document.createElement('div');
  cell.className = `part ${part.status}`;
  cell.title = `分区 ${part.no}：第 ${part.no * 30 - 29}–${part.no * 30} 天输出窗口，回溯 90 天；${STATE_SHORT[part.status] || part.status}${part.error ? `；${part.error}` : ''}`;

  const top = document.createElement('div');
  top.className = 'part-top';
  const no = document.createElement('span');
  no.className = 'part-no';
  no.textContent = part.no;
  const stateLabel = document.createElement('span');
  stateLabel.className = 'part-state';
  stateLabel.textContent = STATE_SHORT[part.status] || part.status;
  top.append(no, stateLabel);

  const pctLabel = document.createElement('div');
  pctLabel.className = 'part-pct';
  pctLabel.textContent =
    part.status === 'verified'
      ? `校验值 ${(part.verified?.checkValue >>> 0).toString(16).slice(-6).padStart(6, '0')}`
      : part.status === 'failed'
        ? '中断'
        : part.status === 'reclaimed'
          ? '汇总保留'
          : `${pct(part.pct)} · ${num0.format(part.rowsDone)} 行`;

  const bar = document.createElement('div');
  bar.className = 'part-bar';
  const fill = document.createElement('i');
  fill.style.width = `${Math.max(part.status === 'pending' || part.status === 'reclaimed' ? 0 : 2, part.pct * 100)}%`;
  bar.append(fill);

  const flags = document.createElement('div');
  flags.className = 'part-flags';
  if (part.plannedFailure) {
    flags.append(flag(`${part.plannedFailure.mode === 'always' ? '持续' : '单次'}故障 @${Math.round(part.plannedFailure.at * 100)}%`, 'plan'));
  }
  if (part.corruptOnBuild) flags.append(flag('篡改产物', 'corrupt'));
  if (part.status === 'paused') flags.append(flag('检查点保留', 'pause'));
  if (part.status === 'verifying') flags.append(flag('独立重扫', 'pause'));
  if (part.status === 'reclaimed') flags.append(flag('产物已释放', 'pause'));

  const actions = document.createElement('div');
  actions.className = 'part-actions';
  if (part.canPause && !['verified', 'failed', 'paused'].includes(part.status)) {
    actions.append(partButton('暂停', () => partitionAction(build.id, part.no, 'pause')));
  }
  if (part.status === 'paused') {
    actions.append(partButton('继续', () => partitionAction(build.id, part.no, 'resume')));
  }
  if (part.status === 'failed') {
    actions.append(partButton('重试', () => partitionAction(build.id, part.no, 'retry')));
  }

  cell.append(top, pctLabel, bar, flags);
  if (actions.childElementCount) cell.append(actions);
  return cell;
}

function flag(text, kind) {
  const el = document.createElement('span');
  el.className = `part-flag ${kind}`;
  el.textContent = text;
  return el;
}

function partButton(label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn';
  button.textContent = label;
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    button.disabled = true;
    try {
      await handler();
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

async function buildAction(buildId, action) {
  try {
    await api(`/api/builds/${buildId}/${action}`, { method: 'POST' });
    toast(action === 'pause' ? '任务已暂停' : '任务已恢复');
    await refresh();
    schedulePoll();
  } catch (error) {
    toast(error.message, true);
  }
}

async function partitionAction(buildId, no, action) {
  try {
    await api(`/api/builds/${buildId}/partitions/${no}/${action}`, { method: 'POST' });
    const labels = { pause: `分区 ${no} 已暂停，检查点保留`, resume: `分区 ${no} 已继续`, retry: `分区 ${no} 已重新排队` };
    toast(labels[action] || '已操作');
    await refresh();
    schedulePoll();
  } catch (error) {
    toast(error.message, true);
  }
}

// ---------------- compare chart ----------------

function renderCompare() {
  const select = $('compare-generation');
  const eligible = state.history.filter((h) => h.completedAt && h.generation !== state.visible.generation);
  const currentKey = eligible.map((h) => h.generation).join(',');
  if (currentKey !== lastComparingKey) {
    const previous = select.value;
    select.innerHTML = '';
    for (const h of eligible) {
      const option = document.createElement('option');
      option.value = String(h.generation);
      option.textContent = `代次 ${h.generation}${h.reclaimedAt ? '（已回收，汇总保留）' : ''}`;
      select.append(option);
    }
    if (eligible.some((h) => String(h.generation) === previous)) select.value = previous;
    lastComparingKey = currentKey;
  }

  const host = $('compare-summary');
  host.innerHTML = '';
  const compareGen = Number(select.value);
  const compareEntry = eligible.find((h) => h.generation === compareGen);
  const visibleEntry = state.history.find((h) => h.generation === state.visible.generation);
  const visibleSummary = state.visible.summary;

  if (!visibleSummary || !compareEntry || !compareEntry.summary) {
    $('chart-caption').textContent = '需要至少两个已完成的代次才能比较。';
    $('chart-legend').innerHTML = '';
    $('chart-host').innerHTML = '';
    $('compare-table').innerHTML = '';
    host.append(summaryCell('说明', '完成一次重建后，这里会按分区比较新旧代次的净额。'));
    return;
  }

  const diff = compareEntry.summary.netCents - visibleSummary.netCents;
  const diffPct = visibleSummary.netCents ? (diff / visibleSummary.netCents) * 100 : 0;
  host.append(
    summaryCell(`代次 ${visibleSummary ? state.visible.generation : '—'} 净额`, fmtMoney(visibleSummary.netCents)),
    summaryCell(`代次 ${compareEntry.generation} 净额`, fmtMoney(compareEntry.summary.netCents)),
    summaryCell('差额（旧 − 新）', `${diff >= 0 ? '+' : ''}${fmtMoney(diff)} · ${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%`),
    summaryCell('退款差额', `${compareEntry.summary.refundCents - visibleSummary.refundCents >= 0 ? '+' : ''}${fmtMoney(compareEntry.summary.refundCents - visibleSummary.refundCents)}`),
  );

  const visibleParts = buildPartsSummary(state.visible.buildId);
  const compareParts = buildPartsSummary(compareEntry.buildId, compareEntry.summary, compareEntry.partitionsVerified);
  drawCompareChart(visibleParts, compareParts, state.visible.generation, compareEntry.generation);
  renderCompareTable(visibleParts, compareParts, state.visible.generation, compareEntry.generation);
}

function summaryCell(label, value) {
  const cell = document.createElement('div');
  cell.className = 'cs-cell';
  const l = document.createElement('div');
  l.className = 'cs-label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'cs-value';
  v.textContent = value;
  cell.append(l, v);
  return cell;
}

// Partition-level series for the chart. Uses the stored per-partition
// aggregates; a reclaimed generation keeps only the table-level summary.
function buildPartsSummary(buildId, fallbackSummary, verifiedCount = 12) {
  const build = state.builds.find((b) => b.id === buildId);
  if (build && build.partitions.every((p) => p.agg)) {
    return build.partitions.map((p) => ({ no: p.no, net: p.agg.netCents, refund: p.agg.refundCents }));
  }
  if (fallbackSummary) {
    const per = fallbackSummary.netCents / Math.max(1, verifiedCount);
    const perRefund = fallbackSummary.refundCents / Math.max(1, verifiedCount);
    return Array.from({ length: verifiedCount }, (_, i) => ({ no: i + 1, net: per, refund: perRefund, estimated: true }));
  }
  return [];
}

function drawCompareChart(visibleParts, compareParts, visibleGen, compareGen) {
  const host = $('chart-host');
  host.innerHTML = '';
  $('chart-legend').innerHTML = '';
  if (!visibleParts.length || !compareParts.length) {
    $('chart-caption').textContent = '分区级数据不可用（代次已回收，仅保留汇总）。';
    return;
  }

  const width = host.clientWidth || 640;
  const height = 250;
  const margin = { top: 16, right: 14, bottom: 26, left: 66 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const n = Math.max(visibleParts.length, compareParts.length);
  const band = innerW / n;
  const barW = Math.min(12, Math.max(4, band * 0.34));
  const gap = 2;

  const values = [...visibleParts.map((p) => p.net), ...compareParts.map((p) => p.net)];
  const maxValue = Math.max(1, ...values);
  const yMax = niceMax(maxValue);
  const y = (v) => innerH - (v / yMax) * innerH;

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': '按分区的净额对比' });

  // gridlines + y ticks
  const ticks = 4;
  for (let i = 0; i <= ticks; i += 1) {
    const value = (yMax / ticks) * i;
    const yy = margin.top + y(value);
    svg.append(svgEl('line', {
      x1: margin.left,
      x2: margin.left + innerW,
      y1: yy,
      y2: yy,
      stroke: 'var(--grid)',
      'stroke-width': 1,
    }));
    const label = svgEl('text', {
      x: margin.left - 8,
      y: yy + 3.5,
      'text-anchor': 'end',
      'font-size': 10,
      fill: 'var(--text-muted)',
      'font-variant-numeric': 'tabular-nums',
    });
    label.textContent = axisCompact(value / 100);
    svg.append(label);
  }

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.hidden = true;

  // A reclaimed generation keeps only its table-level summary. Its per-partition
  // series is the summary split evenly, not a real partition scan, so it is drawn
  // with a hatch so the flat bars cannot be read as measured values.
  const estimated = Boolean((compareParts[0] && compareParts[0].estimated) || (visibleParts[0] && visibleParts[0].estimated));
  if (estimated) {
    const defs = svgEl('defs', {});
    const pattern = svgEl('pattern', {
      id: 'hatch-estimated', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
    });
    pattern.append(
      svgEl('rect', { width: 6, height: 6, fill: 'var(--surface-raised)' }),
      svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--series-2)', 'stroke-width': 3 }),
    );
    defs.append(pattern);
    svg.append(defs);
  }
  const estimatedFill = estimated ? 'url(#hatch-estimated)' : 'var(--series-2)';

  for (let i = 0; i < n; i += 1) {
    const vp = visibleParts[i];
    const cp = compareParts[i];
    const baseX = margin.left + band * i + band / 2;
    const group = svgEl('g', {});
    if (vp) {
      group.append(barRect(baseX - barW - gap / 2, margin.top + y(vp.net), barW, innerH - y(vp.net), 'var(--series-1)'));
    }
    if (cp) {
      group.append(barRect(baseX + gap / 2, margin.top + y(cp.net), barW, innerH - y(cp.net), cp.estimated ? estimatedFill : 'var(--series-2)'));
    }
    const hit = svgEl('rect', {
      x: margin.left + band * i,
      y: margin.top,
      width: band,
      height: innerH,
      fill: 'transparent',
      tabindex: 0,
      role: 'button',
      'aria-label': `分区 ${vp?.no ?? cp?.no}`,
    });
    const show = (event) => {
      tooltip.hidden = false;
      const rect = host.getBoundingClientRect();
      const px = event.clientX !== undefined
        ? event.clientX - rect.left
        : margin.left + band * i + band / 2;
      tooltip.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'tt-title';
      title.textContent = `分区 ${vp?.no ?? cp?.no}`;
      tooltip.append(title);
      if (vp) tooltip.append(tooltipRow('var(--series-1)', `代次 ${visibleGen}`, fmtMoney(vp.net)));
      if (cp) tooltip.append(tooltipRow('var(--series-2)', `代次 ${compareGen}${cp.estimated ? '（汇总均摊）' : ''}`, fmtMoney(cp.net)));
      if (vp && cp) tooltip.append(tooltipRow(null, '差额（旧−新）', `${cp.net - vp.net >= 0 ? '+' : ''}${fmtMoney(cp.net - vp.net)}`));
      const left = Math.max(4, Math.min(width - 172, px + 10));
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${margin.top + 4}px`;
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerleave', () => { tooltip.hidden = true; });
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', () => { tooltip.hidden = true; });
    group.append(hit);
    svg.append(group);

    const xlabel = svgEl('text', {
      x: baseX,
      y: height - 8,
      'text-anchor': 'middle',
      'font-size': 10,
      fill: 'var(--text-muted)',
      'font-variant-numeric': 'tabular-nums',
    });
    xlabel.textContent = `P${vp?.no ?? cp?.no}`;
    svg.append(xlabel);
  }

  // baseline
  svg.append(svgEl('line', {
    x1: margin.left,
    x2: margin.left + innerW,
    y1: margin.top + innerH,
    y2: margin.top + innerH,
    stroke: 'var(--baseline)',
    'stroke-width': 1,
  }));

  host.append(svg, tooltip);
  $('chart-caption').textContent = estimated
    ? `各分区净额：代次 ${visibleGen} 与代次 ${compareGen}。斜纹柱为已回收代次按汇总均摊，非实测分区值；悬停查看明细。`
    : `各分区净额：代次 ${visibleGen} 与代次 ${compareGen}。柱高为分区净额，悬停查看明细。`;
  $('chart-legend').append(
    legendItem('var(--series-1)', `代次 ${visibleGen}（可见）`),
    legendItem('var(--series-2)', `代次 ${compareGen}（对照）`),
  );
}

function barRect(x, y, w, h, fill) {
  const height = Math.max(0, h);
  if (height < 0.5) return svgEl('rect', { x, y: y - 0.5, width: w, height: 0.5, fill });
  // 4px rounded data-end, square at baseline
  const r = Math.min(4, w / 2, height);
  const bottom = y + height;
  const d = `M${x},${bottom} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${bottom} Z`;
  return svgEl('path', { d, fill });
}

function legendItem(color, label) {
  const span = document.createElement('span');
  span.className = 'legend-item';
  const sw = document.createElement('span');
  sw.className = 'swatch';
  sw.style.background = color;
  const text = document.createElement('span');
  text.textContent = label;
  span.append(sw, text);
  return span;
}

function tooltipRow(color, label, value) {
  const row = document.createElement('div');
  row.className = 'tt-row';
  const key = document.createElement('span');
  key.className = 'tt-key';
  if (color) {
    const line = document.createElement('i');
    line.style.background = color;
    key.append(line);
  }
  key.append(document.createTextNode(label));
  const val = document.createElement('span');
  val.className = 'tt-val';
  val.textContent = value;
  row.append(key, val);
  return row;
}

function niceMax(value) {
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * base;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) el.setAttribute(key, String(value));
  }
  return el;
}

function renderCompareTable(visibleParts, compareParts, visibleGen, compareGen) {
  const host = $('compare-table');
  host.className = `table-wrap compare-table`;
  host.hidden = !tableOpen;
  host.innerHTML = '';
  if (!visibleParts.length && !compareParts.length) return;
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const text of ['分区', `代次 ${visibleGen} 净额`, `代次 ${compareGen} 净额`, '差额（旧−新）']) {
    const th = document.createElement('th');
    th.textContent = text;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = document.createElement('tbody');
  const n = Math.max(visibleParts.length, compareParts.length);
  for (let i = 0; i < n; i += 1) {
    const vp = visibleParts[i];
    const cp = compareParts[i];
    const tr = document.createElement('tr');
    const cells = [
      `分区 ${vp?.no ?? cp?.no}`,
      vp ? fmtMoney(vp.net) : '—',
      cp ? `${fmtMoney(cp.net)}${cp.estimated ? ' *' : ''}` : '—',
      vp && cp ? `${cp.net - vp.net >= 0 ? '+' : ''}${fmtMoney(cp.net - vp.net)}` : '—',
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  host.append(table);
  if (compareParts.some((p) => p.estimated)) {
    const note = document.createElement('p');
    note.className = 'field-hint';
    note.textContent = '* 该代次分区产物已回收，按汇总值均摊展示。';
    host.append(note);
  }
}

// ---------------- history ----------------

function renderHistory() {
  const body = $('history-body');
  body.innerHTML = '';
  const table = $('history-table');
  table.parentElement.querySelectorAll('.table-note').forEach((n) => n.remove());
  const rows = [...state.history].sort((a, b) => b.generation - a.generation);
  for (const entry of rows) {
    const tr = document.createElement('tr');
    if (entry.visible) tr.className = 'visible-row';
    if (entry.reclaimedAt) tr.classList.add('reclaimed-row');

    const g = document.createElement('td');
    g.textContent = `${entry.generation}${entry.visible ? ' ●' : ''}`;
    g.title = entry.visible ? '当前读入口' : '';

    const bind = document.createElement('td');
    bind.textContent = `v${entry.sourceVersion ?? '—'} / v${entry.ruleVersion ?? '—'}`;

    const status = document.createElement('td');
    status.className = 'cell-status';
    status.textContent = entry.reclaimedAt ? '已回收' : entry.statusLabel;
    status.title = entry.reclaimBlockedBy ? `回收条件：${entry.reclaimBlockedBy}` : '';

    const readers = document.createElement('td');
    readers.className = 'cell-readers';
    readers.textContent = entry.liveLeases ? `${entry.liveLeases} 个` : '—';

    const net = document.createElement('td');
    net.className = 'num';
    const summary = entry.summary;
    // A running build only has a partial net. Mark it so it is not mistaken
    // for a finished value next to completed generations.
    net.textContent = summary ? fmtMoney(summary.netCents) : entry.partial ? `${fmtMoney(entry.partial.netCents)}*` : '—';
    if (!summary && entry.partial) {
      net.title = `仅统计已核对分区：${entry.partitionsVerified}/12，构建尚未完成`;
    }

    const ops = document.createElement('td');
    const opWrap = document.createElement('div');
    opWrap.className = 'cell-actions';
    if (entry.canReclaim) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn tiny danger';
      btn.textContent = '回收';
      // Offered even while readers are attached: the server re-checks leases
      // at click time, so the refusal is the real gate, not a stale render.
      if (entry.liveReadersBlockReclaim) btn.title = entry.reclaimBlockedBy;
      btn.addEventListener('click', () => reclaim(entry.generation));
      opWrap.append(btn);
      // Only spell out the hint when it is the actual blocker. The always-on
      // "we will re-check leases" sentence is already in the panel subtitle and
      // wrapping it under every button makes this narrow column unreadable.
      if (entry.reclaimBlockedBy) {
        const hint = document.createElement('span');
        hint.className = 'field-hint';
        // The reader count already has its own column; keep this inline hint
        // short so it does not wrap into a tall stack beside the button.
        hint.textContent = entry.liveReadersBlockReclaim ? '有活跃读者' : entry.reclaimBlockedBy;
        opWrap.append(hint);
      }
    } else if (entry.reclaimBlockedBy && !entry.reclaimedAt && entry.completedAt) {
      const span = document.createElement('span');
      span.className = 'field-hint';
      span.textContent = entry.reclaimBlockedBy;
      opWrap.append(span);
    }
    ops.append(opWrap);

    tr.append(g, bind, status, readers, net, ops);
    body.append(tr);
  }
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'field-hint';
    td.textContent = '尚无代次。';
    tr.append(td);
    body.append(tr);
    return;
  }
  if (rows.some((entry) => !entry.summary && entry.partial)) {
    const note = document.createElement('p');
    note.className = 'table-note';
    note.textContent = '* 任务尚未完成，只统计已核对分区的净额。';
    table.parentElement.append(note);
  }
}

async function reclaim(generation) {
  try {
    await api(`/api/generations/${generation}/reclaim`, { method: 'POST' });
    toast(`代次 ${generation} 已回收，汇总结果保留`);
    await refresh();
  } catch (error) {
    if (error.readers?.length) {
      toast(`回收被拒绝：${error.readers.length} 个读者正在使用代次 ${generation}`, true);
    } else {
      toast(error.message, true);
    }
    await refresh();
  }
}

// ---------------- events ----------------

function renderEvents() {
  const filter = $('event-filter').value;
  const host = $('event-log');
  host.innerHTML = '';
  const important = new Set([
    'build-create',
    'build-superseded',
    'promote',
    'partition-failed',
    'partition-mismatch',
    'partition-verify-failed',
    'reclaim',
    'reclaim-blocked',
    'lease-acquired',
    'lease-released',
    'build-resumed',
    'partition-tampered',
  ]);
  const list = state.events.filter((ev) => {
    if (filter === 'important') return important.has(ev.kind);
    if (filter === 'error') return ev.level === 'error' || ev.level === 'warning';
    return true;
  });
  for (const ev of list) {
    const li = document.createElement('li');
    li.className = `event-item ${ev.level}`;
    const time = document.createElement('span');
    time.className = 'e-time';
    time.textContent = fmtTime(ev.at);
    const msg = document.createElement('span');
    msg.className = 'e-msg';
    msg.textContent = ev.message;
    li.append(time, msg);
    host.append(li);
  }
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'event-item';
    const span = document.createElement('span');
    span.className = 'e-msg';
    span.textContent = '没有符合筛选条件的日志。';
    li.append(span);
    host.append(li);
  }
}

// ---------------- wiring ----------------

function wire() {
  $('launch-form').addEventListener('submit', launchBuild);
  $('source-version').addEventListener('change', updateHints);
  $('rule-version').addEventListener('change', updateHints);
  $('lease-form').addEventListener('submit', openLease);
  $('fault-add').addEventListener('click', addFault);
  $('refresh-btn').addEventListener('click', async () => {
    await refresh();
    toast('已刷新');
  });
  $('event-filter').addEventListener('change', renderEvents);
  $('compare-generation').addEventListener('change', renderCompare);
  $('toggle-table').addEventListener('click', () => {
    tableOpen = !tableOpen;
    $('toggle-table').setAttribute('aria-expanded', String(tableOpen));
    $('toggle-table').textContent = tableOpen ? '隐藏表格' : '表格视图';
    $('compare-table').hidden = !tableOpen;
    if (tableOpen) {
      const build = state.builds.find((b) => b.id === state.visible.buildId);
      const compareGen = Number($('compare-generation').value);
      const entry = state.history.find((h) => h.generation === compareGen);
      if (entry) {
        renderCompareTable(
          buildPartsSummary(state.visible.buildId),
          buildPartsSummary(entry.buildId, entry.summary, entry.partitionsVerified),
          state.visible.generation,
          entry.generation,
        );
      }
    }
  });

  for (const preset of document.querySelectorAll('[data-preset]')) {
    preset.addEventListener('click', () => applyPreset(preset.dataset.preset));
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refresh();
      schedulePoll();
    }
  });
}

function applyPreset(name) {
  const all = state.structure.partitions.map((p) => p.no);
  if (name === 'interleave') {
    // Two interleaved rebuilds: a slow one and a fast newer one, so the older
    // one finishes last and must not take the read entry.
    $('opt-partition-ms').value = 2400;
    $('opt-verify-ms').value = 700;
    $('opt-concurrency').value = 3;
    faultRows = [
      { partition: 3, mode: 'slow', stage: 'build', slowMs: 12000 },
      { partition: 9, mode: 'slow', stage: 'build', slowMs: 12000 },
    ];
    $('build-note').value = '慢任务：旧源版本重算，最后完成';
    renderFaultRows();
    $('advanced').open = true;
    toast('已配置慢任务。先发起它，再将耗时调小并发起第二个任务。');
    return;
  }
  if (name === 'fail') {
    $('opt-partition-ms').value = 1600;
    $('opt-verify-ms').value = 500;
    $('opt-concurrency').value = 3;
    faultRows = [{ partition: all[3] ?? 4, mode: 'once', stage: 'build', at: 50 }];
    renderFaultRows();
    $('advanced').open = true;
    $('build-note').value = '含一次构建中断，重试后通过';
    toast('已配置分区 4 构建阶段单次失败，重试可恢复。');
    return;
  }
  if (name === 'tamper') {
    $('opt-partition-ms').value = 1600;
    $('opt-verify-ms').value = 600;
    $('opt-concurrency').value = 4;
    faultRows = [{ partition: all[5] ?? 6, mode: 'corrupt', stage: 'build' }];
    renderFaultRows();
    $('advanced').open = true;
    $('build-note').value = '含产物篡改，复核应拦截';
    toast('已配置分区 6 产物篡改，独立复核应发现不一致。');
  }
}

async function boot() {
  wire();
  renderFaultRows();
  await refresh();
  schedulePoll();
}

boot();
