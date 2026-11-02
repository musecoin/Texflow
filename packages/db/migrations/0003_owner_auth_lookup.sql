-- Migration 0003: let the pre-authentication SECURITY DEFINER functions work when the schema
-- owner is NOT a superuser (managed PostgreSQL such as Neon/RDS). FORCE ROW LEVEL SECURITY
-- applies to the owner too, so the owner gets a read-only policy on exactly the three tables
-- those functions read. The application role (texflow_app) is not the owner and is unaffected.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organization','app_user','user_session'] LOOP
    EXECUTE format('CREATE POLICY owner_auth_lookup ON %I FOR SELECT TO %I USING (true)', t, current_user);
  END LOOP;
END $$;
