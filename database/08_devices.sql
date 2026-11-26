-- =====================================================================
-- CashPro — 08 : « تذكّرني » — appareils de confiance (jetons de session longs)
-- Le mot de passe n'est JAMAIS stocké : le poste garde un jeton aléatoire (chiffré par Windows),
-- la base ne garde que son empreinte SHA-256. Le jeton change à chaque utilisation.
-- Un changement de mot de passe (par n'importe quel chemin) invalide tous les appareils (pw_tag).
-- Script REJOUABLE : exécuté à chaque installation / mise à jour (données conservées).
-- =====================================================================
SET search_path = cashpro, public;

CREATE TABLE IF NOT EXISTS auth_devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id),
  token_hash     text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  pw_tag         text NOT NULL,               -- md5(password_hash) au moment de la création
  device_name    text,
  client         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_by     uuid REFERENCES users(id),
  revoked_reason text
);
CREATE INDEX IF NOT EXISTS auth_devices_user_idx ON auth_devices (user_id) WHERE revoked_at IS NULL;

ALTER TABLE auth_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS devices_select ON auth_devices;
CREATE POLICY devices_select ON auth_devices FOR SELECT USING (is_admin() OR user_id = current_uid());
DROP POLICY IF EXISTS backup_read ON auth_devices;
CREATE POLICY backup_read ON auth_devices FOR SELECT TO cashpro_backup USING (true);

-- L'application ne lit jamais l'empreinte du jeton ; écriture uniquement par les fonctions ci-dessous
REVOKE ALL ON auth_devices FROM cashpro_app;
GRANT SELECT (id, user_id, device_name, client, created_at, last_used_at, expires_at, revoked_at, revoked_reason)
  ON auth_devices TO cashpro_app;
GRANT SELECT ON auth_devices TO cashpro_backup;

-- Paramètre : activé, durée (jours), autorisé pour l'administrateur / pour les autres utilisateurs
INSERT INTO app_settings (key, value)
VALUES ('remember_me', '{"enabled": true, "days": 30, "admin": true, "users": true}')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION remember_settings() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT '{"enabled": true, "days": 30, "admin": true, "users": true}'::jsonb
         || coalesce((SELECT value FROM app_settings WHERE key = 'remember_me'), '{}'::jsonb)
$$;

-- Création (à la connexion réussie, avant authentification JWT) : NULL si « تذكّرني » est interdit pour ce compte
CREATE OR REPLACE FUNCTION auth_device_create(p_user uuid, p_hash text, p_name text, p_client text)
RETURNS TABLE (id uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
DECLARE
  s jsonb := remember_settings();
  u users;
  v_days int := least(greatest(coalesce((s ->> 'days')::int, 30), 1), 365);
  v_id uuid; v_exp timestamptz;
BEGIN
  SELECT * INTO u FROM users WHERE users.id = p_user AND is_active;
  IF NOT FOUND OR NOT coalesce((s ->> 'enabled')::boolean, true)
     OR NOT coalesce((s ->> CASE WHEN u.role = 'admin' THEN 'admin' ELSE 'users' END)::boolean, true) THEN
    RETURN;
  END IF;
  v_exp := now() + make_interval(days => v_days);
  INSERT INTO auth_devices (user_id, token_hash, pw_tag, device_name, client, expires_at)
  VALUES (u.id, p_hash, md5(u.password_hash), left(nullif(trim(p_name), ''), 80), left(p_client, 120), v_exp)
  RETURNING auth_devices.id INTO v_id;
  -- 10 appareils actifs au maximum par compte : les plus anciens sont révoqués
  UPDATE auth_devices d SET revoked_at = now(), revoked_reason = 'Limite de 10 appareils'
  WHERE d.user_id = u.id AND d.revoked_at IS NULL AND d.id NOT IN (
    SELECT d2.id FROM auth_devices d2 WHERE d2.user_id = u.id AND d2.revoked_at IS NULL ORDER BY d2.last_used_at DESC LIMIT 10);
  PERFORM set_config('cashpro.user_id', u.id::text, true);
  PERFORM log_event('remember_device_created', NULL, jsonb_build_object('device', p_name, 'client', p_client));
  RETURN QUERY SELECT v_id, v_exp;
END $$;

-- Utilisation : vérifie le jeton, le remplace par un nouveau (rotation) et prolonge la validité
CREATE OR REPLACE FUNCTION auth_device_rotate(p_old_hash text, p_new_hash text, p_client text)
RETURNS TABLE (user_id uuid, full_name text, role user_role, locale text, theme text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
DECLARE
  s jsonb := remember_settings();
  d auth_devices; u users;
  v_days int := least(greatest(coalesce((s ->> 'days')::int, 30), 1), 365);
BEGIN
  SELECT * INTO d FROM auth_devices WHERE token_hash = p_old_hash FOR UPDATE;
  IF NOT FOUND OR d.revoked_at IS NOT NULL OR d.expires_at <= now() THEN RETURN; END IF;
  SELECT * INTO u FROM users WHERE users.id = d.user_id;
  IF NOT u.is_active OR (u.locked_until IS NOT NULL AND u.locked_until > now())
     OR md5(u.password_hash) <> d.pw_tag
     OR NOT coalesce((s ->> 'enabled')::boolean, true)
     OR NOT coalesce((s ->> CASE WHEN u.role = 'admin' THEN 'admin' ELSE 'users' END)::boolean, true) THEN
    UPDATE auth_devices SET revoked_at = now(), revoked_reason = 'Session invalide (mot de passe changé, compte désactivé ou option retirée)'
    WHERE auth_devices.id = d.id;
    RETURN;
  END IF;
  UPDATE auth_devices SET token_hash = p_new_hash, last_used_at = now(), client = left(p_client, 120),
         expires_at = now() + make_interval(days => v_days)
  WHERE auth_devices.id = d.id;
  UPDATE users SET last_login_at = now() WHERE users.id = u.id;
  RETURN QUERY SELECT u.id, u.full_name, u.role, u.locale, u.theme, now() + make_interval(days => v_days);
END $$;

-- Déconnexion : le poste présente son jeton
CREATE OR REPLACE FUNCTION auth_device_logout(p_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = cashpro, public AS $$
  UPDATE auth_devices SET revoked_at = now(), revoked_reason = 'Déconnexion'
  WHERE token_hash = p_hash AND revoked_at IS NULL
$$;

-- Révocation par l'utilisateur lui-même ou par l'administrateur (p_device NULL = tous les appareils de p_user)
CREATE OR REPLACE FUNCTION auth_device_revoke(p_user uuid, p_device uuid, p_reason text DEFAULT NULL) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
DECLARE n int;
BEGIN
  IF current_uid() IS NULL OR (current_uid() <> p_user AND NOT is_admin()) THEN
    RAISE EXCEPTION 'CP004: réservé à l''administrateur' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE auth_devices SET revoked_at = now(), revoked_by = current_uid(),
         revoked_reason = coalesce(nullif(trim(p_reason), ''), 'Révoqué')
  WHERE user_id = p_user AND revoked_at IS NULL AND (p_device IS NULL OR id = p_device);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    PERFORM log_event('remember_device_revoked', NULL, jsonb_build_object('user', p_user, 'device', p_device, 'count', n));
  END IF;
  RETURN n;
END $$;

REVOKE EXECUTE ON FUNCTION remember_settings(), auth_device_create(uuid, text, text, text),
  auth_device_rotate(text, text, text), auth_device_logout(text), auth_device_revoke(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION remember_settings(), auth_device_create(uuid, text, text, text),
  auth_device_rotate(text, text, text), auth_device_logout(text), auth_device_revoke(uuid, uuid, text) TO cashpro_app;
