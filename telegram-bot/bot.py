import os
import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from sqlalchemy import create_engine, text
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes
from apscheduler.schedulers.asyncio import AsyncIOScheduler

# The bar's wall clock. Every "today" / "yesterday" in this bot means the bar's
# calendar day, never the server's (the container and the database run in UTC).
BAR_TZ = ZoneInfo(os.getenv('BAR_TZ', 'America/Mexico_City'))

# ---------- CONFIG ----------
TOKEN = os.environ.get("TELEGRAM_TOKEN")
ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID")
DATABASE_URL = os.environ.get("DATABASE_URL")

if not TOKEN or not ADMIN_CHAT_ID or not DATABASE_URL:
    raise ValueError("Missing required env vars: TELEGRAM_TOKEN, ADMIN_CHAT_ID, DATABASE_URL")

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)

engine = create_engine(DATABASE_URL)

# ===================== SALES HELPERS =====================

def fetch_daily_sales():
    with engine.connect() as conn:
        result = conn.execute(text("""
            WITH daily_tickets AS (
                SELECT id, total_cents
                FROM tickets
                WHERE DATE(closed_at AT TIME ZONE 'America/Mexico_City') = (now() AT TIME ZONE 'America/Mexico_City')::date
                  AND status = 'CLOSED'
            ),
            daily_items AS (
                SELECT t.id AS ticket_id, COALESCE(SUM(tli.quantity), 0) AS items
                FROM tickets t
                LEFT JOIN ticket_line_items tli ON t.id = tli.ticket_id
                WHERE DATE(t.closed_at AT TIME ZONE 'America/Mexico_City') = (now() AT TIME ZONE 'America/Mexico_City')::date
                  AND t.status = 'CLOSED'
                GROUP BY t.id
            )
            SELECT 
                COALESCE(SUM(dt.total_cents), 0) AS total_revenue_cents,
                COALESCE(SUM(di.items), 0) AS total_items,
                COUNT(dt.id) AS transaction_count
            FROM daily_tickets dt
            LEFT JOIN daily_items di ON dt.id = di.ticket_id
        """))
        return result.fetchone()

def fetch_top_products(days=7):
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT 
                mi.name AS product_name,
                SUM(tli.quantity) AS total_qty,
                SUM(tli.quantity * tli.unit_price_cents) / 100.0 AS revenue_mxn
            FROM tickets t
            JOIN ticket_line_items tli ON t.id = tli.ticket_id
            JOIN menu_items mi ON tli.menu_item_id = mi.id
            WHERE DATE(t.closed_at AT TIME ZONE 'America/Mexico_City') >= (now() AT TIME ZONE 'America/Mexico_City')::date - :days
              AND t.status = 'CLOSED'
            GROUP BY mi.id, mi.name
            ORDER BY total_qty DESC
            LIMIT 5
        """), {"days": days})
        return result.fetchall()

def fetch_today_top_products(limit=5):
    """Top N products sold today (by quantity)."""
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT 
                mi.name AS product_name,
                SUM(tli.quantity) AS total_qty,
                SUM(tli.quantity * tli.unit_price_cents) / 100.0 AS revenue_mxn
            FROM tickets t
            JOIN ticket_line_items tli ON t.id = tli.ticket_id
            JOIN menu_items mi ON tli.menu_item_id = mi.id
            WHERE DATE(t.closed_at AT TIME ZONE 'America/Mexico_City') = (now() AT TIME ZONE 'America/Mexico_City')::date
              AND t.status = 'CLOSED'
            GROUP BY mi.id, mi.name
            ORDER BY total_qty DESC
            LIMIT :limit
        """), {"limit": limit})
        return result.fetchall()    

# ===================== INVENTORY HELPERS =====================

def search_inventory_by_name(search_term):
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT id, name, stock_quantity, low_stock_threshold, unit
            FROM inventory_items
            WHERE is_active = true
              AND name ILIKE :search
            ORDER BY name
            LIMIT 10
        """), {"search": f"%{search_term}%"})
        return result.fetchall()

def get_all_inventory(limit=50):
    """Get all active inventory items (limited to avoid message length)."""
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT name, stock_quantity, low_stock_threshold, unit
            FROM inventory_items
            WHERE is_active = true
            ORDER BY name
            LIMIT :limit
        """), {"limit": limit})
        return result.fetchall()


def get_low_stock_items():
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT id, name, stock_quantity, low_stock_threshold, unit
            FROM inventory_items
            WHERE is_active = true
              AND low_stock_threshold IS NOT NULL
              AND stock_quantity <= low_stock_threshold
            ORDER BY (stock_quantity / NULLIF(low_stock_threshold, 0)) ASC
        """))
        return result.fetchall()

async def stock_all(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        rows = get_all_inventory(50)  # Show up to 50 items
        if not rows:
            await update.message.reply_text("No active inventory items found.")
            return
        msg = "📦 ALL INVENTORY (first 50):\n"
        for name, stock, threshold, unit in rows:
            stock = float(stock)
            threshold = float(threshold) if threshold is not None else None
            status = "✅ OK" if threshold is None or stock > threshold else "⚠️ LOW"
            threshold_str = f" (Min: {threshold:.2f})" if threshold is not None else ""
            msg += f"- {name}: {stock:.2f} {unit}{threshold_str} {status}\n"
        await update.message.reply_text(msg)
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")    

def get_menu_item_by_name(menu_name):
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT id, name
            FROM menu_items
            WHERE is_active = true
              AND name ILIKE :name
            ORDER BY name
            LIMIT 1
        """), {"name": f"%{menu_name}%"})
        return result.fetchone()

def get_recipe_ingredients(menu_item_id):
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT 
                ii.name AS ingredient_name,
                ib.quantity AS needed_qty,
                ii.stock_quantity AS current_stock,
                ii.unit,
                ib.deduction_unit_key
            FROM insumos_base ib
            JOIN inventory_items ii ON ib.inventory_item_id = ii.id
            WHERE ib.menu_item_id = :menu_item_id
              AND ii.is_active = true
        """), {"menu_item_id": menu_item_id})
        return result.fetchall()

# ===================== MANAGEMENT HELPERS =====================

def get_executive_kpis():
    with engine.connect() as conn:
        result = conn.execute(text("""
            WITH today_tickets AS (
                SELECT 
                    id, 
                    total_cents, 
                    discount_cents, 
                    tip_cents,
                    (SELECT COALESCE(SUM(tli.quantity * tli.unit_price_cents), 0) 
                     FROM ticket_line_items tli 
                     WHERE tli.ticket_id = t.id) AS items_revenue
                FROM tickets t
                WHERE DATE(closed_at AT TIME ZONE 'America/Mexico_City') = (now() AT TIME ZONE 'America/Mexico_City')::date
                  AND status = 'CLOSED'
            )
            SELECT 
                COUNT(id) AS tickets_cerrados,
                COALESCE(SUM(total_cents) / 100.0, 0) AS ventas_mxn,
                COALESCE(SUM(total_cents - items_revenue) / 100.0, 0) AS billar_mxn,
                COALESCE(SUM(discount_cents) / 100.0, 0) AS descuentos_mxn,
                COALESCE(SUM(tip_cents) / 100.0, 0) AS propinas_mxn,
                COALESCE(AVG(total_cents) / 100.0, 0) AS ticket_promedio_mxn,
                COALESCE(SUM(total_cents) / 100.0, 0) AS venta_promedio_diaria_mxn
            FROM today_tickets
        """))
        return result.fetchone()

def get_anomalies():
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT 
                id AS ticket_id,
                closed_at,
                total_cents / 100.0 AS total_mxn,
                discount_cents / 100.0 AS discount_mxn,
                was_reopened,
                edited_after_close
            FROM tickets
            WHERE DATE(closed_at AT TIME ZONE 'America/Mexico_City') = (now() AT TIME ZONE 'America/Mexico_City')::date
              AND status = 'CLOSED'
              AND (discount_cents > 0 OR was_reopened = true OR edited_after_close = true)
            ORDER BY discount_cents DESC
            LIMIT 10
        """))
        return result.fetchall()

# ===== FIXED STAFF FUNCTION (DEFINED BEFORE THE HANDLER) =====
def get_staff_performance(target_date):
    with engine.connect() as conn:
        result = conn.execute(text("""
            WITH 
            opened AS (
                SELECT 
                    opened_by AS user_id,
                    COUNT(DISTINCT id) AS opened_count
                FROM tickets
                WHERE DATE(opened_at AT TIME ZONE 'America/Mexico_City') = :target_date
                  AND opened_by IS NOT NULL
                GROUP BY opened_by
            ),
            closed AS (
                SELECT 
                    closed_by AS user_id,
                    COUNT(DISTINCT id) AS closed_count,
                    COALESCE(SUM(total_cents) / 100.0, 0) AS sales_mxn,
                    COALESCE(SUM(tip_cents) / 100.0, 0) AS tips_mxn
                FROM tickets
                WHERE DATE(closed_at AT TIME ZONE 'America/Mexico_City') = :target_date
                  AND status = 'CLOSED'
                  AND closed_by IS NOT NULL
                GROUP BY closed_by
            )
            SELECT 
                u.name AS nombre,
                COALESCE(o.opened_count, 0) AS tickets_opened,
                COALESCE(c.closed_count, 0) AS tickets_closed,
                COALESCE(c.sales_mxn, 0) AS ventas_mxn,
                COALESCE(c.tips_mxn, 0) AS propinas_mxn
            FROM users u
            LEFT JOIN opened o ON u.id = o.user_id
            LEFT JOIN closed c ON u.id = c.user_id
            WHERE u.is_active = true
              AND (o.opened_count IS NOT NULL OR c.closed_count IS NOT NULL)
            ORDER BY ventas_mxn DESC, tickets_opened DESC
        """), {"target_date": target_date})
        return result.fetchall()



async def staff_performance(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    /staff - Today
    /staff yesterday - Yesterday
    /staff 2026-08-05 - Specific date
    /staff -10 - 10 days ago
    """
    target_date = datetime.now(BAR_TZ).date()
    date_label = "Today"

    if context.args:
        arg = context.args[0].lower()
        if arg == "yesterday":
            target_date = datetime.now(BAR_TZ).date() - timedelta(days=1)
            date_label = "Yesterday"
        elif arg.startswith("-") and arg[1:].isdigit():
            days_ago = int(arg[1:])
            target_date = datetime.now(BAR_TZ).date() - timedelta(days=days_ago)
            date_label = f"{days_ago} day{'s' if days_ago > 1 else ''} ago"
        elif len(arg) == 10 and arg[4] == '-' and arg[7] == '-':
            try:
                target_date = datetime.strptime(arg, "%Y-%m-%d").date()
                date_label = target_date.strftime("%b %d, %Y")
            except ValueError:
                await update.message.reply_text("❌ Invalid date format. Use YYYY-MM-DD.")
                return
        else:
            await update.message.reply_text(
                "❌ Invalid argument.\n"
                "Use: /staff (today)\n"
                "     /staff yesterday\n"
                "     /staff -10 (10 days ago)\n"
                "     /staff 2026-08-05 (specific date)"
            )
            return

    # Debug: log the parsed date
    logging.info(f"Staff query: date={target_date}, label={date_label}")

    try:
        rows = get_staff_performance(target_date)
        if not rows:
            await update.message.reply_text(
                f"👔 No staff activity found for {date_label}.\n"
                f"📅 Query date: {target_date.strftime('%Y-%m-%d')}"
            )
            return

        msg = f"👔 STAFF PERFORMANCE ({date_label})\n"
        msg += f"📅 Date: {target_date.strftime('%Y-%m-%d')}\n"
        msg += "━━━━━━━━━━━━━━━━━━━━━\n"
        for name, opened, closed, sales, tips in rows:
            msg += f"👤 {name}\n"
            msg += f"   📥 Opened: {opened} tickets\n"
            msg += f"   📤 Closed: {closed} tickets\n"
            msg += f"   💰 Sales: MXN {sales:,.2f}\n"
            msg += f"   💵 Tips:  MXN {tips:,.2f}\n\n"

        msg += f"📊 Total staff: {len(rows)}"
        await update.message.reply_text(msg)
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")


def get_hourly_sales():
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT 
                EXTRACT(HOUR FROM (closed_at AT TIME ZONE 'America/Mexico_City'))::int AS hora_mx,
                COUNT(DISTINCT t.id) AS tickets,
                COALESCE(SUM(tli.quantity * tli.unit_price_cents) / 100.0, 0) AS ventas_mxn
            FROM tickets t
            LEFT JOIN ticket_line_items tli ON t.id = tli.ticket_id
            WHERE DATE(closed_at AT TIME ZONE 'America/Mexico_City') = (now() AT TIME ZONE 'America/Mexico_City')::date
              AND t.status = 'CLOSED'
            GROUP BY hora_mx
            ORDER BY hora_mx
        """))
        return result.fetchall()

def get_product_profitability():
    with engine.connect() as conn:
        result = conn.execute(text("""
            WITH profit_data AS (
                SELECT 
                    producto,
                    unidades,
                    ventas_mxn,
                    utilidad_mxn,
                    margen_pct
                FROM v_bola8_utilidad_producto
                ORDER BY utilidad_mxn DESC
            )
            (SELECT * FROM profit_data LIMIT 5)
            UNION ALL
            (SELECT * FROM profit_data ORDER BY utilidad_mxn ASC LIMIT 5)
        """))
        return result.fetchall()

def get_weekly_executive():
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT 
                COUNT(id) AS tickets_cerrados,
                COALESCE(SUM(total_cents) / 100.0, 0) AS ventas_mxn,
                COALESCE(SUM(discount_cents) / 100.0, 0) AS descuentos_mxn,
                COALESCE(SUM(tip_cents) / 100.0, 0) AS propinas_mxn,
                COALESCE(AVG(total_cents) / 100.0, 0) AS ticket_promedio_mxn
            FROM tickets
            WHERE DATE(closed_at AT TIME ZONE 'America/Mexico_City') >= (now() AT TIME ZONE 'America/Mexico_City')::date - INTERVAL '6 days'
              AND DATE(closed_at AT TIME ZONE 'America/Mexico_City') <= (now() AT TIME ZONE 'America/Mexico_City')::date
              AND status = 'CLOSED'
        """))
        return result.fetchone()

# ===================== BOT COMMAND HANDLERS =====================

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "🤖 BilliardBar POS Bot\n\n"
        "📊 SALES:\n"
        "/daily - Today's sales summary\n"
        "/todaysales - Today's top 5 products\n"
        "/topsales - Top 5 products this week\n"
        "/topmonth - Top 5 products this month\n\n"
        "📦 INVENTORY:\n"
        "/stock <name> - Check inventory stock\n"
        "/stockall - Check full inventory stock\n"
        "/lowstock - List all low-stock items\n"
        "/recipe <menu_item> - Check if menu item can be made\n"
        "/compras - What to buy next week (also every Sunday 10:00)\n\n"
        "👔 MANAGEMENT:\n"
        "/executive - Today's executive KPIs\n"
        "/anomalies - Suspicious tickets today\n"
        "/staff [date] - Staff performance\n"
        "/staffdates - Show available dates\n"
        "/hourly - Sales by hour today\n"
        "/profit - Product profitability (top/bottom 5)\n\n"
        "🔧 OTHER:\n"
        "/report - Full admin daily report\n"
        "/tables - List all tables (debug)"
    )

async def daily_sales(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        data = fetch_daily_sales()
        revenue_mxn = data[0] / 100.0
        items = data[1]
        txns = data[2]
        if revenue_mxn > 0:
            msg = (f"📊 Today's Sales Summary\n"
                   f"💰 Revenue: MXN {revenue_mxn:,.2f}\n"
                   f"📦 Items Sold: {items}\n"
                   f"🧾 Transactions: {txns}")
        else:
            msg = "📭 No closed tickets found for today."
    except Exception as e:
        msg = f"❌ DB Error: {e}"
    await update.message.reply_text(msg)

async def top_sales_week(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        products = fetch_top_products(7)
        if not products:
            await update.message.reply_text("No sales data for the last 7 days.")
            return
        msg = "⭐ Top 5 Products This Week (by qty):\n"
        for idx, (name, qty, rev) in enumerate(products, 1):
            msg += f"{idx}. {name} - {qty} units (MXN {rev:,.2f})\n"
    except Exception as e:
        msg = f"❌ DB Error: {e}"
    await update.message.reply_text(msg)

async def top_sales_month(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        products = fetch_top_products(30)
        if not products:
            await update.message.reply_text("No sales data for the last 30 days.")
            return
        msg = "🌟 Top 5 Products This Month (by qty):\n"
        for idx, (name, qty, rev) in enumerate(products, 1):
            msg += f"{idx}. {name} - {qty} units (MXN {rev:,.2f})\n"
    except Exception as e:
        msg = f"❌ DB Error: {e}"
    await update.message.reply_text(msg)

async def today_top_sales(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        products = fetch_today_top_products(5)
        if not products:
            await update.message.reply_text("No sales data for today yet.")
            return
        msg = "🔥 Today's Top 5 Products (by qty):\n"
        for idx, (name, qty, rev) in enumerate(products, 1):
            msg += f"{idx}. {name} - {qty} units (MXN {rev:,.2f})\n"
        await update.message.reply_text(msg)
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")    

async def stock_check(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("Usage: /stock <product_name>")
        return
    search_term = " ".join(context.args)
    try:
        results = search_inventory_by_name(search_term)
        if not results:
            await update.message.reply_text(f"No active inventory items found matching '{search_term}'.")
            return
        msg = f"📦 Stock Results for '{search_term}':\n"
        for idx, (_, name, stock, threshold, unit) in enumerate(results, 1):
            stock = float(stock)
            threshold = float(threshold) if threshold is not None else None
            status = "✅ OK" if threshold is None or stock > threshold else "⚠️ LOW STOCK"
            threshold_str = f" (Min: {threshold:.2f})" if threshold is not None else ""
            msg += f"{idx}. {name} - {stock:.2f} {unit}{threshold_str} {status}\n"
        await update.message.reply_text(msg)
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")

async def low_stock_report(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        results = get_low_stock_items()
        if not results:
            await update.message.reply_text("✅ All active items are sufficiently stocked.")
            return
        msg = "⚠️ LOW STOCK ITEMS:\n"
        for _, name, stock, threshold, unit in results:
            stock = float(stock)
            threshold = float(threshold) if threshold is not None else 0
            msg += f"- {name}: {stock:.2f} / {threshold:.2f} {unit}\n"
        await update.message.reply_text(msg)
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")

async def recipe_check(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("Usage: /recipe <menu_item_name>")
        return
    menu_name = " ".join(context.args)
    try:
        menu = get_menu_item_by_name(menu_name)
        if not menu:
            await update.message.reply_text(f"No active menu item found matching '{menu_name}'.")
            return
        menu_id, menu_name_full = menu
        ingredients = get_recipe_ingredients(menu_id)
        if not ingredients:
            await update.message.reply_text(f"'{menu_name_full}' has no ingredients defined (or all ingredients are inactive).")
            return
        max_possible = None
        shortage_items = []
        lines = []
        for ing_name, needed, stock, unit, _ in ingredients:
            needed = float(needed)
            stock = float(stock)
            if stock < needed:
                shortage_items.append((ing_name, needed, stock))
                possible = 0
            else:
                possible = int(stock // needed)
            if max_possible is None or possible < max_possible:
                max_possible = possible
            status = "✅" if stock >= needed else "❌"
            lines.append(f"{status} {ing_name}: {stock:.2f} {unit} (needs {needed:.2f}) -> can make {possible}")
        msg = f"🍽️ RECIPE CHECK: {menu_name_full}\n"
        if shortage_items:
            msg += "❌ CANNOT MAKE: Missing ingredients\n"
            for ing, need, stock in shortage_items:
                msg += f"   - Need {need:.2f}, have {stock:.2f}\n"
        else:
            msg += f"🟢 You can make {max_possible} portions right now!\n"
        msg += "\n" + "\n".join(lines)
        await update.message.reply_text(msg)
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")

# ---------- MANAGEMENT COMMANDS ----------

async def executive_kpis(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        row = get_executive_kpis()
        if not row or row[1] == 0:
            await update.message.reply_text("No sales data available for today. (No closed tickets yet.)")
            return
        tickets, ventas, billar, descuentos, propinas, ticket_prom, venta_prom_diaria = row
        msg = (f"📊 EXECUTIVE DASHBOARD - Today\n"
               f"🧾 Closed Tickets: {tickets}\n"
               f"💰 Revenue: MXN {ventas:,.2f}\n"
               f"🎱 Pool Time: MXN {billar:,.2f}\n"
               f"📉 Discounts: MXN {descuentos:,.2f}\n"
               f"💵 Tips: MXN {propinas:,.2f}\n"
               f"📊 Avg Ticket: MXN {ticket_prom:,.2f}\n"
               f"📈 Avg Daily Sales: MXN {venta_prom_diaria:,.2f}")
        await update.message.reply_text(msg)
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")

async def anomalies_report(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        rows = get_anomalies()
        if not rows:
            await update.message.reply_text("No anomalies detected today. ✅")
            return
        msg = "⚠️ ANOMALIES TODAY (Top by discount):\n"
        for row in rows:
            ticket_id, closed_at, total, discount, reopened, edited = row
            reopened_str = "REOPENED" if reopened else "not reopened"
            edited_str = "EDITED" if edited else "not edited"
            msg += (f"- Ticket {ticket_id[:8]}: MXN {total:,.2f} total, "
                    f"discount MXN {discount:,.2f}, {reopened_str}, {edited_str}\n")
        await update.message.reply_text(msg)
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")

async def staff_performance(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    /staff - Today
    /staff yesterday - Yesterday
    /staff 2026-08-05 - Specific date
    /staff -10 - 10 days ago (supports any number)
    """
    target_date = datetime.now(BAR_TZ).date()
    date_label = "Today"

    if context.args:
        arg = context.args[0].lower()
        if arg == "yesterday":
            target_date = datetime.now(BAR_TZ).date() - timedelta(days=1)
            date_label = "Yesterday"
        elif arg.startswith("-") and arg[1:].isdigit():
            days_ago = int(arg[1:])
            target_date = datetime.now(BAR_TZ).date() - timedelta(days=days_ago)
            date_label = f"{days_ago} day{'s' if days_ago > 1 else ''} ago"
        elif len(arg) == 10 and arg[4] == '-' and arg[7] == '-':
            try:
                target_date = datetime.strptime(arg, "%Y-%m-%d").date()
                date_label = target_date.strftime("%b %d, %Y")
            except ValueError:
                await update.message.reply_text("❌ Invalid date. Use YYYY-MM-DD, 'yesterday', or a number like -5.")
                return
        else:
            await update.message.reply_text(
                "❌ Invalid argument.\n"
                "Use: /staff (today)\n"
                "     /staff yesterday\n"
                "     /staff -10 (10 days ago)\n"
                "     /staff 2026-08-05 (specific date)"
            )
            return

    try:
        rows = get_staff_performance(target_date)
        if not rows:
            await update.message.reply_text(
                f"👔 No staff activity found for {date_label}.\n"
                f"📅 Query date: {target_date.strftime('%Y-%m-%d')}"
            )
            return

        msg = f"👔 STAFF PERFORMANCE ({date_label})\n"
        msg += f"📅 Date: {target_date.strftime('%Y-%m-%d')}\n"
        msg += "━━━━━━━━━━━━━━━━━━━━━\n"
        for name, opened, closed, sales, tips in rows:
            msg += f"👤 {name}\n"
            msg += f"   📥 Opened: {opened} tickets\n"
            msg += f"   📤 Closed: {closed} tickets\n"
            msg += f"   💰 Sales: MXN {sales:,.2f}\n"
            msg += f"   💵 Tips:  MXN {tips:,.2f}\n\n"

        msg += f"📊 Total staff: {len(rows)}"
        await update.message.reply_text(msg)
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")

async def staff_dates(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        with engine.connect() as conn:
            result = conn.execute(text("""
                SELECT DISTINCT DATE(closed_at AT TIME ZONE 'America/Mexico_City') AS fecha
                FROM tickets
                WHERE status = 'CLOSED'
                  AND (closed_by IS NOT NULL OR opened_by IS NOT NULL)
                ORDER BY fecha DESC
            """))
            dates = [row[0].strftime("%Y-%m-%d") for row in result if row[0]]
        if not dates:
            await update.message.reply_text("No closed tickets found.")
            return
        msg = "📅 Dates with staff data:\n"
        for i, d in enumerate(dates, 1):
            msg += f"{i}. {d}\n"
        if len(msg) > 4000:
            msg = msg[:3900] + "\n... (and more)"
        await update.message.reply_text(msg)
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")

        
async def hourly_sales(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        rows = get_hourly_sales()
        if not rows:
            await update.message.reply_text("No hourly sales data for today.")
            return
        msg = "🕒 HOURLY SALES TODAY:\n"
        for hora, tickets, ventas in rows:
            msg += f"{hora:02d}:00 - {tickets} tickets, MXN {ventas:,.2f}\n"
        await update.message.reply_text(msg)
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")

async def product_profitability(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        rows = get_product_profitability()
        if not rows:
            await update.message.reply_text("No product profitability data available.")
            return
        top = rows[:5]
        bottom = rows[5:10]
        msg = "📈 TOP 5 MOST PROFITABLE PRODUCTS:\n"
        for producto, unidades, ventas, utilidad, margen in top:
            msg += f"- {producto}: {unidades} units, profit MXN {utilidad:,.2f} (margin {margen:.1f}%)\n"
        msg += "\n📉 BOTTOM 5 LEAST PROFITABLE:\n"
        for producto, unidades, ventas, utilidad, margen in bottom:
            msg += f"- {producto}: {unidades} units, profit MXN {utilidad:,.2f} (margin {margen:.1f}%)\n"
        await update.message.reply_text(msg)
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")

# ---------- OTHER COMMANDS ----------

async def list_tables(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        with engine.connect() as conn:
            result = conn.execute(text("""
                SELECT table_name 
                FROM information_schema.tables 
                WHERE table_schema = 'public'
                ORDER BY table_name
            """))
            tables = [row[0] for row in result]
            if tables:
                await update.message.reply_text("📋 Tables:\n" + "\n".join(tables))
            else:
                await update.message.reply_text("No tables found.")
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")

async def full_report(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if str(update.effective_user.id) != ADMIN_CHAT_ID:
        await update.message.reply_text("⛔ Unauthorized.")
        return
    try:
        daily = fetch_daily_sales()
        top = fetch_top_products(7)
        revenue_mxn = daily[0] / 100.0
        msg = f"📋 Full Daily Report\nRevenue: MXN {revenue_mxn:,.2f}\nItems: {daily[1]}\nTxns: {daily[2]}\n\nWeekly Stars:\n"
        for name, qty, rev in top:
            msg += f"- {name}: {qty} units (MXN {rev:,.2f})\n"
    except Exception as e:
        msg = f"❌ DB Error: {e}"
    await update.message.reply_text(msg)

# ===================== SCHEDULED JOBS =====================

async def send_auto_report(context: ContextTypes.DEFAULT_TYPE):
    try:
        data = fetch_daily_sales()
        top = fetch_top_products(7)
        revenue_mxn = data[0] / 100.0
        if revenue_mxn > 0:
            top_name = top[0][0] if top else "N/A"
            msg = (f"⏰ AUTO DAILY REPORT\n"
                   f"💰 Revenue: MXN {revenue_mxn:,.2f}\n"
                   f"📦 Items: {data[1]}\n"
                   f"⭐ Top item: {top_name}")
            await context.bot.send_message(chat_id=ADMIN_CHAT_ID, text=msg)
    except Exception as e:
        logging.error(f"Auto daily report failed: {e}")

async def send_weekly_report(context: ContextTypes.DEFAULT_TYPE):
    try:
        row = get_weekly_executive()
        if row and row[1] > 0:
            tickets, ventas, descuentos, propinas, ticket_prom = row
            msg = (f"📊 WEEKLY EXECUTIVE SUMMARY\n"
                   f"📅 Last 7 days\n"
                   f"🧾 Tickets: {tickets}\n"
                   f"💰 Revenue: MXN {ventas:,.2f}\n"
                   f"📉 Discounts: MXN {descuentos:,.2f}\n"
                   f"💵 Tips: MXN {propinas:,.2f}\n"
                   f"📊 Avg Ticket: MXN {ticket_prom:,.2f}")
            await context.bot.send_message(chat_id=ADMIN_CHAT_ID, text=msg)
        else:
            await context.bot.send_message(chat_id=ADMIN_CHAT_ID, text="⚠️ No weekly data available.")
    except Exception as e:
        logging.error(f"Auto weekly report failed: {e}")


# ===================== PURCHASE FORECAST (batch E3) =====================
# Reads v_purchase_forecast -- the same view the backend's Sunday email and the
# Reportes screen use -- and mirrors backend app/services/purchase_svc.py
# format_text(). Keep the two in step.

_MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
_ESTADOS = [('URGENTE', '🔴', 'Urgente — se acaba esta semana'),
            ('COMPRAR', '🟡', 'Comprar para la semana'),
            ('MINIMO', '⚪', 'Por tu mínimo de stock')]


def _q(v):
    v = float(v or 0)
    return f'{v:.0f}' if v == int(v) else f'{v:.1f}'


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


def _fecha(d):
    return f'{d.day} {_MESES[d.month - 1]}'


def fetch_purchase_forecast():
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT f.*, lower(COALESCE(bu.name_es, f.base_unit_key)) AS unidad,
                   lower(COALESCE(pu.name_es, 'paquete'))            AS unidad_compra
              FROM v_purchase_forecast f
              LEFT JOIN unit_catalog bu ON bu.key = f.base_unit_key
              LEFT JOIN unit_catalog pu ON pu.key = f.purchase_unit_key""")).mappings().all()
        sin_receta = []
        if conn.execute(text("SELECT to_regclass('public.v_menu_items_without_recipe') IS NOT NULL")).scalar():
            sin_receta = [r[0] for r in conn.execute(text("""
                SELECT name FROM v_menu_items_without_recipe
                 WHERE NOT COALESCE(has_modifier_coverage, FALSE) AND COALESCE(times_sold, 0) > 0
                 ORDER BY times_sold DESC LIMIT 5""")).all()]
        safety = conn.execute(text("SELECT value FROM settings WHERE key = 'purchasing.safety_pct'")).scalar()
    return rows, sin_receta, float(safety) if safety else 20.0


def format_purchase_forecast(rows, sin_receta, safety):
    today = datetime.now(BAR_TZ).date()
    lunes = today + timedelta(days=(7 - today.weekday()) % 7 or 7)
    out = [f"🛒 Compras — semana del {_fecha(lunes)} al {_fecha(lunes + timedelta(days=6))}"]
    if rows and rows[0]['datos_hasta']:
        hasta = rows[0]['datos_hasta'].astimezone(BAR_TZ).date()
        out.append(f"Según ventas del {_fecha(hasta - timedelta(days=27))} al {_fecha(hasta)} "
                   f"(4 semanas) + {safety:.0f}% de colchón")
    out.append('')
    buy = [r for r in rows if r['estado'] in ('URGENTE', 'COMPRAR', 'MINIMO')]
    if not buy:
        out.append('✅ Con lo que hay alcanza para la semana.')
    for est, icon, title in _ESTADOS:
        grp = [r for r in buy if r['estado'] == est]
        if not grp:
            continue
        out.append(f'{icon} {title}')
        for r in grp:
            qty = (f"{r['comprar_paquetes']} {_plural(r['unidad_compra'], r['comprar_paquetes'])} "
                   f"({_q(r['comprar_unidades'])} {_plural(r['unidad'], r['comprar_unidades'])})"
                   if r['comprar_paquetes'] else f"{_q(r['comprar_unidades'])} {_plural(r['unidad'], r['comprar_unidades'])}")
            extra = (f" · se venden ~{_q(r['pronostico_semana'])}/sem, hay {_q(r['disponible'])}"
                     if est != 'MINIMO' else f" · hay {_q(r['disponible'])}, mínimo {_q(r['minimo'])}")
            out.append(f"• {r['name']}: {qty}{extra}")
        out.append('')
    if buy:
        total = sum(int(r['costo_estimado_cents'] or 0) for r in buy)
        sin_costo = sum(1 for r in buy if not r['costo_estimado_cents'])
        out.append(f"💰 Costo estimado: ${total / 100:,.2f}" + (f" ({sin_costo} sin costo registrado)" if sin_costo else ''))
    if sin_receta:
        out.append(f"⚠️ Se venden sin receta (no cuentan aquí): {', '.join(sin_receta)}")
    revisar = [r['name'] for r in rows if float(r['semanal_4s'] or 0) > 0 and float(r['dias_cobertura'] or 0) > 365][:6]
    if revisar:
        out.append(f"🔎 Revisar receta o stock (duraría más de un año): {', '.join(revisar)}")
    msg = '\n'.join(out).strip()
    return msg if len(msg) <= 3800 else msg[:3760].rsplit('\n', 1)[0] + '\n… (ver Reportes → Inventario)'


async def purchase_forecast(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        await update.message.reply_text(format_purchase_forecast(*fetch_purchase_forecast()))
    except Exception as e:
        logging.error(f"/compras failed: {e}")
        await update.message.reply_text("⚠️ No se pudo calcular el pronóstico de compras.")


async def send_purchase_forecast(context: ContextTypes.DEFAULT_TYPE):
    try:
        await context.bot.send_message(chat_id=ADMIN_CHAT_ID,
                                       text=format_purchase_forecast(*fetch_purchase_forecast()))
    except Exception as e:
        logging.error(f"Weekly purchase forecast failed: {e}")

# ===================== MAIN =====================

def main():
    app = Application.builder().token(TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("daily", daily_sales))
    app.add_handler(CommandHandler("todaysales", today_top_sales))   # <-- ADD THIS LINE
    app.add_handler(CommandHandler("topsales", top_sales_week))
    app.add_handler(CommandHandler("topmonth", top_sales_month))
    app.add_handler(CommandHandler("stock", stock_check))
    app.add_handler(CommandHandler("stockall", stock_all))
    app.add_handler(CommandHandler("lowstock", low_stock_report))
    app.add_handler(CommandHandler("recipe", recipe_check))
    app.add_handler(CommandHandler("executive", executive_kpis))
    app.add_handler(CommandHandler("anomalies", anomalies_report))
    app.add_handler(CommandHandler("staff", staff_performance))
    app.add_handler(CommandHandler("staffdates", staff_dates))
    app.add_handler(CommandHandler("hourly", hourly_sales))
    app.add_handler(CommandHandler("profit", product_profitability))
    app.add_handler(CommandHandler("tables", list_tables))
    app.add_handler(CommandHandler("report", full_report))
    app.add_handler(CommandHandler("compras", purchase_forecast))

    # Bar time: without a timezone these fired in the container's UTC
    # (the 09:00 report went out at 03:00 in Mexico City).
    scheduler = AsyncIOScheduler(timezone=BAR_TZ)
    scheduler.add_job(send_auto_report, "cron", hour=9, minute=0, args=[app])
    scheduler.add_job(send_weekly_report, "cron", day_of_week="mon", hour=8, minute=0, args=[app])
    scheduler.add_job(send_purchase_forecast, "cron", day_of_week="sun",
                      hour=int(os.getenv('PURCHASE_FORECAST_HOUR', '10')), minute=0, args=[app])
    scheduler.start()

    logging.info("🤖 Telegram Bot is running...")
    app.run_polling()

if __name__ == "__main__":
    main()