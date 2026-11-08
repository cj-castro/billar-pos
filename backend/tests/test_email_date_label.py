from datetime import date
from app.services.email_report_svc import _date_label


def test_date_label_single_digit_day():
    assert _date_label(date(2026, 11, 1)) == "1 de November de 2026"


def test_date_label_two_digit_day():
    assert _date_label(date(2026, 8, 15)) == "15 de August de 2026"
