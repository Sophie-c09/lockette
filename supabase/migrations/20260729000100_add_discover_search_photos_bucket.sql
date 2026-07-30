-- Hybrid image + semantic search upgrade — storage bucket for a user's
-- uploaded "search by photo" inspiration image on /discover
-- (src/app/actions/discover-feed.ts's searchDiscoverByPhoto,
-- src/lib/discover-search-photo.ts). Same private-bucket/signed-URL
-- shape as the existing outfit-photos bucket (see supabase/schema.sql's
-- own comment on this bucket for the full reasoning, including why these
-- uploads are deleted right after use instead of kept around).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'discover-search-photos',
  'discover-search-photos',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Discover search photos are viewable by their owner or admin" on storage.objects;
create policy "Discover search photos are viewable by their owner or admin"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'discover-search-photos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

drop policy if exists "Users can upload their own discover search photos" on storage.objects;
create policy "Users can upload their own discover search photos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'discover-search-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can delete their own discover search photos" on storage.objects;
create policy "Users can delete their own discover search photos"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'discover-search-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
