import pytest

from app.services.ec2_database_power import EC2DatabasePowerBackend


class FakeClient:
    def __init__(self, state="running", instances=1):
        self.current_state = state
        self.instance_count = instances
        self.started = []
        self.stopped = []
        self.closed = False

    def describe_instances(self, *, InstanceIds):
        return {
            "Reservations": [
                {
                    "Instances": [
                        {"InstanceId": InstanceIds[0], "State": {"Name": self.current_state}}
                        for _ in range(self.instance_count)
                    ]
                }
            ]
        }

    def start_instances(self, *, InstanceIds):
        self.started.append(InstanceIds)

    def stop_instances(self, *, InstanceIds):
        self.stopped.append(InstanceIds)

    def close(self):
        self.closed = True


@pytest.mark.parametrize(
    ("provider_state", "expected"),
    [("pending", "starting"), ("running", "running"), ("stopping", "stopping"), ("stopped", "stopped")],
)
def test_maps_instance_states_to_controller_states(provider_state, expected):
    backend = EC2DatabasePowerBackend(instance_id="i-database", client=FakeClient(provider_state))

    assert backend.state() == expected


def test_start_stop_and_close_delegate_to_the_client():
    client = FakeClient()
    backend = EC2DatabasePowerBackend(instance_id="i-database", client=client)

    backend.start()
    backend.stop()
    backend.close()

    assert client.started == [["i-database"]]
    assert client.stopped == [["i-database"]]
    assert client.closed is True


@pytest.mark.parametrize("provider_state", ["shutting-down", "terminated", "unknown"])
def test_rejects_uncontrollable_states(provider_state):
    backend = EC2DatabasePowerBackend(instance_id="i-database", client=FakeClient(provider_state))

    with pytest.raises(RuntimeError):
        backend.state()


def test_requires_an_instance_id(monkeypatch):
    monkeypatch.delenv("DATABASE_POWER_INSTANCE_ID", raising=False)

    with pytest.raises(ValueError):
        EC2DatabasePowerBackend(client=FakeClient())
