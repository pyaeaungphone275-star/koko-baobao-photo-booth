-- Shared memories for the Koko & BaoBao photo booth.
--
-- Rooms only exist as Realtime channels, so room_members records
-- which signed-in users have entered which room. Memories and their
-- photos are readable only by members of the memory's room.


-- ---------- ROOM MEMBERS ----------

create table if not exists public.room_members (
  room_code text not null check (room_code ~ '^[A-Z0-9]{6}$'),
  user_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_code, user_id)
);

alter table public.room_members enable row level security;

drop policy if exists "Users can see their own room memberships" on public.room_members;
create policy "Users can see their own room memberships"
  on public.room_members for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "Users can add themselves to a room" on public.room_members;
create policy "Users can add themselves to a room"
  on public.room_members for insert
  to authenticated
  with check (user_id = auth.uid());


-- ---------- MEMORIES ----------

create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  room_code text not null check (room_code ~ '^[A-Z0-9]{6}$'),
  created_by uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  photo_path text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists memories_room_code_created_at_idx
  on public.memories (room_code, created_at desc);

alter table public.memories enable row level security;

drop policy if exists "Room members can read room memories" on public.memories;
create policy "Room members can read room memories"
  on public.memories for select
  to authenticated
  using (
    exists (
      select 1 from public.room_members m
      where m.room_code = memories.room_code
        and m.user_id = auth.uid()
    )
  );

drop policy if exists "Room members can create their own memories" on public.memories;
create policy "Room members can create their own memories"
  on public.memories for insert
  to authenticated
  with check (
    created_by = auth.uid()
    and photo_path = room_code || '/' || id::text || '.jpg'
    and exists (
      select 1 from public.room_members m
      where m.room_code = memories.room_code
        and m.user_id = auth.uid()
    )
  );


-- ---------- STORAGE (private bucket) ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('memories', 'memories', false, 5242880, array['image/jpeg'])
on conflict (id) do nothing;

-- Photos live at <room_code>/<memory_id>.jpg

drop policy if exists "Room members can read room photos" on storage.objects;
create policy "Room members can read room photos"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'memories'
    and exists (
      select 1 from public.room_members m
      where m.room_code = (storage.foldername(name))[1]
        and m.user_id = auth.uid()
    )
  );

drop policy if exists "Room members can upload room photos" on storage.objects;
create policy "Room members can upload room photos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'memories'
    and exists (
      select 1 from public.room_members m
      where m.room_code = (storage.foldername(name))[1]
        and m.user_id = auth.uid()
    )
  );
