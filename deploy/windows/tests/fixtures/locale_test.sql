select lower('ÁÉÍÓÚÑ') l, upper('áéíóúñ') u, 'a' < 'B' a_lt_B, 'é' ilike 'É' ilike_e, 'Z' < 'a' Z_lt_a, 'ñ' > 'n' nt_gt_n, 'é' > 'z' e_gt_z, initcap('ñandú ÉPICO') ic;
select string_agg(v, '|' order by v) from (values ('zeta'),('Álamo'),('alamo'),('Zorro'),('ñu'),('nu'),('Ñu'),('Éclair'),('eclair'),('ábaco'),('Abaco'),('_x'),('1a'),('a b'),('ab'),('Ñandú'),('Épico'),('Bohemia Obscura'),('Bohemia Oscura'),('BIDÓN DE ACEITE'),('CAJETILLA M.GOLD 14´S'),('Dañada'),('dañada'),('Dedos de Queso'),('coca-cola'),('Coca Cola')) t(v);
select md5(string_agg(v, '|' order by v)) from (select chr(i) || chr(j) v from generate_series(32, 400) i, generate_series(65, 90) j where i not in (127,133,160,173)) t;
select count(*) from (values ('Ñandú'),('Épico'),('ábaco'),('nandu')) t(v) where v ilike '%é%' or v ilike '%Ñ%' or v ilike '%Á%';
select count(*) from (values ('Ñandú'),('Épico'),('ábaco'),('nandu')) t(v) where lower(v) like '%a%';
select lower('İ') = 'i̇', length('ñandú'), octet_length('ñandú');
select to_tsvector('english', 'Los niños corren') ::text;
