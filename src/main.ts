import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import './style.css';

/**
 * Live bar-revenue monitor.
 * Reads the `live_revenue_today` vitrine (3 rows) and subscribes to Supabase
 * Realtime. A shared password (VITE_DASHBOARD_PASSWORD) gates the app: until it
 * is entered correctly the Supabase client is never created, so no data is
 * fetched. The anon key is a build-time env var and is safe in the browser —
 * RLS exposes only the vitrine. Password lives in a Vercel env var, not in code.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const DASHBOARD_PASSWORD = import.meta.env.VITE_DASHBOARD_PASSWORD as string;
const AUTH_KEY = 'bar-dash-ok';

type Row = {
  id: number; name: string;
  rev: number; qty: number; mrev: number; mqty: number;   // beer today/month (kept)
  food: number; snacks: number; other: number;            // today by group
  foodM: number; snacksM: number; otherM: number;         // month by group
  total: number; totalM: number;                          // all groups
  totalYtd: number; totalYtdYa: number;                   // year-to-date now / year-ago
  totalYa: number; totalMYa: number;                      // year-ago: same day / MTD
  yaDate: string | null;                                  // the year-ago date compared
};
const rows = new Map<number, Row>();
let lastUpdate: Date | null = null;

const rub = new Intl.NumberFormat('ru-RU');
const app = document.getElementById('app')!;

function shell() {
  app.innerHTML = `
    <header class="bar">
      <div class="brand">
        <span class="mark"></span>
        <div>
          <div class="title">Аналитика баров</div>
          <div class="sub" id="today">—</div>
        </div>
      </div>
      <div class="conn" id="conn"><span class="led" id="led"></span><span id="connText" class="mono">соединение…</span></div>
    </header>

    <nav class="tabs" id="tabs">
      <button class="tab tab-active" data-tab="revenue">Выручка за смену</button>
      <button class="tab" data-tab="reports">Отчёты</button>
      <button class="tab" data-tab="taps">Краны</button>
      <button class="tab" data-tab="logs">Логи <span class="tab-badge" id="logsBadge" hidden>0</span></button>
    </nav>

    <div id="tab-revenue" class="tab-panel">
      <section class="hero">
        <div class="hero-row">
          <div class="hero-col">
            <div class="hero-label mono">Сегодня · вся выручка</div>
            <div class="hero-num"><span id="total">0</span><i>₽</i></div>
            <div class="hero-yoy" id="dayYoy"></div>
          </div>
          <div class="hero-col hero-col-month">
            <div class="hero-label mono">С начала месяца · вся</div>
            <div class="hero-num hero-num-sm"><span id="totalMonth">0</span><i>₽</i></div>
            <div class="hero-yoy" id="monthYoy"></div>
          </div>
          <div class="hero-col hero-col-year">
            <div class="hero-label mono">С начала года · вся</div>
            <div class="hero-num hero-num-sm"><span id="totalYtd">0</span><i>₽</i></div>
            <div class="hero-yoy" id="yearYoy"></div>
            <div class="hero-split" id="yearSplit"></div>
          </div>
        </div>
        <div class="hero-foot mono" id="heroFoot">—</div>
      </section>

      <section class="cards" id="cards"></section>

      <footer class="foot mono" id="foot"></footer>
    </div>

    <div id="tab-reports" class="tab-panel" hidden>
      <div class="reports-subnav" id="reportsSubnav">
        <button class="report-tab report-tab-active" data-report="abc">ABC-анализ</button>
      </div>

      <div id="report-abc" class="report-panel">
        <div class="abc-controls">
          <div class="abc-period" id="abcPeriod">
            <button class="seg-btn seg-active" data-period="month">Текущий месяц</button>
            <button class="seg-btn" data-period="ytd">С начала года</button>
          </div>
        </div>
        <div class="abc-body" id="abcBody"><div class="abc-hint mono">загрузка…</div></div>
      </div>
    </div>

    <div id="tab-taps" class="tab-panel" hidden>
      <div class="taps-controls">
        <div class="taps-bars" id="tapsBars"></div>
        <div class="taps-actions">
          <div class="chz-dropdown">
            <button class="taps-chz-btn" id="tapsChzBtn">Документ ЧЗ ▾</button>
            <div class="chz-menu" id="tapsChzMenu" hidden></div>
          </div>
        </div>
      </div>
      <div class="taps-body" id="tapsBody"><div class="abc-hint mono">загрузка…</div></div>
    </div>

    <div id="tab-logs" class="tab-panel" hidden>
      <div class="logs-controls">
        <div class="logs-seg" id="logsFilter">
          <button class="seg-btn seg-active" data-filter="unresolved">Активные</button>
          <button class="seg-btn" data-filter="all">Все</button>
        </div>
        <button class="logs-refresh" id="logsRefresh" title="Обновить">↻</button>
      </div>
      <div class="logs-body" id="logsBody"><div class="abc-hint mono">загрузка…</div></div>
    </div>
  `;
}

function setConn(state: 'live' | 'wait' | 'down', text: string) {
  const led = document.getElementById('led')!;
  led.className = 'led ' + state;
  document.getElementById('connText')!.textContent = text;
}

function todayLabel() {
  const d = new Date();
  const s = d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function grpRow(cls: string, label: string, today: number, month: number, totalDay: number, totalMonth: number): string {
  const pctD = totalDay > 0 ? Math.round((today / totalDay) * 100) : 0;
  const pctM = totalMonth > 0 ? Math.round((month / totalMonth) * 100) : 0;
  return `
    <div class="grp">
      <span class="grp-head"><i class="dot dot-${cls}"></i>${label}</span>
      <span class="grp-nums">
        <span class="grp-today">${rub.format(Math.round(today))} ₽ <em class="grp-pct">${pctD}%</em></span>
        <span class="grp-month mono">${rub.format(Math.round(month))} ₽ / мес · ${pctM}%</span>
      </span>
    </div>`;
}

function mapRow(r: any): Row {
  return {
    id: r.location_id, name: r.location_name,
    rev: Number(r.beer_revenue), qty: Number(r.beer_qty),
    mrev: Number(r.month_revenue), mqty: Number(r.month_qty),
    food: Number(r.food_revenue), snacks: Number(r.snacks_revenue), other: Number(r.other_revenue),
    foodM: Number(r.food_month), snacksM: Number(r.snacks_month), otherM: Number(r.other_month),
    total: Number(r.total_revenue), totalM: Number(r.total_month),
    totalYtd: Number(r.total_ytd ?? 0), totalYtdYa: Number(r.total_ytd_ya ?? 0),
    totalYa: Number(r.total_revenue_ya ?? 0), totalMYa: Number(r.total_month_ya ?? 0),
    yaDate: r.ya_date ?? null,
  };
}

function yoyBadge(now: number, ya: number, label: string = 'год назад'): string {
  // no comparable history (e.g. bar not yet open a year ago)
  if (!ya || ya <= 0) return `<em class="yoy yoy-flat mono">нет данных год назад</em>`;
  const pct = Math.round(((now - ya) / ya) * 100);
  const cls = pct > 0 ? 'yoy-up' : pct < 0 ? 'yoy-down' : 'yoy-flat';
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '·';
  const sign = pct > 0 ? '+' : '';
  return `<em class="yoy ${cls} mono">${arrow} ${sign}${pct}% · ${rub.format(Math.round(ya))} ₽ ${label}</em>`;
}

function paint(bumpId?: number) {
  const sorted = [...rows.values()].sort((a, b) => b.totalM - a.totalM);
  const total = sorted.reduce((s, r) => s + (r.total || 0), 0);
  const totalMonth = sorted.reduce((s, r) => s + (r.totalM || 0), 0);
  const totalYtd = sorted.reduce((s, r) => s + (r.totalYtd || 0), 0);
  // day YoY: only bars with comparable history on that day a year ago
  const totalDayYa = sorted.reduce((s, r) => s + (r.totalYa > 0 ? r.totalYa : 0), 0);
  const totalDayCmp = sorted.reduce((s, r) => s + (r.totalYa > 0 ? r.total : 0), 0);
  // YoY only across bars that have comparable history (ya MTD > 0)
  const totalMonthYa = sorted.reduce((s, r) => s + (r.totalMYa > 0 ? r.totalMYa : 0), 0);
  const totalMonthCmp = sorted.reduce((s, r) => s + (r.totalMYa > 0 ? r.totalM : 0), 0);
  // same for the year (YTD): only bars with comparable history a year ago
  const totalYtdYa = sorted.reduce((s, r) => s + (r.totalYtdYa > 0 ? r.totalYtdYa : 0), 0);
  const totalYtdCmp = sorted.reduce((s, r) => s + (r.totalYtdYa > 0 ? r.totalYtd : 0), 0);
  // YTD by legal entity: Хоп Сити Барс = Шоссе(1)+Строгино(2), Хоп Сити Концепт = Флакон(3)
  const ytdBars = sorted.reduce((s, r) => s + (r.id === 1 || r.id === 2 ? r.totalYtd : 0), 0);
  const ytdConcept = sorted.reduce((s, r) => s + (r.id === 3 ? r.totalYtd : 0), 0);
  const max = sorted.reduce((m, r) => Math.max(m, r.totalM || 0), 0) || 1;

  document.getElementById('total')!.textContent = rub.format(Math.round(total));
  document.getElementById('totalMonth')!.textContent = rub.format(Math.round(totalMonth));
  document.getElementById('totalYtd')!.textContent = rub.format(Math.round(totalYtd));

  const cards = document.getElementById('cards')!;
  cards.innerHTML = sorted.map((r, i) => {
    const pct = Math.max(3, Math.round((r.totalM / max) * 100));
    const lead = i === 0 && r.totalM > 0 ? ' lead' : '';
    const bump = r.id === bumpId ? ' bump' : '';
    const seg = (val: number, cls: string) => {
      const w = r.totalM > 0 ? Math.round((val / r.totalM) * 100) : 0;
      return w > 0 ? `<span class="seg seg-${cls}" style="width:${w}%"></span>` : '';
    };
    return `
      <article class="card${lead}${bump}" data-id="${r.id}">
        <div class="card-top">
          <span class="rank mono">${String(i + 1).padStart(2, '0')}</span>
          <span class="name">${r.name}</span>
        </div>
        <div class="amount">${rub.format(Math.round(r.total))}<i>₽</i><em class="amount-tag mono">сегодня</em></div>
        <div class="card-yoy card-yoy-day">${yoyBadge(r.total, r.totalYa, 'в этот день год назад')}</div>
        <div class="rail rail-stack">
          ${seg(r.mrev, 'beer')}${seg(r.foodM, 'food')}${seg(r.snacksM, 'snacks')}${seg(r.otherM, 'other')}
        </div>
        <div class="card-month">
          <span class="card-month-val">${rub.format(Math.round(r.totalM))} ₽</span>
          <span class="card-month-lbl mono">за месяц · всё</span>
        </div>
        <div class="card-yoy">${yoyBadge(r.totalM, r.totalMYa, 'в этом месяце год назад')}</div>
        <div class="card-year">
          <span class="card-year-val mono">${rub.format(Math.round(r.totalYtd))} ₽</span>
          <span class="card-year-lbl mono">с начала года</span>
        </div>
        <div class="card-yoy">${yoyBadge(r.totalYtd, r.totalYtdYa, 'за тот же период год назад')}</div>
        <div class="groups">
          ${grpRow('beer', 'Пиво и сидр', r.rev, r.mrev, r.total, r.totalM)}
          ${grpRow('food', 'Еда', r.food, r.foodM, r.total, r.totalM)}
          ${grpRow('snacks', 'Закуски', r.snacks, r.snacksM, r.total, r.totalM)}
        </div>
      </article>`;
  }).join('');

  const hf = document.getElementById('heroFoot')!;
  const dayYoyEl = document.getElementById('dayYoy')!;
  const monthYoyEl = document.getElementById('monthYoy')!;
  const yearYoyEl = document.getElementById('yearYoy')!;
  dayYoyEl.innerHTML = totalDayYa > 0 ? yoyBadge(totalDayCmp, totalDayYa, 'в этот день год назад') : '';
  monthYoyEl.innerHTML = totalMonthYa > 0 ? yoyBadge(totalMonthCmp, totalMonthYa, 'в этом месяце год назад') : '';
  yearYoyEl.innerHTML = totalYtdYa > 0 ? yoyBadge(totalYtdCmp, totalYtdYa, 'за тот же период год назад') : '';
  const yearSplitEl = document.getElementById('yearSplit')!;
  yearSplitEl.innerHTML =
    `<span class="split-row"><span class="split-name">Хоп Сити Барс</span><span class="split-val mono">${rub.format(Math.round(ytdBars))} ₽</span></span>` +
    `<span class="split-row"><span class="split-name">Хоп Сити Концепт</span><span class="split-val mono">${rub.format(Math.round(ytdConcept))} ₽</span></span>`;
  if (sorted.length) {
    hf.innerHTML = `${sorted.length} бара · лидер месяца ${sorted[0].name}`;
  } else {
    hf.textContent = 'нет данных';
  }
}

function tickFoot() {
  const foot = document.getElementById('foot')!;
  if (!lastUpdate) { foot.textContent = ''; return; }
  const s = Math.round((Date.now() - lastUpdate.getTime()) / 1000);
  const ago = s < 60 ? `${s} с назад` : `${Math.round(s / 60)} мин назад`;
  foot.textContent = `обновлено ${ago}`;
}

function fatal(msg: string) {
  app.innerHTML = `<div class="fatal"><div class="fatal-h mono">нет связи с данными</div><p>${msg}</p></div>`;
}

async function load(client: SupabaseClient) {
  const { data, error } = await client
    .from('live_revenue_today')
    .select('location_id, location_name, beer_revenue, beer_qty, month_revenue, month_qty, food_revenue, snacks_revenue, other_revenue, beer_month, food_month, snacks_month, other_month, total_revenue, total_month, total_ytd, total_revenue_ya, total_month_ya, total_ytd_ya, ya_date');
  if (error) throw error;
  for (const r of data ?? []) rows.set(r.location_id, mapRow(r));
  lastUpdate = new Date();
}

async function startDashboard() {
  shell();
  document.getElementById('today')!.textContent = todayLabel();

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    fatal('Не заданы переменные окружения VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY. Добавь их в настройках проекта на Vercel и пересобери.');
    return;
  }

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

  try {
    await load(client);
    paint();
    setConn('live', 'в эфире');
  } catch (e: any) {
    fatal('Не удалось прочитать витрину выручки: ' + (e?.message ?? e) + '. Проверь anon-ключ и RLS-политику на таблице live_revenue_today.');
    return;
  }

  client.channel('live-revenue')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'live_revenue_today' },
      (payload: any) => {
        const r = payload.new;
        if (!r || r.location_id == null) return;
        rows.set(r.location_id, mapRow(r));
        lastUpdate = new Date();
        paint(r.location_id);
        tickFoot();
      })
    .subscribe((status: string) => {
      if (status === 'SUBSCRIBED') setConn('live', 'в эфире');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setConn('wait', 'переподключение');
    });

  // safety net: re-read every 60s in case Realtime drops silently
  setInterval(async () => {
    try { await load(client); paint(); } catch { setConn('down', 'нет ответа'); }
  }, 60000);

  // relative-time ticker
  setInterval(tickFoot, 1000);

  initTabs(client);
}

// ---- tabs + ABC analysis ----
let abcClient: SupabaseClient | null = null;
let abcLoaded = false;
let abcPeriod: 'month' | 'ytd' = 'month';

const BARS: { id: number; name: string }[] = [
  { id: 1, name: 'Шоссе Энтузиастов' },
  { id: 2, name: 'Строгино' },
  { id: 3, name: 'Флакон' },
];
const GRP_LABEL: Record<string, string> = { beer: 'Пиво и сидр', food: 'Еда', snacks: 'Закуски' };
const GRP_ORDER = ['beer', 'food', 'snacks'];

// ---- Краны ----
let tapsInited = false;
let tapsBar = 1;                       // выбранный бар на вкладке

type TapRow = {
  tap_no: number; product: string | null; volume_l: number | null;
  connected_at: string | null; poured_l: number | null; remaining_l: number | null; pct: number | null;
};

function initTapsTab() {
  tapsInited = true;
  const bars = document.getElementById('tapsBars')!;
  bars.innerHTML = BARS.map((b) =>
    `<button class="taps-bar-btn ${b.id === tapsBar ? 'taps-bar-active' : ''}" data-bar="${b.id}">${b.name}</button>`
  ).join('');
  bars.querySelectorAll<HTMLButtonElement>('.taps-bar-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      tapsBar = Number(btn.dataset.bar);
      bars.querySelectorAll('.taps-bar-btn').forEach((b) => b.classList.remove('taps-bar-active'));
      btn.classList.add('taps-bar-active');
      loadTaps();
    });
  });
  // кнопка «Документ ЧЗ» с выпадающим меню дат (сегодня + 5 дней назад)
  const chzBtn = document.getElementById('tapsChzBtn')!;
  const chzMenu = document.getElementById('tapsChzMenu')!;
  const today = new Date();
  const items: string[] = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const label = i === 0 ? 'сегодня'
      : i === 1 ? 'вчера'
      : d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long' });
    items.push(`<button class="chz-menu-item" data-date="${iso}" data-label="${label}">${label}</button>`);
  }
  chzMenu.innerHTML = items.join('');
  chzBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chzMenu.hidden = !chzMenu.hidden;
  });
  chzMenu.querySelectorAll<HTMLButtonElement>('.chz-menu-item').forEach((it) => {
    it.addEventListener('click', () => {
      chzMenu.hidden = true;
      exportChz(it.dataset.date!, it.dataset.label ?? '');
    });
  });
  // закрытие меню по клику вне его
  document.addEventListener('click', () => { chzMenu.hidden = true; });
}

async function loadTaps() {
  if (!abcClient) return;
  const body = document.getElementById('tapsBody')!;
  body.innerHTML = `<div class="abc-hint mono">загрузка…</div>`;
  try {
    const { data, error } = await abcClient.rpc('taps_state', { p_location: tapsBar });
    if (error) { body.innerHTML = `<div class="abc-hint mono">ошибка: ${error.message}</div>`; return; }
    const taps = (data ?? []) as TapRow[];
    body.innerHTML =
      `<div class="taps-grid">${taps.map(renderTap).join('')}</div>` +
      `<div class="swaps-section">
         <div class="swaps-head">Журнал замен · ${BAR_NAME[tapsBar]}</div>
         <div class="swaps-body" id="swapsBody"><div class="abc-hint mono">загрузка…</div></div>
       </div>`;
    loadSwaps();
  } catch (e: any) {
    body.innerHTML = `<div class="abc-hint mono">не удалось загрузить краны: ${e?.message ?? e}</div>`;
  }
}

type SwapRow = {
  id: number; tap_no: number; product: string; volume_l: number;
  poured_l: number; remaining_l: number; remaining_pct: number;
  connected_at: string | null; detached_at: string;
};

async function loadSwaps() {
  if (!abcClient) return;
  const el = document.getElementById('swapsBody');
  if (!el) return;
  const { data, error } = await abcClient.rpc('keg_swaps_recent', { p_location: tapsBar, p_limit: 50 });
  if (error) { el.innerHTML = `<div class="abc-hint mono">ошибка: ${error.message}</div>`; return; }
  const rows = (data ?? []) as SwapRow[];
  if (!rows.length) { el.innerHTML = `<div class="abc-hint mono">пока нет замен</div>`; return; }

  // группируем по дате (строки уже отсортированы по detached_at desc)
  const groups: { date: string; rows: SwapRow[] }[] = [];
  for (const r of rows) {
    const d = fmtSwapDate(r.detached_at);
    let g = groups[groups.length - 1];
    if (!g || g.date !== d) { g = { date: d, rows: [] }; groups.push(g); }
    g.rows.push(r);
  }
  el.innerHTML = groups.map((g) =>
    `<div class="swap-day">
       <div class="swap-day-head">${g.date}</div>
       <div class="swap-day-rows">${g.rows.map(renderSwap).join('')}</div>
     </div>`
  ).join('');
}

function renderSwap(s: SwapRow): string {
  const pct = Number(s.remaining_pct ?? 0);
  // недолив ≥10% — строка красная (потери), <10% — зелёная (кегу выработали)
  const cls = pct >= 10 ? 'swap-red' : 'swap-green';
  return `
    <div class="swap-row ${cls}">
      <div class="swap-main">
        <span class="swap-tap mono">Кран ${s.tap_no}</span>
        <span class="swap-product">${s.product}</span>
      </div>
      <div class="swap-nums mono">
        <span class="swap-rem">недолив ${fmtL(s.remaining_l)} л · ${pct}%</span>
        <span class="swap-detail">продано ${fmtL(s.poured_l)} из ${fmtL(s.volume_l)} л</span>
        <span class="swap-time">${fmtSwapClock(s.detached_at)}</span>
      </div>
    </div>`;
}

function fmtSwapDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
}
function fmtSwapClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function renderTap(t: TapRow): string {
  const empty = !t.product;
  if (empty) {
    return `
      <div class="tap-card tap-empty">
        <div class="tap-head"><span class="tap-no">Кран ${t.tap_no}</span><span class="tap-status mono">пусто</span></div>
        <div class="tap-empty-body">— нет кеги —</div>
      </div>`;
  }
  const pct = Math.max(0, Math.min(100, Number(t.pct ?? 0)));
  const low = pct <= 15;
  const mid = pct > 15 && pct <= 35;
  const fillClass = low ? 'tap-fill-low' : mid ? 'tap-fill-mid' : 'tap-fill-ok';
  return `
    <div class="tap-card ${low ? 'tap-card-low' : ''}">
      <div class="tap-head">
        <span class="tap-no">Кран ${t.tap_no}</span>
        <span class="tap-pct mono ${low ? 'tap-pct-low' : ''}">${pct}%</span>
      </div>
      <div class="tap-product">${t.product}</div>
      <div class="tap-bar"><div class="tap-fill ${fillClass}" style="width:${pct}%"></div></div>
      <div class="tap-nums mono">
        <span>${fmtL(t.remaining_l)} / ${fmtL(t.volume_l)} л</span>
        <span class="tap-poured">налито ${fmtL(t.poured_l)} л</span>
      </div>
      <div class="tap-foot">
        <span class="tap-since mono">${t.connected_at ? 'с ' + fmtTapDate(t.connected_at) : ''}</span>
      </div>
    </div>`;
}

function fmtL(v: number | null): string {
  return rub.format(Math.round((Number(v ?? 0)) * 10) / 10);
}
function fmtTapDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Выгрузка документа «Подключение кега» для Честного Знака:
// xlsx с одной колонкой — коды маркировки (CIS) подключённых за день кег.
async function exportChz(pickedDate: string, dateLabel: string) {
  if (!abcClient) return;
  const btn = document.getElementById('tapsChzBtn') as HTMLButtonElement;
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = 'Готовлю…';
  try {
    const { data, error } = await abcClient.rpc('chz_codes_for_day', { p_location: tapsBar, p_date: pickedDate });
    if (error) { alert('Ошибка выгрузки: ' + error.message); return; }
    const rows = (data ?? []) as { cis: string }[];
    const codes = rows.map((r) => r.cis).filter(Boolean);
    if (!codes.length) { alert(`За ${dateLabel} нет кег с кодом маркировки для этого бара.`); return; }

    // динамически подгружаем SheetJS из CDN (без постоянной зависимости)
    const XLSX = await import(/* @vite-ignore */ 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
    // одна колонка, без заголовка — как в шаблоне ЧЗ
    const aoa = codes.map((c) => [c]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Шаблон');
    const fileDate = (pickedDate ?? '').split('-').reverse().join('-');
    const barName = BAR_NAME[tapsBar].replace(/\s+/g, '_');
    XLSX.writeFile(wb, `Подключение_кег_${barName}_${fileDate}.xlsx`);
  } catch (e: any) {
    alert('Не удалось сформировать файл: ' + (e?.message ?? e));
  } finally {
    btn.disabled = false; btn.textContent = prev;
  }
}

function initTabs(client: SupabaseClient) {
  abcClient = client;
  const tabs = document.getElementById('tabs')!;
  tabs.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      tabs.querySelectorAll('.tab').forEach((b) => b.classList.remove('tab-active'));
      btn.classList.add('tab-active');
      const which = btn.dataset.tab!;
      document.getElementById('tab-revenue')!.hidden = which !== 'revenue';
      document.getElementById('tab-reports')!.hidden = which !== 'reports';
      document.getElementById('tab-taps')!.hidden = which !== 'taps';
      document.getElementById('tab-logs')!.hidden = which !== 'logs';
      if (which === 'reports' && !abcLoaded) loadAbc();
      if (which === 'taps') { if (!tapsInited) initTapsTab(); loadTaps(); }
      if (which === 'logs') loadLogs();
    });
  });
  const period = document.getElementById('abcPeriod')!;
  period.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      period.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('seg-active'));
      btn.classList.add('seg-active');
      abcPeriod = btn.dataset.period as 'month' | 'ytd';
      loadAbc();
    });
  });

  const logsFilter = document.getElementById('logsFilter')!;
  logsFilter.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      logsFilter.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('seg-active'));
      btn.classList.add('seg-active');
      logsOnlyUnresolved = btn.dataset.filter === 'unresolved';
      loadLogs();
    });
  });
  document.getElementById('logsRefresh')!.addEventListener('click', () => loadLogs());

  // фоновая проверка счётчика активных событий (раз в 60с)
  refreshLogsBadge();
  setInterval(refreshLogsBadge, 60000);
}

let logsOnlyUnresolved = true;

const LOG_TYPE_LABEL: Record<string, string> = {
  unclassified_product: 'Нет группы',
};
const BAR_NAME: Record<number, string> = { 1: 'Шоссе Энтузиастов', 2: 'Строгино', 3: 'Флакон' };

type LogRow = {
  id: number; event_type: string; severity: string; location_id: number | null;
  message: string; details: Record<string, unknown>; resolved: boolean; created_at: string;
};

async function refreshLogsBadge() {
  if (!abcClient) return;
  try {
    const { data, error } = await abcClient.rpc('ops_events_recent', { p_limit: 200, p_only_unresolved: true });
    if (error) return;
    const n = (data ?? []).length;
    const badge = document.getElementById('logsBadge');
    if (!badge) return;
    if (n > 0) { badge.textContent = String(n); badge.hidden = false; }
    else badge.hidden = true;
  } catch { /* тихо: бейдж необязателен */ }
}

async function loadLogs() {
  if (!abcClient) return;
  const body = document.getElementById('logsBody')!;
  body.innerHTML = `<div class="abc-hint mono">загрузка…</div>`;
  try {
    const { data, error } = await abcClient.rpc('ops_events_recent', {
      p_limit: 200, p_only_unresolved: logsOnlyUnresolved,
    });
    if (error) { body.innerHTML = `<div class="abc-hint mono">ошибка: ${error.message}</div>`; return; }
    const rows = (data ?? []) as LogRow[];
    if (!rows.length) {
      body.innerHTML = `<div class="logs-empty"><div class="logs-empty-mark">✓</div><div>Событий нет${logsOnlyUnresolved ? ' — всё разобрано' : ''}</div></div>`;
      return;
    }
    body.innerHTML = rows.map(renderLogRow).join('');
    body.querySelectorAll<HTMLButtonElement>('.log-resolve').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id);
        btn.disabled = true; btn.textContent = '…';
        const { error: e } = await abcClient!.rpc('ops_event_resolve', { p_id: id });
        if (e) { btn.disabled = false; btn.textContent = 'разобрать'; return; }
        loadLogs(); refreshLogsBadge();
      });
    });
  } catch (e: any) {
    body.innerHTML = `<div class="abc-hint mono">не удалось загрузить логи: ${e?.message ?? e}</div>`;
  }
}

function fmtLogTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderLogRow(r: LogRow): string {
  const typeLabel = LOG_TYPE_LABEL[r.event_type] ?? r.event_type;
  const bar = r.location_id != null ? (BAR_NAME[r.location_id] ?? `loc ${r.location_id}`) : '—';
  const resolveBtn = r.resolved
    ? `<span class="log-done mono">разобрано</span>`
    : `<button class="log-resolve" data-id="${r.id}">разобрать</button>`;
  return `
    <div class="log-row log-${r.severity} ${r.resolved ? 'log-resolved' : ''}">
      <div class="log-main">
        <div class="log-line1">
          <span class="log-type log-type-${r.severity}">${typeLabel}</span>
          <span class="log-bar mono">${bar}</span>
          <span class="log-time mono">${fmtLogTime(r.created_at)}</span>
        </div>
        <div class="log-msg">${r.message}</div>
      </div>
      <div class="log-actions">${resolveBtn}</div>
    </div>`;
}

type AbcRow = {
  grp: string; product: string; qty: number; revenue: number;
  share_pct: number; total_share_pct: number; cum_pct: number; abc: string;
};

async function loadAbc() {
  if (!abcClient) return;
  abcLoaded = true;
  const body = document.getElementById('abcBody')!;
  body.innerHTML = `<div class="abc-hint mono">загрузка…</div>`;
  try {
    const results = await Promise.all(
      BARS.map((b) => abcClient!.rpc('abc_analysis', { p_location: b.id, p_period: abcPeriod }))
    );
    // rowsByBar[i] = строки ABC для BARS[i]
    const rowsByBar: AbcRow[][] = results.map((res) => (res.error ? [] : ((res.data ?? []) as AbcRow[])));
    const anyError = results.find((r) => r.error);
    if (anyError?.error && rowsByBar.every((r) => r.length === 0)) {
      body.innerHTML = `<div class="abc-hint mono">ошибка: ${anyError.error.message}</div>`;
      return;
    }
    body.innerHTML = renderAbcGrid(rowsByBar);
  } catch (e: any) {
    body.innerHTML = `<div class="abc-hint mono">не удалось загрузить ABC: ${e?.message ?? e}</div>`;
  }
}

// одна таблица товаров одного бара в одной группе
function abcTable(grp: string, rows: AbcRow[]): string {
  if (!rows.length) return `<div class="abc-hint mono">нет данных</div>`;
  const counts = { A: 0, B: 0, C: 0 } as Record<string, number>;
  rows.forEach((r) => { counts[r.abc] = (counts[r.abc] || 0) + 1; });
  const total = rows.reduce((s, r) => s + r.revenue, 0);
  const body = rows.map((r) => `
    <tr class="abc-tr abc-${r.abc}">
      <td class="abc-cls"><span class="abc-badge abc-badge-${r.abc}">${r.abc}</span></td>
      <td class="abc-name">${r.product}</td>
      <td class="abc-qty mono">${rub.format(Math.round(r.qty))}</td>
      <td class="abc-rev mono">${rub.format(Math.round(r.revenue))} ₽</td>
      <td class="abc-share mono">${r.total_share_pct}%</td>
      <td class="abc-cum mono">${r.cum_pct}%</td>
    </tr>`).join('');
  return `
    <div class="abc-cell-sum mono">${rub.format(Math.round(total))} ₽ · A:${counts.A} B:${counts.B} C:${counts.C}</div>
    <table class="abc-table">
      <thead><tr><th></th><th>Товар</th><th class="mono">шт</th><th class="mono">выручка</th><th class="mono">% общ</th><th class="mono">накоп.</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

// сетка: строки = группы (пиво/еда/снеки), колонки = бары
function renderAbcGrid(rowsByBar: AbcRow[][]): string {
  // шапка с названиями баров
  const head = `
    <div class="abc-grid-head">
      ${BARS.map((b) => `<div class="abc-grid-bar">${b.name}</div>`).join('')}
    </div>`;

  const groupRows = GRP_ORDER.map((g) => {
    // есть ли вообще данные по этой группе хоть у одного бара
    const present = rowsByBar.some((rows) => rows.some((r) => r.grp === g));
    if (!present) return '';
    const cells = rowsByBar.map((rows, bi) => {
      const items = rows.filter((r) => r.grp === g);
      return `<div class="abc-cell" data-bar="${BARS[bi].name}">${abcTable(g, items)}</div>`;
    }).join('');
    return `
      <div class="abc-group">
        <div class="abc-group-head"><i class="dot dot-${g}"></i><span>${GRP_LABEL[g]}</span></div>
        <div class="abc-grid-row">${cells}</div>
      </div>`;
  }).join('');

  return `<div class="abc-grid">${head}${groupRows}</div>`;
}

function gate() {
  // already unlocked this session?
  if (sessionStorage.getItem(AUTH_KEY) === '1') { startDashboard(); return; }
  // no password configured → run open (avoids accidental lockout)
  if (!DASHBOARD_PASSWORD) { startDashboard(); return; }

  app.innerHTML = `
    <div class="lock">
      <form class="lock-card" id="lockForm">
        <div class="lock-mark"></div>
        <div class="lock-title">Выручка баров</div>
        <div class="lock-sub mono">введите пароль для доступа</div>
        <input id="pw" class="lock-input" type="password" autocomplete="current-password"
               placeholder="пароль" autofocus />
        <button class="lock-btn" type="submit">Войти</button>
        <div class="lock-err mono" id="lockErr"></div>
      </form>
    </div>`;

  const form = document.getElementById('lockForm') as HTMLFormElement;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = (document.getElementById('pw') as HTMLInputElement).value;
    if (val === DASHBOARD_PASSWORD) {
      sessionStorage.setItem(AUTH_KEY, '1');
      startDashboard();
    } else {
      const err = document.getElementById('lockErr')!;
      err.textContent = 'неверный пароль';
      const card = document.querySelector('.lock-card')!;
      card.classList.remove('shake'); void (card as HTMLElement).offsetWidth; card.classList.add('shake');
    }
  });
}

gate();
