"""Research platform: spectrophotometry, counterparts, investigations, watchlists.

Revision ID: 0002
Revises: 0001
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "photometry_runs",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("created_at", TS),
        sa.Column("status", sa.String(16)),
        sa.Column("ra", sa.Float, index=True),
        sa.Column("dec", sa.Float, index=True),
        sa.Column("label", sa.String(128), nullable=True),
        sa.Column("candidate_id", sa.String(32), nullable=True, index=True),
        sa.Column("params", sa.JSON),
        sa.Column("provenance", sa.JSON),
        sa.Column("n_points", sa.Integer),
        sa.Column("error", sa.Text, nullable=True),
    )
    op.create_table(
        "photometry_points",
        sa.Column("pk", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("run_id", sa.String(32), sa.ForeignKey("photometry_runs.id"), index=True),
        sa.Column("product_id", sa.String(64)),
        sa.Column("obs_id", sa.String(64)),
        sa.Column("detector", sa.Integer, nullable=True),
        sa.Column("channel", sa.Integer, nullable=True, index=True),
        sa.Column("subchannel", sa.Integer, nullable=True),
        sa.Column("t_mid_mjd", sa.Float),
        sa.Column("wave_um", sa.Float, nullable=True),
        sa.Column("bandwidth_um", sa.Float, nullable=True),
        sa.Column("flux_ujy", sa.Float, nullable=True),
        sa.Column("flux_err_ujy", sa.Float, nullable=True),
        sa.Column("aperture_correction", sa.Float, nullable=True),
        sa.Column("flux_pointsource_ujy", sa.Float, nullable=True),
        sa.Column("flux_pointsource_err_ujy", sa.Float, nullable=True),
        sa.Column("masked_fraction", sa.Float, nullable=True),
        sa.Column("status", sa.String(16)),
        sa.Column("quality", sa.String(16), nullable=True),
        sa.Column("message", sa.Text, nullable=True),
        sa.Column("access_url", sa.Text, nullable=True),
        sa.Column("extra", sa.JSON),
    )
    op.create_table(
        "counterpart_assessments",
        sa.Column("pk", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("candidate_id", sa.String(32), index=True),
        sa.Column("created_at", TS),
        sa.Column("radius_arcsec", sa.Float),
        sa.Column("candidate_err_arcsec", sa.Float),
        sa.Column("association", sa.String(24)),
        sa.Column("catalogs", sa.JSON),
    )
    op.create_table(
        "investigations",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("created_at", TS),
        sa.Column("updated_at", TS),
        sa.Column("title", sa.String(200)),
        sa.Column("description", sa.Text),
        sa.Column("owner", sa.String(64)),
        sa.Column("ra", sa.Float, nullable=True),
        sa.Column("dec", sa.Float, nullable=True),
        sa.Column("radius_deg", sa.Float, nullable=True),
        sa.Column("notes", sa.Text),
        sa.Column("references", sa.JSON),
    )
    op.create_table(
        "investigation_items",
        sa.Column("pk", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("investigation_id", sa.String(32), sa.ForeignKey("investigations.id"), index=True),
        sa.Column("added_at", TS),
        sa.Column("kind", sa.String(24)),
        sa.Column("ref_id", sa.String(128)),
        sa.Column("label", sa.String(200)),
        sa.Column("note", sa.Text),
        sa.Column("payload", sa.JSON),
    )
    op.create_table(
        "watchlist_entries",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("created_at", TS),
        sa.Column("kind", sa.String(24)),
        sa.Column("label", sa.String(200)),
        sa.Column("ref_id", sa.String(64), nullable=True),
        sa.Column("ra", sa.Float),
        sa.Column("dec", sa.Float),
        sa.Column("radius_deg", sa.Float),
        sa.Column("known_products", sa.JSON),
        sa.Column("last_checked_at", TS, nullable=True),
        sa.Column("last_new_count", sa.Integer),
    )
    op.create_table(
        "watch_checks",
        sa.Column("pk", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("entry_id", sa.String(32), sa.ForeignKey("watchlist_entries.id"), index=True),
        sa.Column("checked_at", TS),
        sa.Column("status", sa.String(16)),
        sa.Column("n_products", sa.Integer),
        sa.Column("new_products", sa.JSON),
        sa.Column("message", sa.Text),
    )


def downgrade() -> None:
    for t in (
        "watch_checks",
        "watchlist_entries",
        "investigation_items",
        "investigations",
        "counterpart_assessments",
        "photometry_points",
        "photometry_runs",
    ):
        op.drop_table(t)
