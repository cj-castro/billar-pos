-- Content fingerprint of a POS database: (check_name, value), one row per check, deterministic order.
-- Equal output for two databases = same rows, sequences, migrations and code objects.
-- Run: psql -X -At -f fingerprint.sql -d <db>
select 'table:' || n.nspname || '.' || c.relname,
       (xpath('/row/c/text()', x))[1]::text || '|' || (xpath('/row/m/text()', x))[1]::text
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral query_to_xml(
    format('select count(*) c, coalesce(md5(string_agg(t::text, ''|'' order by t::text)), ''-'') m from %I.%I t',
           n.nspname, c.relname), false, true, '') x
where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
union all
select 'sequence:' || schemaname || '.' || sequencename, coalesce(last_value::text, 'NULL')
from pg_sequences
union all
select 'schema_migrations',
       case when to_regclass('public.schema_migrations') is null then 'absent'
            else (xpath('/row/v/text()', query_to_xml(
                'select coalesce(string_agg(t::text, ''|'' order by t::text), '''') v from public.schema_migrations t',
                false, true, '')))[1]::text end
union all
select 'functions', coalesce(md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.oid::regprocedure::text)), '-')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname not in ('pg_catalog', 'information_schema') and p.prokind in ('f', 'p')
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
union all
select 'triggers', coalesce(md5(string_agg(pg_get_triggerdef(t.oid), '|' order by pg_get_triggerdef(t.oid))), '-')
from pg_trigger t where not t.tgisinternal
union all
select 'views', coalesce(md5(string_agg(pg_get_viewdef(c.oid), '|' order by n.nspname || '.' || c.relname)), '-')
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('v', 'm') and n.nspname not in ('pg_catalog', 'information_schema')
order by 1;
