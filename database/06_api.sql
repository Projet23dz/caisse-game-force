-- =====================================================================
-- CashPro — 06_api.sql : fonctions d'appui pour l'API (phase 2)
-- À exécuter après 01 → 05.
-- =====================================================================
SET search_path = cashpro, public;

-- Mot de passe à changer à la prochaine connexion (liste dans app_settings)
CREATE FUNCTION must_change_password(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT coalesce((SELECT value ? p_user::text FROM app_settings WHERE key = 'force_password_change'), false)
$$;

CREATE FUNCTION set_force_password_change(p_user uuid, p_on boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
BEGIN
  -- l'utilisateur peut lever son propre drapeau ; seul l'admin peut le poser sur quelqu'un
  IF p_on AND NOT is_admin() THEN RAISE EXCEPTION 'CP004: réservé à l''administrateur'; END IF;
  IF NOT p_on AND current_uid() IS DISTINCT FROM p_user AND NOT is_admin() THEN
    RAISE EXCEPTION 'CP004: réservé à l''administrateur';
  END IF;
  INSERT INTO app_settings (key, value, updated_by) VALUES ('force_password_change', '[]'::jsonb, current_uid())
  ON CONFLICT (key) DO NOTHING;
  UPDATE app_settings SET updated_by = current_uid(), updated_at = now(),
    value = CASE WHEN p_on
                 THEN (SELECT coalesce(jsonb_agg(DISTINCT x), '[]'::jsonb) FROM jsonb_array_elements_text(value || to_jsonb(p_user::text)) x)
                 ELSE (SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements_text(value) x WHERE x <> p_user::text) END
  WHERE key = 'force_password_change';
END $$;

-- Hash actuel de l'utilisateur connecté (vérification avant changement de mot de passe)
CREATE FUNCTION my_password_hash() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT password_hash FROM users WHERE id = current_uid() AND is_active
$$;

-- Entreprises accessibles + permissions effectives de l'utilisateur connecté
CREATE FUNCTION my_businesses()
RETURNS TABLE (id uuid, code text, name text, activity text, color text, logo_path text, profile text,
               permissions jsonb, allowed_accounts uuid[], max_amount numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT b.id, b.code, b.name, b.activity, b.color, b.logo_path,
         CASE WHEN is_admin() THEN 'admin' ELSE bu.profile::text END,
         CASE WHEN is_admin() THEN (SELECT jsonb_object_agg(k, true) FROM jsonb_object_keys(default_permissions('manager')) k)
                                   || '{"manage_categories": true, "manage_employees": true}'::jsonb
              ELSE bu.permissions END,
         CASE WHEN is_admin() THEN NULL ELSE bu.allowed_accounts END,
         CASE WHEN is_admin() THEN NULL ELSE bu.max_amount END
  FROM businesses b
  LEFT JOIN business_users bu ON bu.business_id = b.id AND bu.user_id = current_uid()
  WHERE b.is_active AND (is_admin() OR (bu.is_active AND bu.user_id IS NOT NULL))
  ORDER BY b.sort_order, b.name
$$;

REVOKE EXECUTE ON FUNCTION must_change_password(uuid), set_force_password_change(uuid, boolean), my_password_hash(), my_businesses() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION must_change_password(uuid), set_force_password_change(uuid, boolean), my_password_hash(), my_businesses() TO cashpro_app;
