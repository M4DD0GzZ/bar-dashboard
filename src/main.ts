import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import './style.css';

/**
 * Live bar-revenue monitor.
 * Reads the `live_revenue_today` vitrine (3 rows) and subscribes to Supabase
 * Realtime. Access is protected at the platform level by Vercel Authentication,
 * so there is no in-app password. The anon key comes from a build-time env var
 * (VITE_SUPABASE_ANON_KEY) and is safe in the browser — RLS exposes only the vitrine.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

type Row = { id: number; name: string; rev: number; qty: number };
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
      <div class="hero-label mono">Итого · пиво и сидр</div>
      <div class="hero-num"><span id="total">0</span><i>₽</i></div>
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

function paint(bumpId?: number) {
  const sorted = [...rows.values()].sort((a, b) => b.rev - a.rev);
  const total = sorted.reduce((s, r) => s + (r.rev || 0), 0);
  const max = sorted.reduce((m, r) => Math.max(m, r.rev || 0), 0) || 1;

  document.getElementById('total')!.textContent = rub.format(Math.round(total));

  const cards = document.getElementById('cards')!;
  cards.innerHTML = sorted.map((r, i) => {
    const pct = Math.max(3, Math.round((r.rev / max) * 100));
    const lead = i === 0 && r.rev > 0 ? ' lead' : '';
    const bump = r.id === bumpId ? ' bump' : '';
    return `
      <article class="card${lead}${bump}" data-id="${r.id}">
        <div class="card-top">
          <span class="rank mono">${String(i + 1).padStart(2, '0')}</span>
          <span class="name">${r.name}</span>
        </div>
        <div class="amount">${rub.format(Math.round(r.rev))}<i>₽</i></div>
        <div class="rail"><span style="width:${pct}%"></span></div>
        <div class="card-foot mono">${rub.format(Math.round(r.qty))} бут.</div>
      </article>`;
  }).join('');

  const hf = document.getElementById('heroFoot')!;
  hf.textContent = sorted.length
    ? `${sorted.length} бара · лидер ${sorted[0].name}`
    : 'нет данных';
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
    .select('location_id, location_name, beer_revenue, beer_qty');
  if (error) throw error;
  for (const r of data ?? []) {
    rows.set(r.location_id, {
      id: r.location_id, name: r.location_name,
      rev: Number(r.beer_revenue), qty: Number(r.beer_qty),
    });
  }
  lastUpdate = new Date();
}

async function main() {
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
        rows.set(r.location_id, {
          id: r.location_id, name: r.location_name,
          rev: Number(r.beer_revenue), qty: Number(r.beer_qty),
        });
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

main();
