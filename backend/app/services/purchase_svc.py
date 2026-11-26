"""Weekly purchase forecast (batch E3).

One source -- the v_purchase_forecast view (analytics_views.py) -- and one place
that words it, so the Reportes screen, the Sunday email and the Telegram bot
say the same thing. The bot runs in its own container without this package; it
queries the same view and mirrors format_text() (keep them in step).
"""
import logging
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import text

from app.extensions import db

log = logging.getLogger(__name__)

ESTADOS = {
    'URGENTE': ('🔴', 'Urgente — se acaba esta semana'),
    'COMPRAR': ('🟡', 'Comprar para la semana'),
    'MINIMO':  ('⚪', 'Por tu mínimo de stock'),
}
_MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']


def _d(v) -> Decimal:
    return Decimal(str(v or 0))


def _fmt_qty(v) -> str:
    v = _d(v)
    return f'{v:.0f}' if v == v.to_integral_value() else f'{v.normalize():f}'


def _fecha(d) -> str:
    return f'{d.day} {_MESES[d.month - 1]}'


def _pesos(cents) -> str:
    return f'${int(cents or 0) / 100:,.2f}'


def _plural(word: str, n) -> str:
    """Spanish plural of a unit name for a quantity: botella -> botellas, porcion -> porciones."""
    w = (word or '').strip()
    try:
        one = float(n) == 1
    except (TypeError, ValueError):
        one = False
    if one or not w or w.endswith('s') or w in ('ml', 'kg', 'g', 'l', 'oz'):
        return w
    return w + ('s' if w[-1] in 'aeiouáéó' else 'es')


def _unit_names() -> dict:
    return {r.key: (r.name_es or r.key) for r in db.session.execute(
        text("SELECT key, name_es FROM unit_catalog")).all()}


def forecast() -> dict:
    """Everything the screen / email / bot need, already worded."""
    units = _unit_names()
    rows = db.session.execute(text("SELECT * FROM v_purchase_forecast")).mappings().all()
    items = []
    for r in rows:
        unit = units.get(r['base_unit_key'], r['base_unit_key'] or '')
        buy = _d(r['comprar_unidades'])
        if r['comprar_paquetes']:
            pu = units.get(r['purchase_unit_key'], 'paquete') if r['purchase_unit_key'] else 'paquete'
            comprar_txt = (f"{r['comprar_paquetes']} {_plural(pu.lower(), r['comprar_paquetes'])} "
                           f"({_fmt_qty(buy)} {_plural(unit.lower(), buy)})")
        else:
            comprar_txt = f"{_fmt_qty(buy)} {_plural(unit.lower(), buy)}"
        items.append({
            'id': r['inventory_item_id'], 'nombre': r['name'], 'categoria': r['category'],
            'proveedor': r['supplier'], 'unidad': unit,
            'estado': r['estado'],
            'semanal': float(r['semanal_4s'] or 0), 'pronostico': float(r['pronostico_semana'] or 0),
            'disponible': float(r['disponible'] or 0), 'minimo': float(r['minimo'] or 0),
            'comprar': float(buy), 'comprar_paquetes': r['comprar_paquetes'], 'comprar_txt': comprar_txt,
            'costo_estimado_cents': int(r['costo_estimado_cents']) if r['costo_estimado_cents'] is not None else None,
            'dias_cobertura': float(r['dias_cobertura']) if r['dias_cobertura'] is not None else None,
            'abierto': r['producto_abierto'],
        })
    hasta = rows[0]['datos_hasta'] if rows else None
    to_buy = [i for i in items if i['estado'] in ESTADOS]

    from app.services.venue_svc import bar_tz, business_today, get_venue
    today = business_today()
    lunes = today + timedelta(days=(7 - today.weekday()) % 7 or 7)   # next Monday
    hasta_local = hasta.astimezone(bar_tz()).date() if hasta else None

    sin_receta = []
    if db.session.execute(text("SELECT to_regclass('public.v_menu_items_without_recipe') IS NOT NULL")).scalar():
        sin_receta = [r[0] for r in db.session.execute(text("""
            SELECT name FROM v_menu_items_without_recipe
             WHERE NOT COALESCE(has_modifier_coverage, FALSE) AND COALESCE(times_sold, 0) > 0
             ORDER BY times_sold DESC LIMIT 8""")).all()]
    revisar = [i['nombre'] for i in items
               if i['semanal'] > 0 and (i['dias_cobertura'] or 0) > 365][:6]
    safety = db.session.execute(text("""SELECT value FROM settings WHERE key = 'purchasing.safety_pct'""")).scalar()

    return {
        'negocio': get_venue()['name'],
        'semana_desde': lunes.isoformat(), 'semana_hasta': (lunes + timedelta(days=6)).isoformat(),
        'semana_txt': f'{_fecha(lunes)} al {_fecha(lunes + timedelta(days=6))}',
        'datos_desde': (hasta_local - timedelta(days=27)).isoformat() if hasta_local else None,
        'datos_hasta': hasta_local.isoformat() if hasta_local else None,
        'datos_txt': (f'{_fecha(hasta_local - timedelta(days=27))} al {_fecha(hasta_local)}'
                      if hasta_local else None),
        'colchon_pct': float(safety) if safety else 20.0,
        'items': items,
        'por_comprar': to_buy,
        'costo_total_cents': sum(i['costo_estimado_cents'] or 0 for i in to_buy),
        'sin_costo': sum(1 for i in to_buy if not i['costo_estimado_cents']),
        'sin_receta': sin_receta,
        'revisar': revisar,
    }


def format_text(f: dict, limit: int = 3800) -> str:
    """Plain text for Telegram (its limit is 4096 characters)."""
    out = [f"🛒 Compras — semana del {f['semana_txt']}",
           f"Según ventas del {f['datos_txt']} (4 semanas) + {f['colchon_pct']:.0f}% de colchón" if f['datos_txt']
           else 'Sin ventas registradas todavía.', '']
    if not f['por_comprar']:
        out.append('✅ Con lo que hay alcanza para la semana.')
    for est, (icon, title) in ESTADOS.items():
        grp = [i for i in f['por_comprar'] if i['estado'] == est]
        if not grp:
            continue
        out.append(f'{icon} {title}')
        for i in grp:
            extra = (f" · se venden ~{_fmt_qty(round(Decimal(str(i['pronostico'])), 1))}/sem, hay {_fmt_qty(i['disponible'])}"
                     if est != 'MINIMO' else f" · hay {_fmt_qty(i['disponible'])}, mínimo {_fmt_qty(i['minimo'])}")
            out.append(f"• {i['nombre']}: {i['comprar_txt']}{extra}")
        out.append('')
    if f['por_comprar']:
        tail = f" ({f['sin_costo']} sin costo registrado)" if f['sin_costo'] else ''
        out.append(f"💰 Costo estimado: {_pesos(f['costo_total_cents'])}{tail}")
    if f['sin_receta']:
        out.append(f"⚠️ Se venden sin receta (no cuentan aquí): {', '.join(f['sin_receta'][:5])}")
    if f['revisar']:
        out.append(f"🔎 Revisar receta o stock (duraría más de un año): {', '.join(f['revisar'])}")
    msg = '\n'.join(out).strip()
    return msg if len(msg) <= limit else msg[:limit - 40].rsplit('\n', 1)[0] + '\n… (ver Reportes → Inventario)'


def format_html(f: dict) -> str:
    """The Sunday email: what to buy, grouped by supplier."""
    from app.services.email_report_svc import _section, _td, _th, _no_data_row
    rows_by_sup: dict[str, list] = {}
    for i in f['por_comprar']:
        rows_by_sup.setdefault(i['proveedor'] or 'Sin proveedor', []).append(i)
    colors = {'URGENTE': '#DC2626', 'COMPRAR': '#B45309', 'MINIMO': '#64748B'}
    tables = ''
    for sup in sorted(rows_by_sup, key=lambda s: (s == 'Sin proveedor', s)):
        body = ''.join(
            f"<tr>{_td(i['nombre'], 'left', bold=True)}{_td(i['comprar_txt'], 'left')}"
            f"{_td(_fmt_qty(i['disponible']))}{_td(_fmt_qty(round(Decimal(str(i['pronostico'])), 1)))}"
            f"{_td(_pesos(i['costo_estimado_cents']) if i['costo_estimado_cents'] else '—')}"
            f"{_td(ESTADOS[i['estado']][1].split(' —')[0], 'left', color=colors[i['estado']])}</tr>"
            for i in rows_by_sup[sup])
        sub = sum(i['costo_estimado_cents'] or 0 for i in rows_by_sup[sup])
        tables += _section(f"{sup} · {_pesos(sub)}", f"""
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <tr>{_th('Producto', 'left')}{_th('Comprar', 'left')}{_th('Hay')}{_th('Venta/sem')}{_th('Costo')}{_th('', 'left')}</tr>
            {body}
          </table>""")
    if not tables:
        tables = _section('Compras', f'<table style="width:100%">{_no_data_row(1)}</table>'
                          .replace('Sin datos para este período', 'Con lo que hay alcanza para la semana.'))
    notes = ''
    if f['sin_costo']:
        notes += f"<li>{f['sin_costo']} producto(s) sin costo registrado: el total no los incluye.</li>"
    if f['sin_receta']:
        notes += f"<li>Se venden sin receta y no cuentan en el pronóstico: {', '.join(f['sin_receta'])}.</li>"
    if f['revisar']:
        notes += f"<li>Revisar receta o stock (durarían más de un año): {', '.join(f['revisar'])}.</li>"
    return f"""<!doctype html><html><body style="margin:0;background:#F1F5F9;font-family:Arial,sans-serif;">
  <div style="max-width:680px;margin:0 auto;background:#fff;padding:28px;">
    <h1 style="font-size:20px;margin:0 0 4px;color:#0F172A;">🛒 Compras — semana del {f['semana_txt']}</h1>
    <p style="color:#64748B;font-size:13px;margin:0 0 20px;">{f['negocio']} · según ventas del {f['datos_txt'] or '—'}
      (4 semanas) + {f['colchon_pct']:.0f}% de colchón · costo estimado
      <b style="color:#0F172A;">{_pesos(f['costo_total_cents'])}</b></p>
    {tables}
    {f'<ul style="color:#475569;font-size:12px;padding-left:18px;">{notes}</ul>' if notes else ''}
    <p style="color:#94A3B8;font-size:11px;margin-top:24px;">Detalle completo: Reportes → Inventario → Compras y rotación.</p>
  </div></body></html>"""


def send_weekly_email() -> dict:
    from app.services.email_report_svc import _send
    f = forecast()
    _send(f"🛒 Compras para la semana del {f['semana_txt']} — {f['negocio']}", format_html(f))
    log.info('Weekly purchase forecast sent (%d items to buy)', len(f['por_comprar']))
    return f
