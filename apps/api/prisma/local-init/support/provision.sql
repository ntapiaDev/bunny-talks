\set ON_ERROR_STOP on
\set ECHO none
SET log_statement = none;
SET log_min_error_statement = panic;
SET log_min_duration_statement = -1;
SET log_duration = off;
\getenv dev_password BUNNY_DEV_PASSWORD
\getenv test_password BUNNY_TEST_PASSWORD
\getenv admin_password POSTGRES_PASSWORD
SELECT pg_try_advisory_lock(4545001) AS locked \gset
\if :locked
\else
SELECT 1/0;
\endif
-- All preconditions are checked before the first mutation. Never repair existing resources.
SELECT current_user = 'bunny_admin'
 AND (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
 AND length(:'admin_password') >= 16
 AND left(:'admin_password', 13) <> 'replace_with_'
 AND left(:'dev_password', 13) <> 'replace_with_'
 AND left(:'test_password', 13) <> 'replace_with_'
 AND length(:'dev_password') >= 16 AND length(:'test_password') >= 16
 AND :'dev_password' <> :'test_password'
 AND :'admin_password' <> :'dev_password' AND :'admin_password' <> :'test_password'
 AND NOT EXISTS (
   SELECT 1 FROM pg_roles r WHERE rolname IN ('bunny_dev', 'bunny_test')
   AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR NOT rolcanlogin
     OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid OR roleid = r.oid)))
 AND NOT EXISTS (
   SELECT 1 FROM pg_database d WHERE datname IN ('bunny_talks', 'bunny_talks_test')
   AND (NOT has_database_privilege(datdba, d.oid, 'CONNECT')
     OR NOT has_database_privilege(datdba, d.oid, 'CREATE')
     OR pg_get_userbyid(datdba) <> CASE datname WHEN 'bunny_talks' THEN 'bunny_dev' ELSE 'bunny_test' END
     OR EXISTS (SELECT 1 FROM aclexplode(coalesce(datacl, acldefault('d',datdba))) a
       WHERE a.grantee NOT IN (datdba, (SELECT oid FROM pg_roles WHERE rolname = current_user))))) AS safe
\gset
\if :safe
\else
SELECT 1/0;
\endif
SELECT format('CREATE ROLE bunny_dev LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'dev_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bunny_dev') \gexec
SELECT format('CREATE ROLE bunny_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'test_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bunny_test') \gexec
SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'bunny_talks') AS create_dev,
 NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'bunny_talks_test') AS create_test \gset
\if :create_dev
CREATE DATABASE bunny_talks OWNER bunny_dev;
REVOKE ALL ON DATABASE bunny_talks FROM PUBLIC;
\endif
\if :create_test
CREATE DATABASE bunny_talks_test OWNER bunny_test;
REVOKE ALL ON DATABASE bunny_talks_test FROM PUBLIC;
\endif
SELECT NOT has_database_privilege('bunny_test','bunny_talks','CONNECT')
 AND NOT has_database_privilege('bunny_dev','bunny_talks_test','CONNECT')
 AND has_database_privilege('bunny_dev','bunny_talks','CREATE')
 AND has_database_privilege('bunny_test','bunny_talks_test','CREATE') AS isolated \gset
\if :isolated
\else
SELECT 1/0;
\endif
