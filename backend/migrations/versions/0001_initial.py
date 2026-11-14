"""Initial schema (v0.1–0.2): comparisons, candidates, tracks, community, jobs.

Revision ID: 0001
Revises:
"""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "comparisons",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("created_at", TS),
        sa.Column("status", sa.String(16)),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("survey", sa.String(32)),
        sa.Column("ra", sa.Float),
        sa.Column("dec", sa.Float),
        sa.Column("size_deg", sa.Float),
        sa.Column("detector", sa.Integer, nullable=True),
        sa.Column("product_a", sa.String(64)),
        sa.Column("product_b", sa.String(64)),
        sa.Column("t_a_mjd", sa.Float, nullable=True),
        sa.Column("t_b_mjd", sa.Float, nullable=True),
        sa.Column("pipeline_version", sa.String(64)),
        sa.Column("arrays_key", sa.String(256), nullable=True),
        sa.Column("provenance", sa.JSON),
        sa.Column("summary", sa.JSON),
    )
    op.create_table(
        "candidates",
        sa.Column("pk", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("id", sa.String(32), unique=True, index=True),
        sa.Column("comparison_id", sa.String(32), sa.ForeignKey("comparisons.id"), index=True),
        sa.Column("created_at", TS),
        sa.Column("ra", sa.Float, index=True),
        sa.Column("dec", sa.Float, index=True),
        sa.Column("sign", sa.Integer),
        sa.Column("peak_significance", sa.Float),
        sa.Column("quality_tier", sa.String(2)),
        sa.Column("rejected", sa.Boolean),
        sa.Column("machine_class", sa.String(48)),
        sa.Column("rank_in_comparison", sa.Integer),
        sa.Column("rank_explanation", sa.Text),
        sa.Column("measurements", sa.JSON),
        sa.Column("quality_checks", sa.JSON),
        sa.Column("verification_status", sa.String(24)),
        sa.Column("pipeline_version", sa.String(64)),
    )
    op.create_table(
        "tracks",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("created_at", TS),
        sa.Column("run_id", sa.String(32), index=True),
        sa.Column("kind", sa.String(32)),
        sa.Column("members", sa.JSON),
        sa.Column("metrics", sa.JSON),
        sa.Column("ra", sa.Float),
        sa.Column("dec", sa.Float),
        sa.Column("params", sa.JSON),
    )
    op.create_table(
        "annotations",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("created_at", TS),
        sa.Column("target_type", sa.String(16)),
        sa.Column("target_id", sa.String(64), index=True),
        sa.Column("author", sa.String(64)),
        sa.Column("kind", sa.String(24)),
        sa.Column("body", sa.Text),
        sa.Column("status", sa.String(16)),
    )
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("created_at", TS),
        sa.Column("target_type", sa.String(16)),
        sa.Column("target_id", sa.String(64), index=True),
        sa.Column("action", sa.String(32)),
        sa.Column("actor", sa.String(64)),
        sa.Column("detail", sa.JSON),
    )
    op.create_table(
        "jobs",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("kind", sa.String(32)),
        sa.Column("status", sa.String(16)),
        sa.Column("progress", sa.Float),
        sa.Column("message", sa.Text),
        sa.Column("params", sa.JSON),
        sa.Column("result", sa.JSON),
        sa.Column("created_at", TS),
        sa.Column("updated_at", TS),
    )


def downgrade() -> None:
    for t in ("jobs", "audit_events", "annotations", "tracks", "candidates", "comparisons"):
        op.drop_table(t)
