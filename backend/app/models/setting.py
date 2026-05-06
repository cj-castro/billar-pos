from ..extensions import db


class Setting(db.Model):
    __tablename__ = 'settings'
    key   = db.Column(db.String(64), primary_key=True)
    value = db.Column(db.Text, nullable=False, default='')

    def to_dict(self):
        return {'key': self.key, 'value': self.value}
