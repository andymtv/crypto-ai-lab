"""Walk-forward model training.

A model run trains one model per walk-forward fold and keeps only the
out-of-fold (OOF) predictions: every prediction was made by a model that
never saw that period. Backtests run on these OOF predictions only. A final
model is also fitted on the most recent window for later use.

Models:
- lgbm: LightGBM gradient-boosted trees (main model).
- logreg: standardized logistic regression (linear baseline).
"""

from __future__ import annotations

import json
import shutil
import time
from typing import Any

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .. import db
from ..config import MODELS_DIR, THREADS
from ..features.build import build_features, features_are_current, load_features, load_features_meta
from ..labels.triple_barrier import ensure_labels, normalize_label_config
from .walkforward import Fold, make_folds

MODEL_TYPES = ("lgbm", "logreg")
FEE_PCT_DEFAULT = 0.1
LOGREG_MAX_ROWS = 300_000
MONTH_SECONDS = 31 * 86400


class SubProgress:
    """Maps a sub-task's 0..1 progress into a slice of the job's progress."""

    def __init__(self, ctx, base: float, span: float) -> None:
        self.ctx, self.base, self.span = ctx, base, span

    def progress(self, fraction: float, message: str | None = None, force: bool = False) -> None:
        self.ctx.progress(self.base + self.span * fraction, message, force)


def normalize_params(params: dict[str, Any]) -> dict[str, Any]:
    walk = params.get("walk_forward") or {}
    model_type = params.get("model_type", "lgbm")
    if model_type not in MODEL_TYPES:
        raise ValueError(f"model_type must be one of {MODEL_TYPES}")
    return {
        "name": params.get("name") or f"{model_type} {time.strftime('%Y-%m-%d %H:%M')}",
        "model_type": model_type,
        "label": normalize_label_config(params.get("label") or {}),
        "walk_forward": {
            "train_months": int(walk.get("train_months", 24)),
            "test_months": int(walk.get("test_months", 3)),
            "min_train_months": int(walk.get("min_train_months", 12)),
            "window": walk.get("window", "rolling"),
        },
        "train_stride_minutes": int(params.get("train_stride_minutes", 5)),
        "include_btc": bool(params.get("include_btc", True)),
        "fee_pct": float(params.get("fee_pct", FEE_PCT_DEFAULT)),
        "lgbm": {
            "num_leaves": int((params.get("lgbm") or {}).get("num_leaves", 31)),
            "learning_rate": float((params.get("lgbm") or {}).get("learning_rate", 0.03)),
            "min_data_in_leaf": int((params.get("lgbm") or {}).get("min_data_in_leaf", 400)),
            "feature_fraction": float((params.get("lgbm") or {}).get("feature_fraction", 0.7)),
            "max_rounds": int((params.get("lgbm") or {}).get("max_rounds", 2000)),
        },
    }


def run_dir(run_id: str):
    return MODELS_DIR / run_id


def create_model_run(params: dict[str, Any]) -> dict[str, Any]:
    normalized = normalize_params(params)
    run_id = db.new_id()
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO model_runs (id, name, status, params, created_at) VALUES (?, ?, 'queued', ?, ?)",
            (run_id, normalized["name"], json.dumps(normalized), db.now()),
        )
    return get_model_run(run_id)  # type: ignore[return-value]


def attach_job(run_id: str, job_id: str) -> None:
    with db.connect() as conn:
        conn.execute("UPDATE model_runs SET job_id = ? WHERE id = ?", (job_id, run_id))


def _set_status(run_id: str, status: str, metrics: dict[str, Any] | None = None) -> None:
    with db.connect() as conn:
        if metrics is None:
            conn.execute("UPDATE model_runs SET status = ? WHERE id = ?", (status, run_id))
        else:
            conn.execute("UPDATE model_runs SET status = ?, metrics = ? WHERE id = ?", (status, json.dumps(metrics), run_id))


def get_model_run(run_id: str) -> dict[str, Any] | None:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM model_runs WHERE id = ?", (run_id,)).fetchone()
    return db.row_to_dict(row, ("params", "metrics"))


def list_model_runs() -> list[dict[str, Any]]:
    with db.connect() as conn:
        rows = conn.execute("SELECT * FROM model_runs ORDER BY created_at DESC").fetchall()
    return [db.row_to_dict(row, ("params", "metrics")) for row in rows]  # type: ignore[misc]


def delete_model_run(run_id: str) -> bool:
    with db.connect() as conn:
        deleted = conn.execute("DELETE FROM model_runs WHERE id = ?", (run_id,)).rowcount
    shutil.rmtree(run_dir(run_id), ignore_errors=True)
    return deleted > 0


def read_run_file(run_id: str, name: str) -> Any:
    path = run_dir(run_id) / name
    return json.loads(path.read_text()) if path.exists() else None


def load_oof(run_id: str) -> pd.DataFrame:
    return pq.read_table(run_dir(run_id) / "oof.parquet").to_pandas()


def _select_columns(all_columns: list[str], include_btc: bool) -> list[str]:
    if include_btc:
        return list(all_columns)
    return [column for column in all_columns if not column.startswith(("btc_", "x_"))]


def _load_rows(
    columns: list[str],
    labels: pd.DataFrame,
    start_ts: int,
    end_ts: int,
    stride_minutes: int,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Valid, labelled rows in [start_ts, end_ts), month by month to bound memory."""
    parts = []
    for chunk_start in range(start_ts, end_ts, MONTH_SECONDS):
        chunk_end = min(chunk_start + MONTH_SECONDS, end_ts)
        frame = load_features(columns, chunk_start, chunk_end)
        if stride_minutes > 1:
            frame = frame[(frame["ts"] // 60) % stride_minutes == 0]
        frame = frame[frame["valid"]]
        parts.append(frame)
    rows = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=["ts", *columns])
    merged = rows.merge(labels, on="ts", how="inner")
    merged = merged[merged["label"].notna()].reset_index(drop=True)
    return merged[columns], merged[["ts", "label", "outcome", "exit_return", "exit_seconds"]]


def _fit(model_type: str, params: dict[str, Any], x_train, y_train, x_valid, y_valid, rounds: int | None = None):
    if model_type == "logreg":
        if len(x_train) > LOGREG_MAX_ROWS:
            sample = np.random.default_rng(0).choice(len(x_train), LOGREG_MAX_ROWS, replace=False)
            x_train, y_train = x_train.iloc[sample], y_train[sample]
        model = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=0.05, max_iter=1000))
        model.fit(x_train, y_train)
        return model, None

    config = params["lgbm"]
    lgb_params = {
        "objective": "binary",
        "metric": "binary_logloss",
        "learning_rate": config["learning_rate"],
        "num_leaves": config["num_leaves"],
        "min_data_in_leaf": config["min_data_in_leaf"],
        "feature_fraction": config["feature_fraction"],
        "bagging_fraction": 0.7,
        "bagging_freq": 1,
        "lambda_l2": 5.0,
        "verbosity": -1,
        "num_threads": THREADS,
        "seed": 7,
    }
    train_set = lgb.Dataset(x_train, label=y_train, free_raw_data=True)
    if rounds is not None:
        return lgb.train(lgb_params, train_set, num_boost_round=rounds), rounds
    valid_set = lgb.Dataset(x_valid, label=y_valid, reference=train_set)
    booster = lgb.train(
        lgb_params,
        train_set,
        num_boost_round=config["max_rounds"],
        valid_sets=[valid_set],
        callbacks=[lgb.early_stopping(100, verbose=False)],
    )
    return booster, int(booster.best_iteration or booster.current_iteration())


def _predict(model_type: str, model, x) -> np.ndarray:
    if model_type == "logreg":
        return model.predict_proba(x)[:, 1].astype(np.float32)
    return model.predict(x, num_iteration=model.best_iteration or None).astype(np.float32)


def _importance(model_type: str, model, columns: list[str]) -> np.ndarray:
    if model_type == "logreg":
        values = np.abs(model[-1].coef_[0])
    else:
        values = model.feature_importance(importance_type="gain").astype(np.float64)
    total = values.sum()
    return values / total if total > 0 else values


def classification_metrics(y: np.ndarray, p: np.ndarray, base_rate: float) -> dict[str, float | None]:
    if len(y) == 0:
        return {"n": 0}
    p = np.clip(p, 1e-6, 1 - 1e-6)
    both_classes = 0 < y.sum() < len(y)
    baseline = np.full_like(p, np.clip(base_rate, 1e-6, 1 - 1e-6))
    model_loss = float(log_loss(y, p, labels=[0, 1]))
    base_loss = float(log_loss(y, baseline, labels=[0, 1]))
    return {
        "n": int(len(y)),
        "base_rate": float(y.mean()),
        "auc": float(roc_auc_score(y, p)) if both_classes else None,
        "logloss": model_loss,
        "logloss_baseline": base_loss,
        "logloss_skill": float(1 - model_loss / base_loss) if base_loss > 0 else None,
        "brier": float(brier_score_loss(y, p)),
    }


def threshold_table(oof: pd.DataFrame, fee_pct: float) -> list[dict[str, float]]:
    """For each probability threshold: how often it fires and what the trades earned."""
    rows = []
    round_trip = 2 * fee_pct / 100
    for threshold in np.round(np.arange(0.30, 0.86, 0.05), 2):
        selected = oof[oof["prob"] >= threshold]
        if len(selected) == 0:
            rows.append({"threshold": float(threshold), "share": 0.0, "n": 0, "hit_rate": None, "mean_net_return_pct": None})
            continue
        rows.append(
            {
                "threshold": float(threshold),
                "share": float(len(selected) / len(oof)),
                "n": int(len(selected)),
                "hit_rate": float(selected["label"].mean()),
                "mean_net_return_pct": float((selected["exit_return"].mean() - round_trip) * 100),
            }
        )
    return rows


def calibration_bins(oof: pd.DataFrame, bins: int = 10) -> list[dict[str, float]]:
    quantiles = np.unique(np.quantile(oof["prob"], np.linspace(0, 1, bins + 1)))
    groups = pd.cut(oof["prob"], quantiles, include_lowest=True)
    table = oof.groupby(groups, observed=True).agg(mean_prob=("prob", "mean"), hit_rate=("label", "mean"), n=("label", "size"))
    return [
        {"mean_prob": float(row.mean_prob), "hit_rate": float(row.hit_rate), "n": int(row.n)}
        for row in table.itertuples()
    ]


def probability_histogram(oof: pd.DataFrame, bins: int = 40) -> list[dict[str, float]]:
    counts, edges = np.histogram(oof["prob"], bins=bins, range=(0, 1))
    return [{"from": float(edges[i]), "to": float(edges[i + 1]), "count": int(counts[i])} for i in range(bins)]


def train_model_run(job_params: dict[str, Any], ctx) -> dict[str, Any]:
    run_id = job_params["run_id"]
    run = get_model_run(run_id)
    if run is None:
        raise ValueError(f"Model run {run_id} not found")
    params = run["params"]
    _set_status(run_id, "running")
    out_dir = run_dir(run_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    started = time.time()

    try:
        if not features_are_current():
            build_features({}, SubProgress(ctx, 0.0, 0.2))
        meta = load_features_meta()
        assert meta is not None
        columns = _select_columns(meta["columns"], params["include_btc"])

        ctx.progress(0.2, "Preparing labels", force=True)
        feature_ts = load_features([], None, None)["ts"].to_numpy()
        labels = ensure_labels(feature_ts, params["label"], SubProgress(ctx, 0.2, 0.1))
        labels = labels[["ts", "label", "outcome", "exit_return", "exit_seconds"]]

        label = params["label"]
        purge = label["horizon_minutes"] * 60 + label["latency_seconds"] + 120
        walk = params["walk_forward"]
        folds = make_folds(
            meta["first_ts"],
            meta["last_ts"],
            train_months=walk["train_months"],
            test_months=walk["test_months"],
            min_train_months=walk["min_train_months"],
            window=walk["window"],
            purge_seconds=purge,
        )
        if not folds:
            raise ValueError("Not enough history for a single walk-forward fold.")

        fold_reports: list[dict[str, Any]] = []
        oof_parts: list[pd.DataFrame] = []
        importance = np.zeros(len(columns))
        best_rounds: list[int] = []
        model_type = params["model_type"]

        for fold in folds:
            base = 0.3 + 0.6 * fold.index / len(folds)
            ctx.progress(base, f"Fold {fold.index + 1}/{len(folds)}: loading training rows", force=True)
            x_train, y_train = _load_rows(columns, labels, fold.train_start, fold.train_end, params["train_stride_minutes"])
            x_valid, y_valid = _load_rows(columns, labels, fold.valid_start, fold.valid_end, params["train_stride_minutes"])
            if len(x_train) < 1000 or len(x_valid) < 100:
                continue

            ctx.progress(base + 0.2 / len(folds), f"Fold {fold.index + 1}/{len(folds)}: training on {len(x_train):,} rows")
            model, rounds = _fit(
                model_type, params, x_train, y_train["label"].to_numpy(), x_valid, y_valid["label"].to_numpy()
            )
            if rounds:
                best_rounds.append(rounds)
            importance += _importance(model_type, model, columns)
            train_rate = float(y_train["label"].mean())
            del x_train, x_valid

            ctx.progress(base + 0.45 / len(folds), f"Fold {fold.index + 1}/{len(folds)}: predicting the test window")
            x_test, y_test = _load_rows(columns, labels, fold.test_start, fold.test_end, 1)
            if len(x_test) == 0:
                continue
            probability = _predict(model_type, model, x_test)
            del x_test
            part = y_test.assign(prob=probability, fold=fold.index)
            oof_parts.append(part)

            report = {
                **fold.to_dict(),
                "train_rows": int(len(y_train)),
                "train_base_rate": train_rate,
                "best_rounds": rounds,
                **classification_metrics(part["label"].to_numpy(), probability, train_rate),
            }
            top = part[part["prob"] >= part["prob"].quantile(0.9)]
            report["top_decile_hit_rate"] = float(top["label"].mean())
            report["top_decile_net_return_pct"] = float((top["exit_return"].mean() - 2 * params["fee_pct"] / 100) * 100)
            fold_reports.append(report)
            ctx.log(f"Fold {fold.index + 1}: AUC={report.get('auc')} skill={report.get('logloss_skill')}")

        if not oof_parts:
            raise ValueError("No fold produced predictions (too little labelled data?).")

        oof = pd.concat(oof_parts, ignore_index=True).sort_values("ts").reset_index(drop=True)
        pq.write_table(pa.Table.from_pandas(oof, preserve_index=False), out_dir / "oof.parquet", compression="zstd")

        ctx.progress(0.92, "Fitting the final model on the most recent window", force=True)
        last_fold = folds[-1]
        final_start = max(meta["first_ts"], last_fold.test_end - walk["train_months"] * MONTH_SECONDS)
        x_final, y_final = _load_rows(columns, labels, final_start, last_fold.test_end, params["train_stride_minutes"])
        final_rounds = int(np.median(best_rounds)) if best_rounds else None
        final_model, _ = _fit(model_type, params, x_final, y_final["label"].to_numpy(), None, None, rounds=final_rounds)
        if model_type == "lgbm":
            final_model.save_model(str(out_dir / "model_final.txt"))
        else:
            joblib.dump(final_model, out_dir / "model_final.joblib")
        del x_final

        importance /= max(1, len(fold_reports))
        order = np.argsort(importance)[::-1]
        importance_rows = [{"feature": columns[i], "importance": float(importance[i])} for i in order]

        overall_train_rate = float(np.mean([fold["train_base_rate"] for fold in fold_reports]))
        overall = classification_metrics(oof["label"].to_numpy(), oof["prob"].to_numpy(), overall_train_rate)
        top = oof[oof["prob"] >= oof["prob"].quantile(0.9)]
        overall["top_decile_hit_rate"] = float(top["label"].mean())
        overall["top_decile_net_return_pct"] = float((top["exit_return"].mean() - 2 * params["fee_pct"] / 100) * 100)
        overall["mean_net_return_all_pct"] = float((oof["exit_return"].mean() - 2 * params["fee_pct"] / 100) * 100)

        metrics = {
            "overall": overall,
            "oof_start": int(oof["ts"].iloc[0]),
            "oof_end": int(oof["ts"].iloc[-1]),
            "folds": len(fold_reports),
            "features": len(columns),
            "train_seconds": round(time.time() - started, 1),
        }
        (out_dir / "folds.json").write_text(json.dumps(fold_reports))
        (out_dir / "importance.json").write_text(json.dumps(importance_rows))
        (out_dir / "columns.json").write_text(json.dumps(columns))
        (out_dir / "calibration.json").write_text(json.dumps(calibration_bins(oof)))
        (out_dir / "histogram.json").write_text(json.dumps(probability_histogram(oof)))
        (out_dir / "thresholds.json").write_text(json.dumps(threshold_table(oof, params["fee_pct"])))
        _set_status(run_id, "done", metrics)
        return {"run_id": run_id, **metrics}
    except BaseException:
        _set_status(run_id, "failed")
        raise
