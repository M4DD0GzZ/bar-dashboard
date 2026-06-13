# Bar Dashboard — выручка баров (live)

Защищённый дашборд выручки пива/сидра по трём барам в реальном времени.
Данные из Supabase (витрина `live_revenue_today`), обновления через Supabase Realtime.
Стек: Vite (vanilla TS), деплой на Vercel, доступ через Vercel Authentication.

---

## 1. Залить в публичный репозиторий GitHub

Создай новый репозиторий (например `bar-dashboard`) и залей в него все эти файлы.
`.env.local` и `node_modules` не коммитятся (см. `.gitignore`) — ключ туда не попадёт.

```
git init
git add .
git commit -m "live revenue dashboard"
git branch -M main
git remote add origin git@github.com:M4DD0GzZ/bar-dashboard.git
git push -u origin main
```

## 2. Импорт в Vercel

1. Vercel → **Add New → Project → Import** этого репозитория.
2. Framework Preset определится как **Vite** автоматически. Build command `vite build`,
   Output `dist` — оставь по умолчанию.
3. **Environment Variables** — добавь две:
   - `VITE_SUPABASE_URL` = `https://ywtsigztqdktpljdmhqp.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = твой anon public key
     (Supabase → Project Settings → API → «anon public»).
4. **Deploy**. Через минуту будет ссылка вида `bar-dashboard.vercel.app`.

## 3. Включить защиту (Vercel Authentication)

Settings проекта → **Deployment Protection** → **Vercel Authentication** → включить
(на платном Pro). Теперь дашборд открывается только тем, кто залогинен в твою
команду Vercel.

Добавить сотрудников: Vercel → Settings команды → **Members** → Invite.
Каждый входит под своей учёткой; отозвать доступ = удалить из Members.

---

## Локальный запуск (опционально)

```
cp .env.example .env.local      # впиши anon key
npm install
npm run dev                      # http://localhost:5173
```

## Почему anon-ключ в браузере — это нормально

Ключ публичный по дизайну Supabase. Защита — не в его секретности, а в RLS:
наружу открыта только витрина `live_revenue_today` (3 строки агрегатов).
Сырые продажи, себестоимость, маржа закрыты политиками и недоступны с anon-ключом.

## Дальше

Когда добавим еду/закуски: расширим витрину парой колонок и снимем фильтр
категории в воркере. Фронт изменится минимально — добавятся группы в карточках.
