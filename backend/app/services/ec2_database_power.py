from __future__ import annotations

import os
from typing import Any

import boto3

STATE_MAP = {
    "pending": "starting",
    "running": "running",
    "stopping": "stopping",
    "stopped": "stopped",
}


class EC2DatabasePowerBackend:
    def __init__(
        self,
        *,
        instance_id: str | None = None,
        region_name: str | None = None,
        client: Any | None = None,
    ):
        self.instance_id = instance_id or os.getenv("DATABASE_POWER_INSTANCE_ID", "").strip()
        if not self.instance_id:
            raise ValueError("DATABASE_POWER_INSTANCE_ID must be set")
        selected_region = region_name or os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
        self.client = client or boto3.client("ec2", region_name=selected_region)

    def state(self) -> str:
        response = self.client.describe_instances(InstanceIds=[self.instance_id])
        instances = [
            instance
            for reservation in response.get("Reservations", [])
            for instance in reservation.get("Instances", [])
        ]
        if len(instances) != 1:
            raise RuntimeError("Database instance could not be resolved uniquely")
        provider_state = str(instances[0].get("State", {}).get("Name", "")).lower()
        state = STATE_MAP.get(provider_state)
        if state is None:
            raise RuntimeError("Database instance is not in a controllable state")
        return state

    def start(self) -> None:
        self.client.start_instances(InstanceIds=[self.instance_id])

    def stop(self) -> None:
        self.client.stop_instances(InstanceIds=[self.instance_id])

    def close(self) -> None:
        close = getattr(self.client, "close", None)
        if callable(close):
            close()
