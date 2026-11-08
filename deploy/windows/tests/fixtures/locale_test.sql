select lower('ÁÉÍÓÚÑ') l, upper('áéíóúñ') u, 'a' < 'B' a_lt_B, 'é' ilike 'É' ilike_e, 'Z' < 'a' Z_lt_a, 'ñ' > 'n' nt_gt_n, 'é' > 'z' e_gt_z, initcap('ñandú ÉPICO') ic;
select string_agg(v, '|' order by v) from (values ('zeta'),('Álamo'),('alamo'),('Zorro'),('ñu'),('nu'),('Ñu'),('Éclair'),('eclair'),('ábaco'),('Abaco'),('_x'),('1a'),('a b'),('ab'),('Ñandú'),('Épico'),('Bohemia Obscura'),('Bohemia Oscura'),('BIDÓN DE ACEITE'),('CAJETILLA M.GOLD 14´S'),('Dañada'),('dañada'),('Dedos de Queso'),('coca-cola'),('Coca Cola')) t(v);
select md5(string_agg(v, '|' order by v)) from (select chr(i) || chr(j) v from generate_series(32, 400) i, generate_series(65, 90) j) t;
-- Case mapping over U+00A0..U+024F (every Spanish letter incl. Ü/ü lives here). Excluded code points are genuine
-- alpine(musl)-vs-Windows differences in NON-Spanish characters, found by diffing per-char output of both:
--   181 µ micro sign (musl upper -> Μ), 223 ß (musl upper -> ẞ; R10), 255 ÿ (Windows upper -> U+009F, musl Ÿ),
--   304 İ and 305 ı (Turkish dotted/dotless i), 383 ſ (long s), 453/456/459/498 Ǆ-style digraph titlecase forms,
--   575/576 ȿ ɀ (Windows leaves unchanged).
select md5(string_agg(lower(chr(i)) || upper(chr(i)), '' order by i)) from generate_series(160, 591) i where i not in (181, 223, 255, 304, 305, 383, 453, 456, 459, 498, 575, 576);
select lower('Ü'), upper('ü'), 'ü' ilike 'Ü', 'Güero' ilike '%ÜE%', lower('PINGÜINO'), initcap('pingüino ÜBER');
select count(*) from (values ('Ñandú'),('Épico'),('ábaco'),('nandu')) t(v) where v ilike '%é%' or v ilike '%Ñ%' or v ilike '%Á%';
select count(*) from (values ('Ñandú'),('Épico'),('ábaco'),('nandu')) t(v) where lower(v) like '%a%';
select lower('İ') = 'i̇', length('ñandú'), octet_length('ñandú');
select to_tsvector('english', 'Los niños corren') ::text;
