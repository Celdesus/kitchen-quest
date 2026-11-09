-- Kitchen Quest go-live setup (REAL outlets, no example people). Run once in the Supabase SQL editor
-- INSTEAD of seed.sql. Then: select public.bootstrap_owner('Ivan Haynes', '<your email>'); and add people with
-- public.admin_add_person(...) (see supabase/migrations/20261102000006_admin_helpers.sql).
insert into public.outlets (slug, name, rollout_order, is_active, activated_at) values
  ('boughshed-kitchen', 'Boughshed Kitchen', 1, false, null),
  ('monkey-bar-kitchen', 'Monkey Bar Kitchen', 2, false, null),
  ('monkey-bar', 'Monkey Bar', 3, false, null),
  ('boughshed-bar', 'Boughshed Bar', 4, false, null);

insert into public.sections (slug, name, colour, sort_order) values
  ('prep', 'Prep', '#2f7d4f', 1), ('line', 'Line', '#c2410c', 2), ('pastry', 'Pastry', '#a21caf', 3), ('dish', 'Dish', '#1d4ed8', 4),
  ('bar', 'Bar', '#b45309', 5), ('barback', 'Bar back', '#0f766e', 6);

-- Ranking settings: 10 h/week minimum to be ranked (Ivan's setting) for the group board and all 4 outlets
insert into public.outlet_settings (outlet_id, min_hours_to_rank) values
  (null, 10.0), ((select id from public.outlets where slug = 'boughshed-kitchen'), 10.0), ((select id from public.outlets where slug = 'monkey-bar-kitchen'), 10.0), ((select id from public.outlets where slug = 'monkey-bar'), 10.0), ((select id from public.outlets where slug = 'boughshed-bar'), 10.0);

insert into public.badges (slug, name, description, icon) values
  ('hot-streak', 'Hot Streak', 'Top 3 two weeks running', '🔥'), ('on-fire', 'On Fire', 'Top 3 four weeks running', '🔥🔥'),
  ('unstoppable', 'Unstoppable', 'Top 3 eight weeks running', '🚀'), ('legend', 'Legend', 'Top 3 twelve weeks running', '👑'),
  ('deep-diver', 'Deep Diver', '5 verified deep cleans', '🤿'), ('fryer-whisperer', 'Fryer Whisperer', '10 fryer filters or boil-outs', '🍟'),
  ('mentor', 'Mentor', 'Buddied a new starter through their first week', '🤝'), ('no-shortcuts', 'No Shortcuts', 'A month with no points reversed', '✅'),
  ('handover-hero', 'Handover Hero', '10 handovers written and confirmed in a row', '📋');
