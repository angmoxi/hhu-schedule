/**
 * 河海课表 PWA
 *
 * 数据流：GitHub Actions 抓取教务系统 → 口令加密成 data/schedule.enc.json
 * → 本页拉取 → 用 WebCrypto 解密 → 存 localStorage → 离线可用。
 */

import { isActive, layoutWeek } from './layout.js';

// 网页版从同目录读数据；打包成 Android App 时优先从 GitHub 拉最新，失败则用包内自带的那份
const BUNDLED_DATA_URL = 'data/schedule.enc.json';
const REMOTE_DATA_URL = 'https://angmoxi.github.io/hhu-schedule/data/schedule.enc.json';
const IS_ANDROID_APP = location.hostname === 'appassets.androidplatform.net';
const KEY_PASS = 'hhu.pass';
const KEY_DATA = 'hhu.data';
const KEY_META = 'hhu.meta';
const KEY_START = 'hhu.startOverride';

const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'];
const PALETTE = 8;
const DAY_MS = 86400000;

const state = { schedule: null, meta: null, week: 1, pass: '' };

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ 工具 */

function b64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hashString(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function colorClass(name) {
  return 'c' + (hashString(name) % PALETTE);
}

function toast(message) {
  const el = $('toast');
  if (!message) { el.hidden = true; return; }
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2400);
}

/* ------------------------------------------------------------------ 解密 */

async function decryptEnvelope(envelope, passphrase) {
  const encoder = new TextEncoder();
  const salt = b64ToBytes(envelope.salt);
  const iv = b64ToBytes(envelope.iv);
  const ciphertext = b64ToBytes(envelope.ct);
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: envelope.iter || 200000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/**
 * 数据源顺序：
 * - 网页版：只有同目录一份；
 * - App 版：解锁时先用包内数据（秒开），后台刷新时优先拉 GitHub 上的最新数据。
 */
function dataSources(preferRemote = true) {
  if (!IS_ANDROID_APP) return [BUNDLED_DATA_URL];
  return preferRemote ? [REMOTE_DATA_URL, BUNDLED_DATA_URL] : [BUNDLED_DATA_URL, REMOTE_DATA_URL];
}

async function fetchEnvelope(preferRemote = true) {
  let lastError = null;
  for (const url of dataSources(preferRemote)) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        const error = new Error(response.status === 404 ? '服务器上还没有课表数据' : `拉取数据失败：HTTP ${response.status}`);
        error.code = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;  // 联网失败时自动退回下一数据源（App 内即包内自带数据）
    }
  }
  throw lastError || new Error('无法获取课表数据');
}

/* ------------------------------------------------------------------ 周次 */

function scheduleStart() {
  const override = localStorage.getItem(KEY_START);
  const iso = override || (state.schedule && state.schedule.startDate);
  if (!iso) return null;
  const date = new Date(`${iso}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function totalWeeks() {
  return (state.schedule && state.schedule.totalWeeks) || 20;
}

function currentWeek() {
  const start = scheduleStart();
  if (!start) return 1;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.floor((today - start) / DAY_MS);
  const week = Math.floor(days / 7) + 1;
  return Math.min(Math.max(week, 1), totalWeeks());
}

function weekDates(week) {
  const start = scheduleStart();
  if (!start) return null;
  return {
    monday: new Date(start.getTime() + (week - 1) * 7 * DAY_MS),
    sunday: new Date(start.getTime() + (week - 1) * 7 * DAY_MS + 6 * DAY_MS),
  };
}

function formatRange(range) {
  if (!range) return '';
  return `${range.monday.getMonth() + 1}月${range.monday.getDate()}日 - ${range.sunday.getMonth() + 1}月${range.sunday.getDate()}日`;
}

function todayColumn() {
  const start = scheduleStart();
  if (!start) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.floor((today - start) / DAY_MS);
  if (days < 0) return 0;
  if (Math.floor(days / 7) + 1 !== state.week) return 0;
  return (days % 7) + 1;
}

/* ------------------------------------------------------------------ 渲染 */

function render() {
  $('gate').hidden = true;
  $('topbar').hidden = false;
  $('timetable-view').hidden = false;
  renderHeader();
  renderGrid();
  renderOther();
  renderFooter();
}

function renderHeader() {
  const total = totalWeeks();
  $('week-title').textContent = `第 ${state.week} 周`;
  $('week-dates').textContent = formatRange(weekDates(state.week)) || '起始日期未知';
  $('btn-prev').disabled = state.week <= 1;
  $('btn-next').disabled = state.week >= total;
}

function renderGrid() {
  const grid = $('grid');
  grid.innerHTML = '';
  const layout = layoutWeek(state.schedule, state.week);
  const highlight = todayColumn();

  // 每小节一行、行高恒定 → 色块高度按实际节次等分
  grid.style.gridTemplateRows = `auto repeat(${layout.maxSection}, var(--sec-h))`;

  const corner = el('div', 'day-head');
  corner.style.gridRow = '1';
  corner.style.gridColumn = '1';
  grid.append(corner);
  for (let day = 1; day <= 7; day += 1) {
    const head = el('div', 'day-head', WEEKDAY_SHORT[day - 1]);
    if (day === highlight) head.classList.add('today');
    head.style.gridRow = '1';
    head.style.gridColumn = String(day + 1);
    grid.append(head);
  }

  // 大节背景格：跨它包含的若干小节行
  for (const block of layout.periodBlocks) {
    const secs = block.sections;
    const label = el('div', 'period-label');
    label.append(el('b', '', secs.length ? `${secs[0]}-${secs[secs.length - 1]}节` : block.name));
    if (block.time) label.append(el('span', '', block.time.slice(0, 5)));
    label.style.gridRow = `${block.first + 1} / span ${block.span}`;
    label.style.gridColumn = '1';
    grid.append(label);

    for (let day = 1; day <= 7; day += 1) {
      const cell = el('div', 'cell');
      if (day === highlight) cell.classList.add('today');
      cell.style.gridRow = `${block.first + 1} / span ${block.span}`;
      cell.style.gridColumn = String(day + 1);
      grid.append(cell);
    }
  }

  // 本周要上的课：按真实节次定位，占几节就是几行高
  for (const item of layout.items) {
    const chip = chipEl(item.course, item.day, item.course.bigPeriod);
    chip.style.gridRow = `${item.start + 1} / span ${item.span}`;
    chip.style.gridColumn = String(item.day + 1);
    if (item.lanes > 1) {
      // 同一时段真有两门课：各占 1/n 宽，并排显示
      const gap = 2;
      chip.style.justifySelf = 'start';
      chip.style.width = `calc((100% - ${(item.lanes - 1) * gap}px) / ${item.lanes})`;
      chip.style.marginLeft = `calc(${item.lane} * ((100% - ${(item.lanes - 1) * gap}px) / ${item.lanes} + ${gap}px))`;
    }
    grid.append(chip);
  }

  renderEmptyWeek(layout);
}

/** 整周都没课时给一句提示，免得看起来像界面坏了。 */
function renderEmptyWeek(layout) {
  const wrap = document.querySelector('.grid-wrap');
  let hint = wrap.querySelector('.empty-week');
  if (!hint) {
    hint = el('div', 'empty-week');
    wrap.append(hint);
  }
  hint.textContent = layout.hasCoursesThisWeek ? '' : layout.emptyMessage;
  hint.hidden = layout.hasCoursesThisWeek;
}

function chipEl(course, day, bigPeriod) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `chip ${colorClass(course.name)}`;
  button.append(el('span', 'cname', course.name));
  if (course.room) button.append(el('span', 'room', course.room));
  button.addEventListener('click', () => openDetail(day, bigPeriod));
  return button;
}

function renderOther() {
  const list = (state.schedule.otherCourses || []).filter((c) => c.name);
  const box = $('other-courses');
  box.innerHTML = '';
  if (!list.length) { box.hidden = true; return; }
  box.hidden = false;
  box.append(el('h2', '', '本学期无固定时间的课程'));
  const ul = document.createElement('ul');
  for (const course of list) {
    const parts = [course.name];
    if (course.teacher) parts.push(course.teacher);
    if (course.kind) parts.push(course.kind);
    ul.append(el('li', '', parts.join(' · ')));
  }
  box.append(ul);
}

function renderFooter() {
  const meta = state.meta;
  const term = state.schedule.termName || state.schedule.term || '';
  $('footer-note').textContent = [term, meta && meta.updated ? `数据更新于 ${formatTime(meta.updated)}` : '', IS_ANDROID_APP ? 'App 版' : '']
    .filter(Boolean)
    .join(' · ');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function weeksText(course) {
  if (!course.weeks || !course.weeks.length) return '未标明周次';
  const text = course.weeks.map(([from, to]) => (from === to ? String(from) : `${from}-${to}`)).join('、');
  return `第 ${text} 周${course.parity ? `（${course.parity}周）` : ''}`;
}

/* ------------------------------------------------------------------ 弹层 */

function openSheet(id) {
  for (const sheet of document.querySelectorAll('.sheet')) sheet.hidden = sheet.id !== id;
  $('backdrop').hidden = false;
}

function closeSheets() {
  for (const sheet of document.querySelectorAll('.sheet')) sheet.hidden = true;
  $('backdrop').hidden = true;
}

function openDetail(day, bigPeriod) {
  const period = state.schedule.periods.find((p) => p.index === bigPeriod);
  // 本周要上的课排前面；不在本周的仍然列出（并标注），方便知道这个时段以后会上什么
  const courses = state.schedule.courses
    .filter((c) => c.day === day && c.bigPeriod === bigPeriod)
    .sort((a, b) => Number(isActive(b, state.week)) - Number(isActive(a, state.week)));
  $('detail-title').textContent = `星期${WEEKDAY_SHORT[day - 1]} · ${period ? period.name : ''}`;

  const body = $('detail-body');
  body.innerHTML = '';
  const list = courses.length ? courses : [null];
  for (const course of list) {
    const box = el('div', 'course-detail');
    if (!course) {
      box.append(el('div', 'note', '这一格没有课程。'));
      body.append(box);
      continue;
    }
    const active = isActive(course, state.week);
    const name = el('span', `name ${colorClass(course.name)}`, course.name);
    if (!active) name.style.opacity = '.55';
    box.append(name);
    if (!active) box.append(el('div', 'note', `本周不上这门课（${weeksText(course)}）`));

    const dl = document.createElement('dl');
    const add = (label, value) => {
      if (!value) return;
      dl.append(el('dt', '', label), el('dd', '', value));
    };
    add('教师', course.teacher);
    add('教室', course.room);
    const sections = (course.sections || []).join('-');
    add('节次', [sections ? `第 ${sections} 节` : '', period && period.time ? period.time : ''].filter(Boolean).join(' · '));
    add('周次', weeksText(course));
    add('备注', course.note);
    box.append(dl);
    body.append(box);
  }
  openSheet('sheet-detail');
}

function openWeekPicker() {
  const picker = $('week-picker');
  picker.innerHTML = '';
  const current = currentWeek();
  for (let week = 1; week <= totalWeeks(); week += 1) {
    const button = el('button', '', `第 ${week} 周`);
    if (week === current) button.classList.add('current');
    if (week === state.week) button.classList.add('selected');
    button.addEventListener('click', () => {
      state.week = week;
      closeSheets();
      render();
    });
    picker.append(button);
  }
  openSheet('sheet-weeks');
}

function openSettings() {
  const schedule = state.schedule;
  $('set-term').textContent = schedule.termName || schedule.term || '-';
  $('set-updated').textContent = state.meta && state.meta.updated ? formatTime(state.meta.updated) : '-';
  const start = scheduleStart();
  const auto = schedule.startDate || '未知';
  $('set-start').textContent = start
    ? `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}${localStorage.getItem(KEY_START) ? '（手动校正）' : ''}`
    : '未知';
  $('set-build').textContent = `校历第 1 周：${auto} · 共 ${totalWeeks()} 周`;
  openSheet('sheet-settings');
}

/* ------------------------------------------------------------------ 同步 */

function persist(schedule, meta) {
  localStorage.setItem(KEY_DATA, JSON.stringify(schedule));
  localStorage.setItem(KEY_META, JSON.stringify(meta));
}

/** 用已取到的密文数据解锁并落盘。 */
async function applyEnvelope(envelope, passphrase, { initial = false } = {}) {
  const schedule = await decryptEnvelope(envelope, passphrase);
  state.pass = passphrase;
  state.schedule = schedule;
  state.meta = { updated: envelope.updated, payloadHash: envelope.payloadHash };
  localStorage.setItem(KEY_PASS, passphrase);
  persist(schedule, state.meta);
  if (initial) state.week = currentWeek();
  render();
}

/** 首次解锁：App 版先用包内数据，保证秒开。 */
async function unlock(passphrase, options = {}) {
  return applyEnvelope(await fetchEnvelope(false), passphrase, options);
}

async function refresh({ silent = false } = {}) {
  if (!state.pass) return;
  if (!navigator.onLine) {
    if (!silent) toast('当前没有网络，显示的是本机缓存');
    return;
  }
  try {
    const envelope = await fetchEnvelope(true);  // 刷新时优先取远端最新
    if (state.schedule && state.meta && envelope.payloadHash === state.meta.payloadHash) {
      state.meta = { ...state.meta, updated: envelope.updated };
      localStorage.setItem(KEY_META, JSON.stringify(state.meta));
      render();
    } else {
      await applyEnvelope(envelope, state.pass);  // 用刚取到的那份，别再退回包内旧数据
    }
    if (!silent) toast('课表已是最新');
  } catch (error) {
    if (silent) return;
    toast(state.schedule ? `同步失败，继续使用本机缓存（${error.message}）` : `同步失败：${error.message}`);
  }
}

/* ------------------------------------------------------------------ 启动 */

function showGate(message = '') {
  $('gate').hidden = false;
  $('topbar').hidden = true;
  $('timetable-view').hidden = true;
  $('gate-hint').textContent = message;
  const meta = localStorage.getItem(KEY_META);
  if (meta) {
    try {
      $('gate-status').textContent = `本机缓存数据：${formatTime(JSON.parse(meta).updated)}`;
    } catch { /* 忽略损坏缓存 */ }
  }
}

function bind() {
  $('gate-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('gate-input');
    const button = $('gate-submit');
    const passphrase = input.value;
    if (!passphrase) return;
    button.disabled = true;
    button.textContent = '解锁中…';
    $('gate-hint').textContent = '';
    try {
      await unlock(passphrase, { initial: true });
      input.value = '';
      if (IS_ANDROID_APP) refresh({ silent: true });  // App 版：解锁后后台拉一次最新数据
    } catch (error) {
      const hint = error.code === 404
        ? '服务器上还没有课表数据：请先在 GitHub 仓库运行一次「同步课表数据」workflow。'
        : (error.name === 'OperationError' ? '口令不对，或数据文件已损坏。' : `解锁失败：${error.message}`);
      $('gate-hint').textContent = hint;
    } finally {
      button.disabled = false;
      button.textContent = '解锁';
    }
  });

  $('btn-prev').addEventListener('click', () => {
    state.week = Math.max(1, state.week - 1);
    render();
  });
  $('btn-next').addEventListener('click', () => {
    state.week = Math.min(totalWeeks(), state.week + 1);
    render();
  });
  $('btn-week').addEventListener('click', openWeekPicker);
  $('btn-settings').addEventListener('click', openSettings);
  $('backdrop').addEventListener('click', closeSheets);
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', closeSheets);

  $('btn-refresh').addEventListener('click', () => refresh());
  $('btn-change-pass').addEventListener('click', () => {
    closeSheets();
    localStorage.removeItem(KEY_PASS);
    state.pass = '';
    showGate('请输入当前生效的同步口令。');
  });
  $('btn-clear').addEventListener('click', () => {
    if (!confirm('清除本机缓存的课表与口令？下次打开需要重新解锁。')) return;
    for (const key of [KEY_PASS, KEY_DATA, KEY_META, KEY_START]) localStorage.removeItem(key);
    location.reload();
  });

  const shiftStart = (days) => {
    const start = scheduleStart();
    if (!start) return;
    const next = new Date(start.getTime() + days * DAY_MS);
    localStorage.setItem(KEY_START, `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`);
    state.week = currentWeek();
    render();
    openSettings();
  };
  $('btn-start-back').addEventListener('click', () => shiftStart(-7));
  $('btn-start-fwd').addEventListener('click', () => shiftStart(7));
  $('btn-start-reset').addEventListener('click', () => {
    localStorage.removeItem(KEY_START);
    state.week = currentWeek();
    render();
    openSettings();
  });
}

async function init() {
  bind();
  if ('serviceWorker' in navigator && !IS_ANDROID_APP) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 离线能力不可用不影响使用 */ });
  }
  if (IS_ANDROID_APP) $('install-hint').hidden = true;

  const cached = localStorage.getItem(KEY_DATA);
  if (cached) {
    try {
      state.schedule = JSON.parse(cached);
      state.meta = JSON.parse(localStorage.getItem(KEY_META) || 'null');
      state.pass = localStorage.getItem(KEY_PASS) || '';
      state.week = currentWeek();
      render();
      if (state.pass) refresh({ silent: true });
      return;
    } catch {
      localStorage.removeItem(KEY_DATA);
    }
  }
  showGate();
}

init();
