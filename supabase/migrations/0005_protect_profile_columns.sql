-- =============================================================================
-- Live Shop — protect privileged profile columns from client self-grant.
--
-- Problem (audit finding C1/M1/L1): the `profiles_update_own` RLS policy lets a
-- user UPDATE their own row, and RLS does not restrict WHICH columns. There are
-- no REVOKEs anywhere, so `seller_status`, `is_verified`, `role`,
-- `seller_applied_at`, and `seller_reviewed_at` were all client-writable. A user
-- could do, from the browser:
--     update profiles set seller_status='approved' where id = <self>
-- and bypass the ENTIRE seller-application + operator-approval workflow
-- (defeating 0003's purpose), self-grant the verified ✓ badge (which renders to
-- all viewers), and self-grant role='admin'.
--
-- Fix: a BEFORE UPDATE trigger that blocks changes to these columns unless the
-- caller is a privileged context. Privileged contexts are:
--   - the service role (API server's createSupabaseServiceClient) — detected via
--     the request.jwt.claim.role GUC (is_service_role());
--   - SECURITY DEFINER functions (e.g. submit_seller_application) and the SQL
--     editor — inside these, `current_user` resolves to the function owner /
--     `postgres`.
-- Direct client queries run as `authenticated`/`anon`, which are neither, so
-- they are blocked.
--
-- Clients can still freely update their own `display_name` (the only field they
-- legitimately change). INSERT is unaffected — it is already safe because the
-- handle_new_user trigger creates the profile on signup and the PK (id →
-- auth.users) prevents a client from inserting a second privileged row.
--
-- Idempotent + safe to re-run.
-- =============================================================================

-- True when the current caller may set privileged profile columns.
-- `is_service_role()` covers the API server's service-role client; the
-- `current_user` check covers SECURITY DEFINER functions and the SQL editor
-- (run as postgres), where the JWT GUC still reads 'authenticated'.
create or replace function public.is_privileged()
returns boolean
language sql
stable
as $$
  select public.is_service_role()
      or current_user in ('postgres', 'supabase_admin', 'service_role');
$$;

-- Block non-privileged UPDATEs that touch any privileged column. Ordinary
-- fields (display_name) pass through untouched.
create or replace function public.protect_profile_privileged_columns()
returns trigger
language plpgsql
as $$
begin
  if public.is_privileged() then
    return new;
  end if;
  if new.role is distinct from old.role
     or new.is_verified is distinct from old.is_verified
     or new.seller_status is distinct from old.seller_status
     or new.seller_applied_at is distinct from old.seller_applied_at
     or new.seller_reviewed_at is distinct from old.seller_reviewed_at then
    raise exception 'seller_status / role / is_verified are managed by the server only'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_columns on public.profiles;
create trigger protect_profile_columns
  before update on public.profiles
  for each row execute function public.protect_profile_privileged_columns();
