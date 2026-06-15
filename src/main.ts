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
  totalYtd: number;                                       // year-to-date (с 1 января)
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
          <div class="title">Выручка за смену</div>
          <div class="sub" id="today">—</div>
        </div>
      </div>
      <div class="conn" id="conn"><span class="led" id="led"></span><span id="connText" class="mono">соединение…</span></div>
    </header>

    <section class="hero">
      <div class="hero-row">
        <div class="hero-col">
          <div class="hero-label mono">Сегодня · вся выручка</div>
          <div class="hero-num"><span id="total">0</span><i>₽</i></div>
        </div>
        <div class="hero-col hero-col-month">
          <div class="hero-label mono">С начала месяца · вся</div>
          <div class="hero-num hero-num-sm"><span id="totalMonth">0</span><i>₽</i></div>
        </div>
        <div class="hero-col hero-col-year">
          <div class="hero-label mono">С начала года · вся</div>
          <div class="hero-num hero-num-sm"><span id="totalYtd">0</span><i>₽</i></div>
        </div>
      </div>
      <div class="hero-foot mono" id="heroFoot">—</div>
    </section>

    <section class="cards" id="cards"></section>

    <footer class="foot mono" id="foot"></footer>
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
    totalYtd: Number(r.total_ytd ?? 0),
    totalYa: Number(r.total_revenue_ya ?? 0), totalMYa: Number(r.total_month_ya ?? 0),
    yaDate: r.ya_date ?? null,
  };
}

function yoyBadge(now: number, ya: number): string {
  // no comparable history (e.g. bar not yet open a year ago)
  if (!ya || ya <= 0) return `<em class="yoy yoy-flat mono">нет данных год назад</em>`;
  const pct = Math.round(((now - ya) / ya) * 100);
  const cls = pct > 0 ? 'yoy-up' : pct < 0 ? 'yoy-down' : 'yoy-flat';
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '·';
  const sign = pct > 0 ? '+' : '';
  return `<em class="yoy ${cls} mono">${arrow} ${sign}${pct}% · ${rub.format(Math.round(ya))} ₽ год назад</em>`;
}

function paint(bumpId?: number) {
  const sorted = [...rows.values()].sort((a, b) => b.totalM - a.totalM);
  const total = sorted.reduce((s, r) => s + (r.total || 0), 0);
  const totalMonth = sorted.reduce((s, r) => s + (r.totalM || 0), 0);
  const totalYtd = sorted.reduce((s, r) => s + (r.totalYtd || 0), 0);
  // YoY only across bars that have comparable history (ya MTD > 0)
  const totalMonthYa = sorted.reduce((s, r) => s + (r.totalMYa > 0 ? r.totalMYa : 0), 0);
  const totalMonthCmp = sorted.reduce((s, r) => s + (r.totalMYa > 0 ? r.totalM : 0), 0);
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
        <div class="rail rail-stack">
          ${seg(r.mrev, 'beer')}${seg(r.foodM, 'food')}${seg(r.snacksM, 'snacks')}${seg(r.otherM, 'other')}
        </div>
        <div class="card-month">
          <span class="card-month-val">${rub.format(Math.round(r.totalM))} ₽</span>
          <span class="card-month-lbl mono">за месяц · всё</span>
        </div>
        <div class="card-year">
          <span class="card-year-val mono">${rub.format(Math.round(r.totalYtd))} ₽</span>
          <span class="card-year-lbl mono">с начала года</span>
        </div>
        <div class="card-yoy">${yoyBadge(r.totalM, r.totalMYa)}</div>
        <div class="groups">
          ${grpRow('beer', 'Пиво и сидр', r.rev, r.mrev, r.total, r.totalM)}
          ${grpRow('food', 'Еда', r.food, r.foodM, r.total, r.totalM)}
          ${grpRow('snacks', 'Закуски', r.snacks, r.snacksM, r.total, r.totalM)}
        </div>
      </article>`;
  }).join('');

  const hf = document.getElementById('heroFoot')!;
  if (sorted.length) {
    const badge = totalMonthYa > 0
      ? yoyBadge(totalMonthCmp, totalMonthYa)
      : '';
    hf.innerHTML = `${sorted.length} бара · лидер месяца ${sorted[0].name}${badge ? ' · ' + badge : ''}`;
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
    .select('location_id, location_name, beer_revenue, beer_qty, month_revenue, month_qty, food_revenue, snacks_revenue, other_revenue, beer_month, food_month, snacks_month, other_month, total_revenue, total_month, total_ytd, total_revenue_ya, total_month_ya, ya_date');
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
