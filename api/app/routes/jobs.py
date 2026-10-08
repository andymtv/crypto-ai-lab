from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import jobs

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("")
def list_jobs(limit: int = 50):
    return jobs.list_jobs(limit)


@router.get("/{job_id}")
def get_job(job_id: str):
    job = jobs.get_job(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return job


@router.get("/{job_id}/log")
def get_log(job_id: str, tail: int = 200):
    return {"lines": jobs.read_log(job_id, tail)}


@router.post("/{job_id}/cancel")
def cancel(job_id: str):
    job = jobs.cancel_job(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return job
